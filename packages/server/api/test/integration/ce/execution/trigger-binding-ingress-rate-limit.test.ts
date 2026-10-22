import { apId } from '@inboxfm-connect/core-utils'
import { TriggerBindingStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { userInteractionWatcher } from '../../../../src/app/helper/user-interaction/user-interaction-watcher'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

/**
 * Rate-limit contract for the public ingress `POST /v1/trigger-bindings/:id/run`
 * (issue #351): the route is deliberately unauthenticated (the apId() URL is the
 * capability), but it mints real LLM executions, so a leaked URL must not be able
 * to farm unlimited executions. The limiter buckets by (binding id, client IP) and
 * is enabled by default with a low ceiling.
 */
let app: FastifyInstance | null = null

// Keep the test fast and deterministic: a tiny window and limit set via system props
// before the app boots, restored afterwards.
const TEST_LIMIT = 3
const TEST_WINDOW_SECONDS = 60

beforeAll(async () => {
    process.env['AP_PUBLIC_INGRESS_RATE_LIMITER_MAX_REQUESTS'] = TEST_LIMIT.toString()
    process.env['AP_PUBLIC_INGRESS_RATE_LIMITER_WINDOW_SECONDS'] = TEST_WINDOW_SECONDS.toString()
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
    // Restore the process env for later suites in the same worker (codeant finding
    // on #353): without this, every subsequent test inherits the test-only limit of 3
    // and its own ingress assertions can fail for the wrong reason.
    delete process.env['AP_PUBLIC_INGRESS_RATE_LIMITER_MAX_REQUESTS']
    delete process.env['AP_PUBLIC_INGRESS_RATE_LIMITER_WINDOW_SECONDS']
})

function stubEngineRunHook(output: unknown): void {
    vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockResolvedValue({ output } as never)
}

async function saveBinding(ctx: TestContext): Promise<{ id: string }> {
    const now = new Date().toISOString()
    const row = {
        id: apId(),
        created: now,
        updated: now,
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        pieceName: '@inboxfm-connect/piece-webhook',
        pieceVersion: '0.1.0',
        triggerName: 'catch_webhook',
        connectionId: null,
        promptTemplate: 'Handle {{item}}',
        settings: {},
        propertySettings: null,
        status: TriggerBindingStatus.ENABLED,
    }
    await db.save('trigger_binding', row)
    return row
}

function runUnauthenticated(bindingId: string, payload?: Record<string, unknown>): ReturnType<FastifyInstance['inject']> {
    return app!.inject({
        method: 'POST',
        url: `/api/v1/trigger-bindings/${bindingId}/run`,
        payload: payload ?? {},
    })
}

describe('public ingress rate limit (#351)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        stubEngineRunHook([{ hello: 'world' }])
    })

    it('allows requests under the limit and starts rejecting with 429 once it is exceeded', async () => {
        const ctx = await createTestContext()
        const binding = await saveBinding(ctx)

        const statuses: number[] = []
        for (let i = 0; i < TEST_LIMIT + 2; i++) {
            const response = await runUnauthenticated(binding.id)
            statuses.push(response.statusCode)
        }

        // first TEST_LIMIT pass, the rest are throttled
        expect(statuses.slice(0, TEST_LIMIT).every((code) => code === StatusCodes.OK)).toBe(true)
        expect(statuses.slice(TEST_LIMIT).every((code) => code === StatusCodes.TOO_MANY_REQUESTS)).toBe(true)
    })

    it('does not throttle a different binding when one hits the cap', async () => {
        const ctx = await createTestContext()
        const abused = await saveBinding(ctx)
        const bystander = await saveBinding(ctx)

        for (let i = 0; i < TEST_LIMIT + 2; i++) {
            await runUnauthenticated(abused.id)
        }
        expect((await runUnauthenticated(abused.id)).statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)

        // the bystander binding shares the project but has its own bucket
        expect((await runUnauthenticated(bystander.id)).statusCode).toBe(StatusCodes.OK)
    })

    it('does not apply to authenticated non-ingress routes', async () => {
        const ctx = await createTestContext()
        const binding = await saveBinding(ctx)

        // hammer the ingress to exhaust the bucket
        for (let i = 0; i < TEST_LIMIT + 2; i++) {
            await runUnauthenticated(binding.id)
        }

        // the authenticated read route for the same binding is untouched by the
        // public-ingress limiter (its own project/api-key limiters are disabled in tests)
        const response = await app!.inject({
            method: 'GET',
            url: `/api/v1/trigger-bindings/${binding.id}`,
            headers: {
                authorization: `Bearer ${(await import('../../../helpers/test-setup')).getTestApiKey?.() ?? ''}`,
            },
        })
        // whatever the auth outcome is, it must NOT be a 429 from the ingress limiter
        expect(response.statusCode).not.toBe(StatusCodes.TOO_MANY_REQUESTS)
    })
})


describe('trigger-binding run ingress body limit (#351)', () => {
    it('rejects an oversized body with 413 before the handler runs', async () => {
        const ctx = await createTestContext()
        const binding = await saveBinding(ctx)

        const oversized = { blob: 'x'.repeat(1024 * 1024 + 4096) }
        const response = await runUnauthenticated(binding.id, oversized)

        expect(response.statusCode).toBe(StatusCodes.REQUEST_TOO_LONG)
    })

    it('still accepts a body just under the limit', async () => {
        const ctx = await createTestContext()
        const binding = await saveBinding(ctx)

        const ok = { data: 'y'.repeat(1024 * 512) }
        const response = await runUnauthenticated(binding.id, ok)

        expect(response.statusCode).not.toBe(StatusCodes.REQUEST_TOO_LONG)
    })
})
