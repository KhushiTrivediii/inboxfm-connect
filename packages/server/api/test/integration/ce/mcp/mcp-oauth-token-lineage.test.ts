import { createHash } from 'crypto'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { mcpOAuthTokenService } from '../../../../src/app/mcp/oauth/token/mcp-oauth-token.service'
import { db } from '../../../helpers/db'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

// The token endpoint is rate-limited per client IP (MCP OAuth abuse tier,
// 10/min/IP). Each test in this file rotates and replays enough refresh
// tokens that a file-wide cumulative count would cross the threshold on a
// shared IP, so every test runs under its own client IP — the same
// per-test-IP convention as mcp-oauth-rate-limit.test.ts.
let testIpSuffix = 1
let currentTestIp = '198.51.100.1'
beforeEach(() => {
    testIpSuffix += 1
    currentTestIp = `198.51.100.${testIpSuffix}`
})

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

function hashRefreshToken(token: string): string {
    return cryptoUtils.hashSHA256(token)
}

async function seedToken(clientId: string, userTag: string): Promise<string> {
    const seeded = await mcpOAuthTokenService.exchangeCode({
        codeVerifier: 'x'.repeat(64),
        codeChallenge: sha256Base64Url('x'.repeat(64)),
        codeChallengeMethod: 'S256',
        clientId,
        userId: `u-${userTag}`,
        projectId: null,
        platformId: `pf-${userTag}`,
        scopes: ['mcp'],
    })
    return seeded.refresh_token as string
}

async function refresh(rawToken: string, clientId: string): Promise<{ status: number, body: { refresh_token?: string, error?: string } }> {
    const response = await app?.inject({
        method: 'POST',
        url: '/token',
        headers: { 'x-real-ip': currentTestIp },
        payload: {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: rawToken,
        },
    })
    return {
        status: response?.statusCode ?? 0,
        body: response?.json() ?? {},
    }
}

describe('MCP OAuth refresh-token lineage and family revocation (#332)', () => {
    it('records lineage: a rotated row points at the hash it was rotated from and keeps the family id', async () => {
        const clientId = await registerClient('https://lineage-test.example.com/callback')
        const seededRaw = await seedToken(clientId, 'lin1')

        const rotated = await refresh(seededRaw, clientId)
        expect(rotated.status).toBe(StatusCodes.OK)

        const row = await db.findOneByOrFail('mcp_oauth_token', {
            previousRefreshToken: hashRefreshToken(seededRaw),
        })
        expect(row.familyId).toBeDefined()
        // the successor inherits the seed row's familyId (the lineage root id)
        const seedRow = await db.findOneByOrFail('mcp_oauth_token', {
            refreshToken: hashRefreshToken(seededRaw),
        })
        expect(row.familyId).toBe(seedRow.id)
        // and the row is NOT revoked — a legitimate rotation never trips reuse detection
        expect(row.revoked).toBe(false)
        // the seed row itself is now consumed
        expect(seedRow.revoked).toBe(true)
    })

    it('revokes the entire family when a rotated token is replayed (reuse detection)', async () => {
        const clientId = await registerClient('https://replay-test.example.com/callback')
        const seededRaw = await seedToken(clientId, 'rep1')

        // rotate once — the attacker replays generation 1 while the victim holds generation 2
        const rotated = await refresh(seededRaw, clientId)
        expect(rotated.status).toBe(StatusCodes.OK)
        const victimToken = rotated.body.refresh_token as string

        // replay the OLD generation
        const replay = await refresh(seededRaw, clientId)
        expect(replay.status).toBe(StatusCodes.BAD_REQUEST)
        expect(replay.body.error).toBe('invalid_grant')

        // the VICTIM'S CURRENT token must now be dead too: whole family revoked
        const victimAfterReplay = await refresh(victimToken, clientId)
        expect(victimAfterReplay.status).toBe(StatusCodes.BAD_REQUEST)
        expect(victimAfterReplay.body.error).toBe('invalid_grant')
    })

    it('detects replays N generations deep via the stable family id', async () => {
        const clientId = await registerClient('https://deep-replay.example.com/callback')
        const gen1 = await seedToken(clientId, 'dep1')

        const gen2 = await refresh(gen1, clientId)
        expect(gen2.status).toBe(StatusCodes.OK)
        const gen2Raw = gen2.body.refresh_token as string

        const gen3 = await refresh(gen2Raw, clientId)
        expect(gen3.status).toBe(StatusCodes.OK)
        const gen3Raw = gen3.body.refresh_token as string

        // replay generation 2 (two rotations stale) — the row for gen3 carries
        // previousRefreshToken = hash(gen2), so the replay resolves to the family
        const replayOld = await refresh(gen2Raw, clientId)
        expect(replayOld.status).toBe(StatusCodes.BAD_REQUEST)

        // and the live generation-3 token is revoked with it
        const gen3AfterReplay = await refresh(gen3Raw, clientId)
        expect(gen3AfterReplay.status).toBe(StatusCodes.BAD_REQUEST)
        expect(gen3AfterReplay.body.error).toBe('invalid_grant')

        // every row of the family is revoked — resolve the family via the lineage
        // pointer of the row that gen1 rotated into
        const familyRow = await db.findOneByOrFail('mcp_oauth_token', {
            previousRefreshToken: hashRefreshToken(gen1),
        })
        const familyRows = await db.findManyBy('mcp_oauth_token', { familyId: familyRow.familyId })
        expect(familyRows.length).toBeGreaterThan(0)
        for (const row of familyRows) {
            expect(row.revoked).toBe(true)
        }
    })

    it('revokes only the offending family — a sibling lineage keeps working', async () => {
        const clientId = await registerClient('https://sibling-test.example.com/callback')
        const offenderRaw = await seedToken(clientId, 'sib1')
        const innocentRaw = await seedToken(clientId, 'sib2')

        const offenderRotated = await refresh(offenderRaw, clientId)
        expect(offenderRotated.status).toBe(StatusCodes.OK)

        // replay the offender's old generation
        const replay = await refresh(offenderRaw, clientId)
        expect(replay.status).toBe(StatusCodes.BAD_REQUEST)

        // the innocent sibling lineage from the SAME client is untouched
        const innocentRotated = await refresh(innocentRaw, clientId)
        expect(innocentRotated.status).toBe(StatusCodes.OK)
    })
})
