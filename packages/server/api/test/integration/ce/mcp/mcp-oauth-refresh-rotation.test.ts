import { createHash } from 'crypto'
import { apId } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { mcpOAuthTokenService } from '../../../../src/app/mcp/oauth/token/mcp-oauth-token.service'
import { db } from '../../../helpers/db'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function registerClient(redirectUri: string): Promise<string> {
    const response = await app?.inject({
        method: 'POST',
        url: '/register',
        payload: {
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
        },
    })
    expect(response?.statusCode).toBe(StatusCodes.CREATED)
    return response?.json().client_id
}

function sha256Base64Url(value: string): string {
    return createHash('sha256').update(value).digest('base64url')
}

describe('MCP OAuth refresh-token rotation', () => {
    it('issues a new refresh token on refresh and invalidates the old one', async () => {
        const clientId = await registerClient('https://rotation-test.example.com/callback')

        const seeded = await mcpOAuthTokenService.exchangeCode({
            codeVerifier: 'a'.repeat(64),
            codeChallenge: sha256Base64Url('a'.repeat(64)),
            codeChallengeMethod: 'S256',
            clientId,
            userId: 'user-rotation-1',
            projectId: null,
            platformId: 'platform-rotation-1',
            scopes: ['mcp'],
        })
        expect(seeded.refresh_token).toBeDefined()

        const refreshOne = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'refresh_token',
                client_id: clientId,
                refresh_token: seeded.refresh_token,
            },
        })
        expect(refreshOne?.statusCode).toBe(StatusCodes.OK)
        const rotated = refreshOne?.json()
        expect(rotated.refresh_token).toBeDefined()
        expect(rotated.refresh_token).not.toBe(seeded.refresh_token)

        const replayOld = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'refresh_token',
                client_id: clientId,
                refresh_token: seeded.refresh_token,
            },
        })
        expect(replayOld?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(replayOld?.json().error).toBe('invalid_grant')

        // Reuse detection (#332): a detected replay means the token family may be
        // compromised, so the entire lineage is revoked — the current (rotated)
        // token dies with the replayed one and the client must re-authenticate.
        // This supersedes the earlier availability-first behavior per RFC 6819 s5.2.2.3.
        const refreshTwo = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'refresh_token',
                client_id: clientId,
                refresh_token: rotated.refresh_token,
            },
        })
        expect(refreshTwo?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(refreshTwo?.json().error).toBe('invalid_grant')
    })

    it('rejects a refresh presented by the wrong client and strands the stolen token', async () => {
        const legitimateClientId = await registerClient('https://mismatch-test.example.com/callback')
        const imposterClientId = await registerClient('https://mismatch-test.example.com/callback')

        const seeded = await mcpOAuthTokenService.exchangeCode({
            codeVerifier: 'b'.repeat(64),
            codeChallenge: sha256Base64Url('b'.repeat(64)),
            codeChallengeMethod: 'S256',
            clientId: legitimateClientId,
            userId: 'user-rotation-2',
            projectId: null,
            platformId: 'platform-rotation-2',
            scopes: ['mcp'],
        })

        const imposterRefresh = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'refresh_token',
                client_id: imposterClientId,
                refresh_token: seeded.refresh_token,
            },
        })
        expect(imposterRefresh?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(imposterRefresh?.json().error).toBe('invalid_grant')

        const legitimateRefresh = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'refresh_token',
                client_id: legitimateClientId,
                refresh_token: seeded.refresh_token,
            },
        })
        expect(legitimateRefresh?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('rejects a refresh whose expiresAt has passed via the SQL expiry clause', async () => {
        const clientId = await registerClient('https://expired-test.example.com/callback')
        const rawRefreshToken = `expired-${'e'.repeat(50)}`
        const now = new Date().toISOString()
        const expiredTokenId = apId()
        await db.save('mcp_oauth_token', {
            id: expiredTokenId,
            previousRefreshToken: null,
            familyId: expiredTokenId,
            refreshToken: cryptoUtils.hashSHA256(rawRefreshToken),
            clientId,
            userId: 'user-expired-1',
            projectId: null,
            platformId: 'platform-expired-1',
            scopes: ['mcp'],
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            revoked: false,
            created: now,
            updated: now,
        })

        const response = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'refresh_token',
                client_id: clientId,
                refresh_token: rawRefreshToken,
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(response?.json().error).toBe('invalid_grant')
    })
})
