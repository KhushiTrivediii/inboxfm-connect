import { ActivepiecesError, ApId, assertNotNullOrUndefined, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { ALL_PRINCIPAL_TYPES, EnginePrincipal, FileCompression, FileTransportQueryParams, FileType, Principal, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { accessTokenManager } from '../authentication/lib/access-token-manager'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { AppSystemProp } from '../helper/system/system-props'
import { fileService } from './file.service'
import { ENGINE_WRITABLE_FILE_TYPES, filesService, fileTransportHeaders } from './files-service'
import { signedFileTransport } from './signed-file-transport'

export const filesController: FastifyPluginAsyncZod = async (app) => {
    app.put('/:fileId', {
        config: {
            security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
        },
        schema: {
            params: z.object({ fileId: ApId }),
            querystring: FileTransportQueryParams,
            body: z.unknown(),
        },
        onRequest: async (request, reply) => {
            const fileId = (request.params as { fileId: string }).fileId
            const token = (request.query as { token: string }).token
            const principal = await verifyEnginePrincipal(token, request.log)
            const { projectId, platform } = principal
            // Fail closed on a malformed engine token: the ownership predicate is
            // only sound when the principal's scope is fully resolved, so an engine
            // token without a project/platform is a hard error, never a silent
            // undefined scope.
            assertNotNullOrUndefined(projectId, 'projectId')
            assertNotNullOrUndefined(platform, 'platform')
            const fileType = parseFileTypeHeader(request.headers[fileTransportHeaders.TYPE])
            const fileName = parseStringHeader(request.headers[fileTransportHeaders.NAME])
            const contentEncoding = parseStringHeader(request.headers['content-encoding'])
            const compression = contentEncoding === 'zstd' ? FileCompression.ZSTD : FileCompression.NONE
            const contentLength = Number(request.headers['content-length'] ?? 0)

            // DB storage: the single claim+write happens in the route handler below,
            // where an ownership rejection (403) reaches the client as a proper
            // ActivepiecesError body. Nothing to do this early.
            if (!signedFileTransport.shouldRedirectForType(fileType)) {
                return
            }

            // S3 signed-URL mode: the engine client uploads the bytes to S3 right
            // after this redirect, so the row must be claimed before the redirect.
            // The ownership predicate lives in the write itself (see saveEngineOwned):
            // this claim may only create the row or rewrite a row already inside the
            // principal's scope, so a foreign row can neither be re-owned nor leak its
            // read URL — the claim runs before the read-URL is minted.
            const file = await fileService(request.log).saveEngineOwned({
                fileId,
                projectId,
                platformId: platform.id,
                type: fileType,
                fileName,
                compression,
                size: contentLength,
                data: null,
            })

            const readUrl = await filesService.constructReadUrl({
                fileId,
                fileType,
                platformId: platform.id,
            })
            void reply.header(fileTransportHeaders.READ_URL, readUrl)

            const redirected = await signedFileTransport.maybeRedirectToS3Put({
                reply,
                log: request.log,
                file,
                contentEncoding: compression === FileCompression.ZSTD ? 'zstd' : undefined,
            })
            if (!redirected) {
                throw new ActivepiecesError({
                    code: ErrorCode.SYSTEM_PROP_INVALID,
                    params: {
                        prop: AppSystemProp.S3_USE_SIGNED_URLS,
                    },
                }, 'S3 signed-URL redirect expected but the file row was not eligible (location or s3Key missing). Aborting to avoid a double save.')
            }
        },
    }, async (request, reply) => {
        const { fileId } = request.params
        const principal = await verifyEnginePrincipal(request.query.token, request.log)
        const { projectId, platform } = principal
        // Fail closed on a malformed engine token (see the onRequest branch).
        assertNotNullOrUndefined(projectId, 'projectId')
        assertNotNullOrUndefined(platform, 'platform')
        const fileType = parseFileTypeHeader(request.headers[fileTransportHeaders.TYPE])
        const fileName = parseStringHeader(request.headers[fileTransportHeaders.NAME])
        const contentEncoding = parseStringHeader(request.headers['content-encoding'])
        const compression = contentEncoding === 'zstd' ? FileCompression.ZSTD : FileCompression.NONE

        const data = request.body as Buffer
        assertNotNullOrUndefined(data, 'body')
        const savedFile = await fileService(request.log).saveEngineOwned({
            fileId,
            projectId,
            platformId: platform.id,
            type: fileType,
            fileName,
            compression,
            size: data.length,
            data,
        })
        const readUrl = await filesService.constructReadUrl({
            fileId: savedFile.id,
            fileType,
            platformId: platform.id,
        })
        // The transport contract mirrors the S3-redirect branch: the read-URL header
        // is only minted after the ownership claim, so a rejected PUT never leaks a
        // read capability for a row the caller does not own.
        void reply.header(fileTransportHeaders.READ_URL, readUrl)
        return reply.status(StatusCodes.OK).send({ fileId, readUrl })
    })

    app.get('/:fileId', {
        config: {
            security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
        },
        schema: {
            params: z.object({ fileId: ApId }),
            querystring: FileTransportQueryParams,
        },
    }, async (request, reply) => {
        const { fileId } = request.params
        const { token } = request.query
        const projectId = await authorizeRead({ token, fileId, log: request.log })
        const file = await fileService(request.log).getFileOrThrow({ fileId, projectId })
        const redirected = await signedFileTransport.maybeRedirectToS3Get({
            reply,
            log: request.log,
            file,
        })
        if (redirected) {
            return
        }
        const { data } = await fileService(request.log).getDataOrThrow({
            fileId: file.id,
            projectId: file.projectId ?? undefined,
            type: file.type,
        })
        const mimeType = file.metadata?.mimetype ?? 'application/octet-stream'
        const disposition = isInlineSafeMimeType(mimeType) ? 'inline' : 'attachment'
        return reply
            .type(mimeType)
            .header('X-Content-Type-Options', 'nosniff')
            .header('Content-Disposition', `${disposition}; filename="${encodeURI(file.fileName ?? `${file.id}.bin`)}"`)
            .status(StatusCodes.OK)
            .send(data)
    })
}

export const signedStepFileController: FastifyPluginAsyncZod = async (app) => {
    app.get('/signed', {
        config: {
            security: securityAccess.public(),
        },
        schema: {
            querystring: z.object({ token: z.string() }),
        },
    }, async (request, reply) => {
        const file = await fileService(request.log).getFileByToken(request.query.token)
        const readUrl = await filesService.constructReadUrl({
            fileId: file.id,
            fileType: file.type,
            platformId: file.platformId,
        })
        return reply.redirect(readUrl)
    })
}

const INLINE_SAFE_MIME_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
    'application/pdf', 'text/plain',
])

