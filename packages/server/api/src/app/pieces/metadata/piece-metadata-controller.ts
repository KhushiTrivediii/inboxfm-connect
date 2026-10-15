import { ActivepiecesError, ErrorCode, isNil, LocalesEnum, SeekPage } from '@inboxfm-connect/core-utils'
import { PieceMetadataModel, PieceMetadataModelSummary } from '@inboxfm-connect/pieces-framework'
import { ALL_PRINCIPAL_TYPES, GetPieceRequestParams, GetPieceRequestQuery, GetPieceRequestWithScopeParams, ListPiecesRequestQuery, PieceCategory, PieceOptionRequest, Principal, PrincipalType, RegistryPiecesRequestQuery, WorkerJobType } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { userInteractionWatcher } from '../../helper/user-interaction/user-interaction-watcher'
import { pieceSyncService } from '../piece-sync-service'
import { getPiecePackageWithoutArchive, pieceMetadataService } from './piece-metadata-service'

export const pieceModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(basePiecesController, { prefix: '/v1/integrations' })
}

const basePiecesController: FastifyPluginAsyncZod = async (app) => {

    app.get(
        '/categories',
        ListCategoriesRequest,
        async (): Promise<PieceCategory[]> => {
            return Object.values(PieceCategory)
        },
    )

    app.get('/', ListPiecesRequest, async (req): Promise<SeekPage<PieceMetadataModelSummary>> => {
        const query = req.query

        const oldSyncCall = !isNil(query.release)
        if (oldSyncCall) {
            throw new ActivepiecesError({
                code: ErrorCode.PIECE_SYNC_NOT_SUPPORTED,
                params: {
                    message: 'This endpoint is deprecated. Please use it without release parameter.',
                    release: query.release ?? '',
                },
            })
        }
        const includeTags = query.includeTags ?? false
        const platformId = getPlatformId(req.principal)
        const projectId = req.query.projectId
        const pieceMetadataSummary = await pieceMetadataService(req.log).list({
            includeHidden: query.includeHidden ?? false,
            projectId,
            platformId,
            includeTags,
            categories: query.categories,
            searchQuery: query.searchQuery,
            sortBy: query.sortBy,
            orderBy: query.orderBy,
            suggestionType: query.suggestionType,
            locale: query.locale as LocalesEnum | undefined,
        })
        const mappedPieces = pieceMetadataSummary.map((piece) => {
            return {
                ...piece,
                i18n: undefined,
            }
        })
        return paginatePieces(mappedPieces, query.cursor, query.limit, query)
    })

    app.get(
        '/:scope/:name',
        GetPieceParamsWithScopeRequest,
        async (req) => {
            const { name, scope } = req.params
            const { version } = req.query

            const decodeScope = decodeURIComponent(scope)
            const decodedName = decodeURIComponent(name)
            const platformId = getPlatformId(req.principal)
            return pieceMetadataService(req.log).getOrThrow({
                platformId,
                name: `${decodeScope}/${decodedName}`,
                version,
                locale: req.query.locale as LocalesEnum | undefined,
            })
        },
    )

    app.get(
        '/:name',
        GetPieceParamsRequest,
        async (req): Promise<PieceMetadataModel> => {
            const { name } = req.params
            const { version } = req.query
            const decodedName = decodeURIComponent(name)
            const platformId = getPlatformId(req.principal)
            return pieceMetadataService(req.log).getOrThrow({
                platformId,
                name: decodedName,
                version,
                locale: req.query.locale as LocalesEnum | undefined,
            })
        },
    )

    app.get('/registry', RegistryPiecesRequest, async (req) => {
        const pieces = await pieceMetadataService(req.log).registry({
            release: req.query.release,
            platformId: getPlatformId(req.principal),
        })
        return pieces
    })

    app.post('/sync', SyncPiecesRequest, async (req) => pieceSyncService(req.log).sync({ publishCacheRefresh: true }))

    app.delete('/:id', DeletePieceRequest, async (req, reply) => {
        await pieceMetadataService(req.log).delete({
            id: req.params.id,
            platformId: req.principal.platform.id,
        })
        return reply.status(StatusCodes.NO_CONTENT).send()
    })

    app.post(
        '/options',
        OptionsPieceRequest,
        async (req) => {
            const projectId = req.projectId
            const platform = req.principal.platform
            return userInteractionWatcher.submitAndWaitForResponse<unknown>({
                jobType: WorkerJobType.EXECUTE_PROPERTY,
                platformId: platform.id,
                projectId,
                propertyName: req.body.propertyName,
                actionOrTriggerName: req.body.actionOrTriggerName,
                input: req.body.input,
                sampleData: {},
                searchValue: req.body.searchValue,
                piece: await getPiecePackageWithoutArchive(req.log, platform.id, req.body),
            }, req.log)
        },
    )

}

const DEFAULT_PAGE_SIZE = 20

type PieceCursorPayload = {
    name: string
    index: number
    queryHash?: string
}

function normalizeBooleanFlag(val: unknown): boolean {
    return val === true || val === 'true'
}

function computeQueryFingerprint(query?: Record<string, unknown>): string {
    if (!query) {
        return ''
    }
    const relevantKeys = [
        'searchQuery',
        'sortBy',
        'orderBy',
        'suggestionType',
        'categories',
        'edition',
        'locale',
        'projectId',
    ]
    const normalized: Record<string, unknown> = {
        includeHidden: normalizeBooleanFlag(query.includeHidden),
        includeTags: normalizeBooleanFlag(query.includeTags),
    }
    for (const key of relevantKeys.sort()) {
        const val = query[key]
        if (val !== undefined && val !== null && val !== '') {
            normalized[key] = Array.isArray(val) ? [...val].sort() : val
        }
    }
    return Buffer.from(JSON.stringify(normalized)).toString('base64')
}

