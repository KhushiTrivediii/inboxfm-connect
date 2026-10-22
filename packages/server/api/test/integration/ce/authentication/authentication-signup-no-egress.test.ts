import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { createMockSignInRequest, createMockSignUpRequest } from '../../../helpers/mocks/authn'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(async () => {
    vi.restoreAllMocks()
    const redis = await redisConnections.useExisting()
    await redis.flushall()
})

describe('Sign-up PII egress guard (Issue #161)', () => {
    it('makes zero outbound HTTP calls during sign-up', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        const signUpRequest = createMockSignUpRequest()

        const response = await app!.inject({
            method: 'POST',
            url: '/api/v1/authentication/sign-up',
            headers: { 'x-real-ip': '198.51.100.60' },
            body: signUpRequest,
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(fetchSpy).not.toHaveBeenCalled()
        const carryingEmail = fetchSpy.mock.calls.filter((call) =>
            JSON.stringify(call).includes(signUpRequest.email),
        )
        expect(carryingEmail).toHaveLength(0)
    })

    it('sign-up then sign-in works end to end without the removed step', async () => {
        const signUpRequest = createMockSignUpRequest()
        const signUpResponse = await app!.inject({
            method: 'POST',
            url: '/api/v1/authentication/sign-up',
            headers: { 'x-real-ip': '198.51.100.61' },
            body: signUpRequest,
        })
        expect(signUpResponse.statusCode).toBe(StatusCodes.OK)

        const signInResponse = await app!.inject({
            method: 'POST',
            url: '/api/v1/authentication/sign-in',
            headers: { 'x-real-ip': '198.51.100.61' },
            body: createMockSignInRequest({ email: signUpRequest.email, password: signUpRequest.password }),
        })
        expect(signInResponse.statusCode).toBe(StatusCodes.OK)
    })
})