function isInlineSafeMimeType(mimeType: string): boolean {
    return INLINE_SAFE_MIME_TYPES.has(mimeType.split(';')[0].trim().toLowerCase())
}

type AuthorizeReadParams = {
    token: string
    fileId: string
    log: import('fastify').FastifyBaseLogger
}

async function authorizeRead({ token, fileId, log }: AuthorizeReadParams): Promise<string | undefined> {
    const readToken = await tryVerifyReadToken(token, fileId)
    if (readToken) {
        return undefined
    }
    const principal = await tryVerifyEnginePrincipal(token, log)
    if (principal) {
        return principal.projectId
    }
    throw new ActivepiecesError({
        code: ErrorCode.INVALID_BEARER_TOKEN,
        params: { message: 'invalid token or expired for the file' },
    })
}

async function verifyEnginePrincipal(token: string, log: import('fastify').FastifyBaseLogger): Promise<EnginePrincipal> {
    const principal = await tryVerifyEnginePrincipal(token, log)
    if (!principal) {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_BEARER_TOKEN,
            params: { message: 'invalid engine token' },
        })
    }
    return principal
}

async function tryVerifyEnginePrincipal(token: string, log: import('fastify').FastifyBaseLogger): Promise<EnginePrincipal | null> {
    try {
        const principal: Principal = await accessTokenManager(log).verifyPrincipal(token)
        if (principal.type !== PrincipalType.ENGINE) {
            return null
        }
        return principal as EnginePrincipal
    }
    catch {
        return null
    }
}

async function tryVerifyReadToken(token: string, expectedFileId: string) {
    try {
        const payload = await filesService.verifyReadToken(token)
        if (payload.fileId !== expectedFileId) {
            return null
        }
        return payload
    }
    catch {
        return null
    }
}

function parseFileTypeHeader(value: unknown): FileType {
    const raw = parseStringHeader(value)
    if (isNil(raw) || !ENGINE_WRITABLE_FILE_TYPES.has(raw as FileType)) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: { message: `Header ${fileTransportHeaders.TYPE} must be one of ${Array.from(ENGINE_WRITABLE_FILE_TYPES).join(', ')}` },
        })
    }
    return raw as FileType
}

function parseStringHeader(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0]
    }
    return undefined
}
