import { ActivepiecesError, ErrorCode, isNil, Permission, tryCatch } from '@inboxfm-connect/core-utils'
import {
    AppConnectionScope,
    AppConnectionType,
    AppConnectionWithoutSensitiveData,
    ConnectSessionPublicInfo,
    CreateConnectMcpTokenResponse,
    CreateConnectSessionRequest,
    CreateConnectSessionResponse,
    ExchangeConnectSessionMcpTokenRequest,
    GetOAuth2AuthorizationUrlResponse,
    PLACEHOLDER_CONNECTION_TYPE,
    PrincipalType,
    UpsertAppConnectionRequestBody,
} from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { appConnectionService } from '../app-connection/app-connection-service/app-connection-service'
import { oauth2Util } from '../app-connection/app-connection-service/oauth2/oauth2-util'
import { connectMcpService } from '../connect-mcp/connect-mcp.service'
import { connectOAuthAppService } from '../connect-oauth-apps/connect-oauth-app.service'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { projectService } from '../project/project-service'
import { connectSessionService } from './connect-session.service'

// Only these auth types make sense for an end-user who isn't a platform user:
// PLATFORM_OAUTH2 uses OAuth credentials the platform operator already configured
// (see resolvePlatformClientId below), so the end-user is never asked for a client
// id/secret. Raw OAUTH2/CLOUD_OAUTH2 require bringing your own OAuth app or rely on
// Activepieces' own hosted secrets proxy — neither fits an anonymous end-customer.
const SUPPORTED_CONNECTION_TYPES = new Set([
    AppConnectionType.SECRET_TEXT,
    AppConnectionType.BASIC_AUTH,
    AppConnectionType.CUSTOM_AUTH,
    AppConnectionType.PLATFORM_OAUTH2,
])

// Requires a project-scoped SERVICE (API key) principal — the developer's backend calls this.
export const connectSessionAuthenticatedController: FastifyPluginAsyncZod = async (app) => {
    app.post('/', CreateSessionRequest, async (req, res) => {
        const result = await connectSessionService.create({
            projectId: req.body.projectId,
            externalUserId: req.body.externalUserId,
            allowedPieceNames: req.body.allowedPieceNames,
            expiresInSeconds: req.body.expiresInSeconds,
        })
        return res.status(StatusCodes.CREATED).send(result)
    })
}

// No principal at all — redeemed directly by the end-user's browser via the token,
// which is why every handler here re-validates the token itself instead of relying
// on the security layer's project/platform checks.
export const connectSessionPublicController: FastifyPluginAsyncZod = async (app) => {
    app.get('/:token', GetSessionRequest, async (req) => {
        return connectSessionService.getPublicInfoOrThrow(req.params.token)
    })

    app.post('/:token/mcp-token', ExchangeSessionMcpTokenRequest, async (req, res) => {
        const session = await connectSessionService.getActiveOrThrow(req.params.token)
        const result = await connectMcpService(req.log).issueToken({
            projectId: session.projectId,
            externalUserId: session.externalUserId,
            allowedPieceNames: session.allowedPieceNames ?? undefined,
            expiresInSeconds: req.body?.expiresInSeconds,
        })
        return res.status(StatusCodes.CREATED).send(result)
    })

    app.post('/:token/oauth2/authorization-url', GetAuthorizationUrlRequest, async (req) => {
        const session = await connectSessionService.getActiveOrThrow(req.params.token)
        assertPieceAllowed({ allowedPieceNames: session.allowedPieceNames, pieceName: req.body.pieceName })
        const project = await projectService(req.log).getOneOrThrow(session.projectId)
        const clientId = await resolvePlatformClientId({ platformId: project.platformId, pieceName: req.body.pieceName })
        return oauth2Util(req.log).buildAuthorizationUrl({
            platformId: project.platformId,
            projectId: session.projectId,
            pieceName: req.body.pieceName,
            pieceVersion: req.body.pieceVersion,
            clientId,
            redirectUrl: req.body.redirectUrl,
            props: req.body.props,
            scopes: req.body.scopes,
        })
    })

    app.post('/:token/connections', CreateConnectionRequest, async (req, res) => {
        const session = await connectSessionService.getActiveOrThrow(req.params.token)
        assertPieceAllowed({ allowedPieceNames: session.allowedPieceNames, pieceName: req.body.pieceName })
        const project = await projectService(req.log).getOneOrThrow(session.projectId)

        if (req.body.type === PLACEHOLDER_CONNECTION_TYPE || !SUPPORTED_CONNECTION_TYPES.has(req.body.type)) {
            throw new ActivepiecesError({
                code: ErrorCode.INVALID_APP_CONNECTION,
                params: {
                    error: `Connection type "${req.body.type}" is not supported through a connect session`,
                },
            })
        }

        // Claim the session BEFORE persisting the connection: the single-use
        // guarantee must hold at the endpoint level too, not just the row level.
        // Two concurrent redemptions both pass getActiveOrThrow, but the claim
        // picks exactly one winner — and now the loser fails before its upsert
        // can overwrite the winner's connection. Retry-ability is unaffected:
        // the OAuth exchange completes before this endpoint is called, so
        // claim-first only burns the token if the upsert itself fails.
        await connectSessionService.consumeOrThrow(session.id)

        const baseUpsert = {
            platformId: project.platformId,
            projectIds: [session.projectId],
            externalId: session.externalUserId,
            displayName: req.body.displayName,
            pieceName: req.body.pieceName,
            pieceVersion: req.body.pieceVersion,
            ownerId: null,
            scope: AppConnectionScope.PROJECT,
            metadata: req.body.metadata,
        }

        // Never trust a client-id the browser sends for a platform-managed OAuth app —
        // always re-derive it from the platform's own oauth_app row, the same way the
        // authorization-url step did, so the end-user's browser never has to carry it.
        const value = req.body.type === AppConnectionType.PLATFORM_OAUTH2
            ? { ...req.body.value, client_id: await resolvePlatformClientId({ platformId: project.platformId, pieceName: req.body.pieceName }) }
            : req.body.value

        const connection = await appConnectionService(req.log).upsert({
            ...baseUpsert,
            type: req.body.type,
            value,
        })

        return res.status(StatusCodes.CREATED).send(connection)
    })
}

