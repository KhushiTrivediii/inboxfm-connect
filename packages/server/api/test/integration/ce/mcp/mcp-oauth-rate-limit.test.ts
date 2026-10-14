import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

// Mirror the production defaults in system.ts, read via system.getOrThrow at
// module load like sync-execution-rate-limit.test.ts — the tests exercise the
// real defaults rather than mocking a lower threshold.
const ABUSE_IP_MAX = Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_ABUSE_MAX), 10)
const MCP_REGISTER_IP_MAX = Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MCP_REGISTER_MAX), 10)

// The MCP OAuth endpoints are mounted at the domain root (required by the MCP
// spec), not under /api: POST /token, /revoke, /register. These tests pin that
// the authn abuse tier reaches them — the plugin must be registered at the
// root scope before these routes (see server.ts) for config.rateLimit to apply.
const TOKEN_URL = '/token'
const REVOKE_URL = '/revoke'
const REGISTER_URL = '/register'

const BOGUS_TOKEN_REQUEST = {
    grant_type: 'authorization_code',
    client_id: 'nonexistent-client-id',
    client_secret: 'wrong-secret',
    code: 'bogus-code',
    code_verifier: 'bogus-verifier',
    redirect_uri: 'https://bogus.example.com/callback',
}

const REGISTER_REQUEST = {
    redirect_uris: ['https://client.example.com/callback'],
}

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('mcp_oauth_client').createQueryBuilder().delete().execute()
})

afterEach(async () => {
    vi.restoreAllMocks()
    // Dedicated redis-memory-server instance for this file (see memory-redis.ts)
    // — flushall clears the rate-limit buckets the plugin's own client holds.
    const redis = await redisConnections.useExisting()
    await redis.flushall()
})