function encodePieceCursor(payload: PieceCursorPayload): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64')
}

function decodePieceCursor(cursorStr: string): PieceCursorPayload | null {
    try {
        const decoded = Buffer.from(cursorStr, 'base64').toString('utf8')
        const parsed = JSON.parse(decoded)
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.name !== 'string' || typeof parsed.index !== 'number') {
            return null
        }
        return parsed as PieceCursorPayload
    }
    catch {
        return null
    }
}

function paginatePieces(
    pieces: PieceMetadataModelSummary[],
    cursorRequest?: string,
    limitRequest?: number,
    activeQuery?: Record<string, unknown>,
): SeekPage<PieceMetadataModelSummary> {
    if (limitRequest === undefined && cursorRequest === undefined) {
        return paginationHelper.createPage(pieces, { afterCursor: null, beforeCursor: null })
    }

    const rawLimit = limitRequest ?? DEFAULT_PAGE_SIZE
    const limit = Math.max(1, Math.min(Math.floor(rawLimit) || DEFAULT_PAGE_SIZE, 500))
    const currentQueryHash = computeQueryFingerprint(activeQuery)
    const decodedCursor = paginationHelper.decodeCursor(cursorRequest)

    let startIndex = 0
    let endIndex = pieces.length

    if (decodedCursor.nextCursor) {
        const payload = decodePieceCursor(decodedCursor.nextCursor)
        if (payload) {
            // Stale cursor query check
            if (payload.queryHash && payload.queryHash !== currentQueryHash) {
                // Restart at first page
                startIndex = 0
                endIndex = Math.min(limit, pieces.length)
            }
            else {
                let foundIdx = -1
                if (payload.index >= 0 && payload.index < pieces.length && pieces[payload.index].name === payload.name) {
                    foundIdx = payload.index
                }
                else {
                    foundIdx = pieces.findIndex((p) => p.name === payload.name)
                }
                if (foundIdx !== -1) {
                    startIndex = foundIdx + 1
                    startIndex = Math.max(0, Math.min(startIndex, pieces.length))
                    endIndex = Math.min(startIndex + limit, pieces.length)
                }
                else {
                    // Anchor piece not found in list -> fallback to first page
                    startIndex = 0
                    endIndex = Math.min(limit, pieces.length)
                }
            }
        }
        else {
            // Malformed next cursor -> fallback to first page
            startIndex = 0
            endIndex = Math.min(limit, pieces.length)
        }
    }
    else if (decodedCursor.previousCursor) {
        const payload = decodePieceCursor(decodedCursor.previousCursor)
        if (payload) {
            // Stale cursor query check
            if (payload.queryHash && payload.queryHash !== currentQueryHash) {
                // Restart at first page
                startIndex = 0
                endIndex = Math.min(limit, pieces.length)
            }
            else {
                let foundIdx = -1
                if (payload.index >= 0 && payload.index < pieces.length && pieces[payload.index].name === payload.name) {
                    foundIdx = payload.index
                }
                else {
                    foundIdx = pieces.findIndex((p) => p.name === payload.name)
                }
                if (foundIdx !== -1) {
                    endIndex = foundIdx
                    startIndex = Math.max(0, endIndex - limit)
                }
                else {
                    // Anchor piece not found in list -> fallback to first page
                    startIndex = 0
                    endIndex = Math.min(limit, pieces.length)
                }
            }
        }
        else {
            // Malformed previous cursor -> fallback to first page
            startIndex = 0
            endIndex = Math.min(limit, pieces.length)
        }
    }
    else {
        startIndex = 0
        endIndex = Math.min(limit, pieces.length)
    }

    const data = pieces.slice(startIndex, endIndex)
    const hasMore = endIndex < pieces.length
    const hasPrevious = startIndex > 0

    const afterCursor = (data.length > 0 && hasMore)
        ? encodePieceCursor({ name: data[data.length - 1].name, index: startIndex + data.length - 1, queryHash: currentQueryHash })
        : null
    const beforeCursor = (data.length > 0 && hasPrevious)
        ? encodePieceCursor({ name: data[0].name, index: startIndex, queryHash: currentQueryHash })
        : null

    return paginationHelper.createPage(data, { afterCursor, beforeCursor })
}

function getPlatformId(principal: Principal): string | undefined {
    return principal.type === PrincipalType.WORKER || principal.type === PrincipalType.UNKNOWN || principal.type === PrincipalType.ONBOARDING ? undefined : principal.platform?.id
}

const RegistryPiecesRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        querystring: RegistryPiecesRequestQuery,
    },
}

const ListPiecesRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        querystring: ListPiecesRequestQuery,

    },

}
const GetPieceParamsRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        params: GetPieceRequestParams,
        querystring: GetPieceRequestQuery,
    },
}

const GetPieceParamsWithScopeRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        params: GetPieceRequestWithScopeParams,
        querystring: GetPieceRequestQuery,
    },
}

const ListCategoriesRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        querystring: ListPiecesRequestQuery,
    },
}

const OptionsPieceRequest = {
    schema: {
        body: PieceOptionRequest,
    },
    config: {
        security: securityAccess.project([PrincipalType.USER], undefined, {
            type: ProjectResourceType.BODY,
        }),
    },
}

const SyncPiecesRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
    },
}

const DeletePieceRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        tags: ['pieces'],
        params: z.object({
            id: z.string(),
        }),
    },
}

export const pieceMetadataTesting = {
    computeQueryFingerprint,
    paginatePieces,
    decodePieceCursor,
    encodePieceCursor,
    normalizeBooleanFlag,
}

