import { isNil } from '@inboxfm-connect/core-utils'
import { McpOAuthClient } from '@inboxfm-connect/shared'
import { FastifyBaseLogger, FastifyReply } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { authAbuseRateLimitOptions } from '../../../core/security/rate-limit'
import { mcpOAuthClientService } from '../client/mcp-oauth-client.service'
import { mcpOAuthCodeService } from '../code/mcp-oauth-code.service'
import { mcpOAuthTokenService, OAuthTokenError } from './mcp-oauth-token.service'

export const mcpOAuthTokenController: FastifyPluginAsyncZod = async (app) => {

    app.post('/token', TokenRequest, async (req, reply) => {
        const { grant_type, client_id } = req.body

        try {
            if (grant_type === 'authorization_code') {
                return await handleAuthorizationCode(req.body, reply)
            }
            if (grant_type === 'refresh_token') {
                return await handleRefreshToken(req.body, reply, req.log)
            }
            return await reply.status(400).send({ error: 'unsupported_grant_type' })
        }
        catch (e) {
            if (e instanceof OAuthTokenError) {
                return reply.status(400).send({
                    error: e.errorCode,
                    error_description: e.errorDescription,
                })
            }
            req.log.error({ error: e, clientId: client_id }, 'OAuth token error')
            return reply.status(500).send({ error: 'server_error' })
        }
    })
}

async function authenticateClient(body: TokenRequestBody, reply: FastifyReply): Promise<McpOAuthClient | null> {
    const { client_id } = body
    if (!client_id) {
        await reply.status(400).send({ error: 'invalid_request', error_description: 'Missing client_id' })
        return null
    }

    const client = await mcpOAuthClientService.getByClientId(client_id)
    if (isNil(client)) {
        await reply.status(400).send({ error: 'invalid_client' })
        return null
    }

    if (client.tokenEndpointAuthMethod === 'client_secret_post') {
        if (!body.client_secret || !mcpOAuthClientService.validateClientSecret(client, body.client_secret)) {
            await reply.status(400).send({ error: 'invalid_client', error_description: 'Invalid client secret' })
            return null
        }
    }

    return client
}

// RFC 7591 §2.1: a client may only use grant types it registered. The register
// endpoint persists grant_types (defaulting to both supported grants), but the
// token endpoint never checked them - a client registered as authorization_code-
// only could still exercise the refresh_token grant (and vice versa).
async function assertGrantAllowed(client: McpOAuthClient, grantType: string, reply: FastifyReply): Promise<boolean> {
    if (!client.grantTypes.includes(grantType)) {
        await reply.status(400).send({
            error: 'unauthorized_client',
            error_description: `Client is not registered for the ${grantType} grant type`,
        })
        return false
    }
    return true
}

async function handleAuthorizationCode(body: TokenRequestBody, reply: FastifyReply): Promise<void> {
    const { code, code_verifier, redirect_uri } = body
    if (!code || !code_verifier || !redirect_uri) {
        await reply.status(400).send({ error: 'invalid_request', error_description: 'Missing code, code_verifier, or redirect_uri' })
        return
    }

    const client = await authenticateClient(body, reply)
    if (isNil(client)) return
    if (!(await assertGrantAllowed(client, 'authorization_code', reply))) return

    const authCode = await mcpOAuthCodeService.consume(code, client.clientId, redirect_uri)
    if (isNil(authCode)) {
        await reply.status(400).send({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' })
        return
    }

    const tokens = await mcpOAuthTokenService.exchangeCode({
        codeVerifier: code_verifier,
        codeChallenge: authCode.codeChallenge,
        codeChallengeMethod: authCode.codeChallengeMethod,
        clientId: client.clientId,
        userId: authCode.userId,
        projectId: authCode.projectId,
        platformId: authCode.platformId,
        scopes: authCode.scopes ?? ['mcp'],
    })

    await reply.status(200).send(tokens)
}

async function handleRefreshToken(body: TokenRequestBody, reply: FastifyReply, log: FastifyBaseLogger): Promise<void> {
    const { refresh_token } = body
    if (!refresh_token) {
        await reply.status(400).send({ error: 'invalid_request', error_description: 'Missing refresh_token' })
        return
    }

    const client = await authenticateClient(body, reply)
    if (isNil(client)) return
    if (!(await assertGrantAllowed(client, 'refresh_token', reply))) return

    const tokens = await mcpOAuthTokenService.refreshAccessToken({
        refreshToken: refresh_token,
        clientId: client.clientId,
        log,
    })

    await reply.status(200).send(tokens)
}

const tokenRequestSchema = z.object({
    grant_type: z.string(),
    code: z.string().optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    code_verifier: z.string().optional(),
    redirect_uri: z.string().optional(),
    refresh_token: z.string().optional(),
    resource: z.string().optional(),
})

const TokenRequest = {
    config: {
        security: securityAccess.public(),
        // This endpoint authenticates client_secret_post secrets and consumes
        // one-time authorization codes — the same tighter tier as sign-up /
        // sign-in (see core/security/rate-limit.ts). 10/min/IP is far above a
        // legitimate client's refresh cadence.
        rateLimit: authAbuseRateLimitOptions,
    },
    schema: {
        hide: true,
        body: tokenRequestSchema,
    },
}

type TokenRequestBody = z.infer<typeof tokenRequestSchema>
