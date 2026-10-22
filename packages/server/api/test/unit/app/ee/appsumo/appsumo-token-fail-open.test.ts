import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The module reads AP_APPSUMO_TOKEN at import time (top-level `const token =
// system.get(...)`), so each scenario needs a fresh module registry with the
// environment shaped first.
const appsumoHandleMock = vi.fn()

vi.mock('../../../../../src/app/ee/appsumo/appsumo.service', () => ({
    appsumoService: vi.fn(() => ({
        handleRequest: appsumoHandleMock,
    })),
}))

async function importAppsumoModule(env: Record<string, string | undefined>): Promise<{ app: FastifyInstance, cleanup: () => Promise<void> }> {
    vi.resetModules()
    const previous: Record<string, string | undefined> = {}
    const applyEnv = (): void => {
        for (const key of Object.keys(env)) {
            if (!(key in previous)) {
                previous[key] = process.env[key]
            }
            if (env[key] === undefined) {
                Reflect.deleteProperty(process.env, key)
            }
            else {
                process.env[key] = env[key]
            }
        }
    }
    const restoreEnv = (): void => {
        for (const key of Object.keys(previous)) {
            if (previous[key] === undefined) {
                Reflect.deleteProperty(process.env, key)
            }
            else {
                process.env[key] = previous[key]
            }
        }
    }
    applyEnv()
    try {
        const { appSumoModule } = await import('../../../../../src/app/ee/appsumo/appsumo.module')
        const app = fastify({ logger: false })
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)
        await app.register(appSumoModule)
        await app.ready()
        // The handler reads the token at REQUEST time, so the shaped env must
        // stay applied for the whole lifetime of the injected requests.
        return { app, cleanup: async (): Promise<void> => {
            restoreEnv()
            await app.close()
        } }
    }
    catch (error) {
        restoreEnv()
        throw error
    }
}

describe('appSumoModule /v1/appsumo/action authentication (#463)', () => {
    beforeEach(() => {
        appsumoHandleMock.mockClear()
    })

    afterEach(async () => {
        vi.resetModules()
    })

    const actionPayload = {
        action: 'activate',
        plan_id: 'activepieces_tier1',
        uuid: 'test-uuid',
        activation_email: 'admin@example.com',
    }

    it('rejects a literal "Bearer undefined" authorization header when AP_APPSUMO_TOKEN is unset (fail-open bypass)', async () => {
        // RED on dev: `Bearer ${token}` with token === undefined coerces to the
        // literal string "Bearer undefined", so an attacker sending exactly
        // that header passes the gate on a deployment that never configured
        // the token — and gets to poison/downgrade any platform's plan via
        // the public /v1/appsumo/action endpoint (CLOUD edition mounts it).
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: undefined })

        const response = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            headers: {
                authorization: 'Bearer undefined',
            },
            payload: actionPayload,
        })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(appsumoHandleMock).not.toHaveBeenCalled()
        await cleanup()
    })

    it('rejects the action endpoint entirely when AP_APPSUMO_TOKEN is unset and no header is sent', async () => {
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: undefined })

        const response = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            payload: actionPayload,
        })

        // 400 = zod header validation rejects the missing authorization header
        // before the handler runs; anything but 2xx means the gate held.
        expect([StatusCodes.BAD_REQUEST, StatusCodes.UNAUTHORIZED]).toContain(response.statusCode)
        expect(appsumoHandleMock).not.toHaveBeenCalled()
        await cleanup()
    })

    it('accepts a correct bearer token when AP_APPSUMO_TOKEN is set', async () => {
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: 'sumo-secret-token' })

        const response = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            headers: {
                authorization: 'Bearer sumo-secret-token',
            },
            payload: actionPayload,
        })

        expect(response.statusCode).toBe(StatusCodes.CREATED)
        expect(appsumoHandleMock).toHaveBeenCalledTimes(1)
        await cleanup()
    })

    it('rejects a wrong bearer token when AP_APPSUMO_TOKEN is set', async () => {
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: 'sumo-secret-token' })

        const response = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            headers: {
                authorization: 'Bearer wrong-token',
            },
            payload: actionPayload,
        })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(appsumoHandleMock).not.toHaveBeenCalled()
        await cleanup()
    })

    it('rejects "Bearer undefined" even when AP_APPSUMO_TOKEN is set to a real value', async () => {
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: 'sumo-secret-token' })

        const response = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            headers: {
                authorization: 'Bearer undefined',
            },
            payload: actionPayload,
        })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(appsumoHandleMock).not.toHaveBeenCalled()
        await cleanup()
    })

    it('rejects the token exchange when AP_APPSUMO_TOKEN is unset even if the client sends "undefined" credentials', async () => {
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: undefined })

        const response = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/token',
            payload: {
                username: 'undefined',
                password: 'undefined',
            },
        })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        await cleanup()
    })

    it('rejects a valid token sent under a non-Bearer scheme (Basic/BearerX must not authenticate)', async () => {
        // The scheme prefix must be matched exactly, not sliced unconditionally:
        // "Basic <token>" and "BearerX <token>" carry the real credential after
        // 7 characters but are not Bearer authorizations.
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: 'sumo-secret-token' })

        const basicResponse = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            headers: {
                authorization: 'Basic sumo-secret-token',
            },
            payload: actionPayload,
        })
        const bearerXResponse = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            headers: {
                authorization: 'BearerX sumo-secret-token',
            },
            payload: actionPayload,
        })

        expect(basicResponse.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(bearerXResponse.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(appsumoHandleMock).not.toHaveBeenCalled()
        await cleanup()
    })

    it('rejects a bare token with no scheme prefix', async () => {
        const { app, cleanup } = await importAppsumoModule({ AP_APPSUMO_TOKEN: 'sumo-secret-token' })

        const response = await app.inject({
            method: 'POST',
            url: '/v1/appsumo/action',
            headers: {
                authorization: 'sumo-secret-token',
            },
            payload: actionPayload,
        })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(appsumoHandleMock).not.toHaveBeenCalled()
        await cleanup()
    })
})
