import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { mcpOAuthRegisterRateLimitOptions } from '../../../core/security/rate-limit'
import { mcpOAuthClientService } from './mcp-oauth-client.service'

// RFC 8252 (OAuth for native apps, BCP) §7.3 and the OAuth Security BCP both reject
// plain-http redirect URIs except for the loopback interface, where TLS provides no
// real protection and all OSes reserve the range. Any other http:// host would let
// an on-path attacker read the authorization code (and PKCE does not protect the
// redirect leg itself).
const MAX_REDIRECT_URIS_PER_CLIENT = 8

function isPrivateUseScheme(protocol: string): boolean {
    const scheme = protocol.replace(/:$/, '')
    return /^[a-z][a-z0-9+\-.]*\.[a-z][a-z0-9+\-.]*$/.test(scheme)
        || ['cursor', 'vscode', 'vscode-insiders', 'windsurf', 'claude'].includes(scheme)
}

function isLoopbackHttpUrl(rawUrl: string): boolean {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function isValidRedirectUri(rawUrl: string): boolean {
    const url = new URL(rawUrl)
    // RFC 6749 s3.1.2: the redirect URI must not include a fragment component,
    // regardless of scheme — fragments never reach the server and can be
    // rewritten by anything with access to the redirect target.
    if (url.hash) {
        return false
    }
    if (url.protocol === 'https:') {
        return true
    }
    if (url.protocol === 'http:') {
        return isLoopbackHttpUrl(rawUrl)
    }
    return isPrivateUseScheme(url.protocol)
}

export const mcpOAuthRegisterController: FastifyPluginAsyncZod = async (app) => {

    app.post('/register', RegisterRequest, async (req, reply) => {
        const { redirect_uris, client_name, grant_types, token_endpoint_auth_method } = req.body

        const result = await mcpOAuthClientService.register({
            redirectUris: redirect_uris,
            clientName: client_name,
            grantTypes: grant_types,
            tokenEndpointAuthMethod: token_endpoint_auth_method,
        })

        return reply.status(201).send(result)
    })
}

const RegisterRequest = {
    config: {
        security: securityAccess.public(),
        // RFC 7591 dynamic registration writes one DB row per unauthenticated
        // request. The dedicated, looser tier (see core/security/rate-limit.ts)
        // bounds that row creation without constraining legitimate one-time
        // client registrations.
        rateLimit: mcpOAuthRegisterRateLimitOptions,
    },
    schema: {
        hide: true,
        body: z.object({
            redirect_uris: z.array(z.string().url().refine(isValidRedirectUri, { message: 'Only https, loopback http (RFC 8252), or private-use URI schemes are allowed' })).min(1).max(MAX_REDIRECT_URIS_PER_CLIENT),
            client_name: z.string().max(255).optional(),
            grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
            response_types: z.array(z.enum(['code'])).optional(),
            token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).optional(),
        }),
    },
}