async function resolvePlatformClientId({ platformId, pieceName }: { platformId: string, pieceName: string }): Promise<string> {
    const { data: oauthApp, error } = await tryCatch(() => connectOAuthAppService.getWithSecretOrThrow({ platformId, pieceName }))
    if (error || isNil(oauthApp)) {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_APP_CONNECTION,
            params: {
                error: `The platform operator has not configured an OAuth app for "${pieceName}" yet. Ask them to add one before end-users can connect it.`,
            },
        })
    }
    return oauthApp.clientId
}

function assertPieceAllowed({ allowedPieceNames, pieceName }: AssertPieceAllowedParams): void {
    if (isNil(allowedPieceNames) || allowedPieceNames.length === 0) {
        return
    }
    if (!allowedPieceNames.includes(pieceName)) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: `This connect session does not allow connecting piece "${pieceName}"`,
            },
        })
    }
}

const CreateSessionRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.SERVICE],
            Permission.WRITE_APP_CONNECTION,
            { type: ProjectResourceType.BODY },
        ),
    },
    schema: {
        tags: ['connect-sessions'],
        description: 'Create a short-lived, token-gated session that lets an end-user of a third-party developer authorize a piece connection without a platform user account',
        body: CreateConnectSessionRequest,
        response: {
            [StatusCodes.CREATED]: CreateConnectSessionResponse,
        },
    },
}

const GetSessionRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        tags: ['connect-sessions'],
        params: z.object({
            token: z.string(),
        }),
        response: {
            [StatusCodes.OK]: ConnectSessionPublicInfo,
        },
    },
}

const ConnectSessionAuthorizationUrlRequestBody = z.object({
    pieceName: z.string(),
    pieceVersion: z.string().optional(),
    redirectUrl: z.string(),
    scopes: z.array(z.string()).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
})

const GetAuthorizationUrlRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        tags: ['connect-sessions'],
        params: z.object({
            token: z.string(),
        }),
        body: ConnectSessionAuthorizationUrlRequestBody,
        response: {
            [StatusCodes.OK]: GetOAuth2AuthorizationUrlResponse,
        },
    },
}

const CreateConnectionRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        tags: ['connect-sessions'],
        params: z.object({
            token: z.string(),
        }),
        body: UpsertAppConnectionRequestBody,
        response: {
            [StatusCodes.CREATED]: AppConnectionWithoutSensitiveData,
        },
    },
}

const ExchangeSessionMcpTokenRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        tags: ['connect-sessions'],
        description: 'Exchange an active connect session for a delegated external-user MCP token',
        params: z.object({
            token: z.string(),
        }),
        body: ExchangeConnectSessionMcpTokenRequest.optional(),
        response: {
            [StatusCodes.CREATED]: CreateConnectMcpTokenResponse,
        },
    },
}

type AssertPieceAllowedParams = {
    allowedPieceNames: string[] | null | undefined
    pieceName: string
}