describe('MCP OAuth abuse rate-limit tier', () => {
    it('allows token requests up to the configured limit, then returns 429 with Retry-After', async () => {
        const ip = '198.51.100.10'

        for (let i = 0; i < ABUSE_IP_MAX; i++) {
            const response = await app!.inject({
                method: 'POST',
                url: TOKEN_URL,
                headers: { 'x-real-ip': ip },
                body: BOGUS_TOKEN_REQUEST,
            })
            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response.json().error).toBe('invalid_client')
        }

        const throttled = await app!.inject({
            method: 'POST',
            url: TOKEN_URL,
            headers: { 'x-real-ip': ip },
            body: BOGUS_TOKEN_REQUEST,
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(throttled.headers['retry-after']).toBeDefined()
    })

    it('throttles token requests even when they fail client authentication', async () => {
        // The limiter is an onRequest hook, so the counter increments on every
        // hit regardless of the auth outcome — failed brute-force attempts
        // still drain the same bucket.
        const ip = '198.51.100.11'

        for (let i = 0; i < ABUSE_IP_MAX + 2; i++) {
            const response = await app!.inject({
                method: 'POST',
                url: TOKEN_URL,
                headers: { 'x-real-ip': ip },
                body: { grant_type: 'refresh_token', refresh_token: 'bogus', client_id: 'nonexistent-client-id' },
            })
            if (i < ABUSE_IP_MAX) {
                expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
            }
            else {
                expect(response.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
            }
        }
    })

    it('allows revocations up to the configured limit, then returns 429', async () => {
        const ip = '198.51.100.12'

        for (let i = 0; i < ABUSE_IP_MAX; i++) {
            const response = await app!.inject({
                method: 'POST',
                url: REVOKE_URL,
                headers: { 'x-real-ip': ip },
                body: { token: 'bogus-token' },
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
        }

        const throttled = await app!.inject({
            method: 'POST',
            url: REVOKE_URL,
            headers: { 'x-real-ip': ip },
            body: { token: 'bogus-token' },
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(throttled.headers['retry-after']).toBeDefined()
    })

    it('isolates different client IPs so throttling one does not impact another', async () => {
        const throttledIp = '198.51.100.13'
        const separateIp = '198.51.100.14'

        for (let i = 0; i < ABUSE_IP_MAX; i++) {
            await app!.inject({
                method: 'POST',
                url: TOKEN_URL,
                headers: { 'x-real-ip': throttledIp },
                body: BOGUS_TOKEN_REQUEST,
            })
        }

        const throttled = await app!.inject({
            method: 'POST',
            url: TOKEN_URL,
            headers: { 'x-real-ip': throttledIp },
            body: BOGUS_TOKEN_REQUEST,
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)

        const freshResponse = await app!.inject({
            method: 'POST',
            url: TOKEN_URL,
            headers: { 'x-real-ip': separateIp },
            body: BOGUS_TOKEN_REQUEST,
        })
        expect(freshResponse.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('keeps token and revoke buckets independent per route', async () => {
        // token and revoke both use authAbuseRateLimitOptions, but the plugin's
        // store keys each bucket per route AND per IP (RedisStore.child prefixes
        // the method+url), same as sign-up vs sign-in — draining one endpoint's
        // bucket does not lock the other for that IP.
        const ip = '198.51.100.15'

        for (let i = 0; i < ABUSE_IP_MAX; i++) {
            const response = await app!.inject({
                method: 'POST',
                url: TOKEN_URL,
                headers: { 'x-real-ip': ip },
                body: BOGUS_TOKEN_REQUEST,
            })
            expect(response.statusCode).not.toBe(StatusCodes.TOO_MANY_REQUESTS)
        }

        const tokenThrottled = await app!.inject({
            method: 'POST',
            url: TOKEN_URL,
            headers: { 'x-real-ip': ip },
            body: BOGUS_TOKEN_REQUEST,
        })
        expect(tokenThrottled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)

        const revokeStillOpen = await app!.inject({
            method: 'POST',
            url: REVOKE_URL,
            headers: { 'x-real-ip': ip },
            body: { token: 'bogus-token' },
        })
        expect(revokeStillOpen.statusCode).toBe(StatusCodes.OK)
    })
})

describe('MCP OAuth dynamic-registration rate-limit tier', () => {
    it('allows registrations up to the looser configured limit, then returns 429', async () => {
        const ip = '198.51.100.20'

        for (let i = 0; i < MCP_REGISTER_IP_MAX; i++) {
            const response = await app!.inject({
                method: 'POST',
                url: REGISTER_URL,
                headers: { 'x-real-ip': ip },
                body: REGISTER_REQUEST,
            })
            expect(response.statusCode).toBe(StatusCodes.CREATED)
        }

        const throttled = await app!.inject({
            method: 'POST',
            url: REGISTER_URL,
            headers: { 'x-real-ip': ip },
            body: REGISTER_REQUEST,
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(throttled.headers['retry-after']).toBeDefined()
    })

    it('is looser than the abuse tier — an abused abuse-tier bucket does not throttle registration', async () => {
        const ip = '198.51.100.21'

        for (let i = 0; i < ABUSE_IP_MAX; i++) {
            await app!.inject({
                method: 'POST',
                url: TOKEN_URL,
                headers: { 'x-real-ip': ip },
                body: BOGUS_TOKEN_REQUEST,
            })
        }

        // The token bucket is drained, but register has its own, looser tier.
        const response = await app!.inject({
            method: 'POST',
            url: REGISTER_URL,
            headers: { 'x-real-ip': ip },
            body: REGISTER_REQUEST,
        })
        expect(response.statusCode).toBe(StatusCodes.CREATED)
    })
})

describe('MCP OAuth rate-limit off-switch', () => {
    it('disables all MCP OAuth limits when API_RATE_LIMIT_AUTHN_ENABLED is false', async () => {
        const ip = '198.51.100.30'
        const originalGetBoolean = system.getBoolean.bind(system)
        vi.spyOn(system, 'getBoolean').mockImplementation((prop: string) => {
            if (prop === AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED) {
                return false
            }
            return originalGetBoolean(prop as AppSystemProp)
        })

        for (let i = 0; i < MCP_REGISTER_IP_MAX + 5; i++) {
            const token = await app!.inject({
                method: 'POST',
                url: TOKEN_URL,
                headers: { 'x-real-ip': ip },
                body: BOGUS_TOKEN_REQUEST,
            })
            const revoke = await app!.inject({
                method: 'POST',
                url: REVOKE_URL,
                headers: { 'x-real-ip': ip },
                body: { token: 'bogus-token' },
            })
            const register = await app!.inject({
                method: 'POST',
                url: REGISTER_URL,
                headers: { 'x-real-ip': ip },
                body: REGISTER_REQUEST,
            })
            expect(token.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(revoke.statusCode).toBe(StatusCodes.OK)
            expect(register.statusCode).toBe(StatusCodes.CREATED)
        }
    })
})
