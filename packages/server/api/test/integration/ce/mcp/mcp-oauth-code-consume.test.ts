import { randomBytes } from 'crypto'
import { faker } from '@faker-js/faker'
import { apId } from '@inboxfm-connect/core-utils'
import { mcpOAuthCodeService } from '../../../../src/app/mcp/oauth/code/mcp-oauth-code.service'
import { db } from '../../../helpers/db'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

beforeAll(async () => {
    await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

function mockAuthCode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: apId(),
        created: faker.date.recent().toISOString(),
        updated: faker.date.recent().toISOString(),
        code: randomBytes(48).toString('base64url'),
        clientId: 'test-client',
        userId: apId(),
        projectId: null,
        platformId: apId(),
        redirectUri: 'http://localhost:3000/callback',
        codeChallenge: randomBytes(32).toString('base64url'),
        codeChallengeMethod: 'S256',
        scopes: ['mcp'],
        state: null,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        used: false,
        ...overrides,
    }
}

describe('MCP OAuth authorization code single-use (consume)', () => {
    it('claims an unused code once and rejects the replay', async () => {
        const code = mockAuthCode()
        await db.save('mcp_oauth_authorization_code', code)

        const first = await mcpOAuthCodeService.consume(code.code as string, 'test-client', 'http://localhost:3000/callback')
        expect(first?.id).toBe(code.id)

        // The replay attempt must be refused, not silently accepted
        const replay = await mcpOAuthCodeService.consume(code.code as string, 'test-client', 'http://localhost:3000/callback')
        expect(replay).toBeNull()
    })

    it('refuses a code whose clientId does not match', async () => {
        const code = mockAuthCode()
        await db.save('mcp_oauth_authorization_code', code)

        const mismatched = await mcpOAuthCodeService.consume(code.code as string, 'other-client', 'http://localhost:3000/callback')
        expect(mismatched).toBeNull()
    })

    it('refuses an expired code even when unused', async () => {
        const code = mockAuthCode({
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
        await db.save('mcp_oauth_authorization_code', code)

        const expired = await mcpOAuthCodeService.consume(code.code as string, 'test-client', 'http://localhost:3000/callback')
        expect(expired).toBeNull()
    })
})