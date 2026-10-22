import { apId } from '@inboxfm-connect/core-utils'
import { TriggerBindingStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { userInteractionWatcher } from '../../../../src/app/helper/user-interaction/user-interaction-watcher'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

/**
 * Security contract for `POST /v1/trigger-bindings/:id/run`.
 *
 * This route is intentionally `securityAccess.public()`: it is the event-ingress
 * surface a third-party app posts to when a subscribed resource changes
 * (TRIGGER_ARCHITECTURE.md "RUN"; the `webhookUrl` handed to the engine's ON_ENABLE
 * hook). External senders hold no Inboxfm credential, so the unguessable `apId()` in
 * the path is the capability.
 *
 * Because there is no principal, the tenant CANNOT come from the request. These tests
 * pin that it comes from the `trigger_binding` row and nowhere else, so a caller can
 * neither aim an execution at a project it does not own nor revive a disabled binding.
 */
let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

/**
 * The RUN hook is normally serviced by a worker over the user-interaction channel.
 * No worker runs here, so it is stubbed to return one event item — enough to drive
 * `executionService.create` and observe which project the row lands in.
 */
function stubEngineRunHook(output: unknown): void {
    vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockResolvedValue({ output } as never)
}

async function saveBinding(ctx: TestContext, status: TriggerBindingStatus): Promise<{ id: string }> {
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
        status,
    }
    await db.save('trigger_binding', row)
    return row
}

function runUnauthenticated(bindingId: string, body?: unknown): ReturnType<FastifyInstance['inject']> {
    return app!.inject({
        method: 'POST',
        url: `/api/v1/trigger-bindings/${bindingId}/run`,
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    })
}

async function executionsIn(projectId: string): Promise<{ id: string, projectId: string }[]> {
    return db.findManyBy<{ id: string, projectId: string }>('execution', { projectId })
}

describe('POST /v1/trigger-bindings/:id/run — public ingress security', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('accepts an unauthenticated call and books the execution to the binding own project', async () => {
        const ctx = await createTestContext(app!)
        const binding = await saveBinding(ctx, TriggerBindingStatus.ENABLED)
        stubEngineRunHook([{ message: 'external event' }])

        const response = await runUnauthenticated(binding.id)

        expect(response.statusCode, response.payload).toBe(StatusCodes.OK)
        const created = response.json()
        expect(created).toHaveLength(1)
        expect(created[0].projectId).toBe(ctx.project.id)
        expect(created[0].platformId).toBe(ctx.platform.id)
    })

    it('ignores a projectId planted in the request body — the body is only the event payload', async () => {
        const victim = await createTestContext(app!)
        const attacker = await createTestContext(app!)
        const binding = await saveBinding(victim, TriggerBindingStatus.ENABLED)
        stubEngineRunHook([{ message: 'planted' }])

        const response = await runUnauthenticated(binding.id, {
            projectId: attacker.project.id,
            platformId: attacker.platform.id,
        })

        expect(response.statusCode, response.payload).toBe(StatusCodes.OK)
        expect(response.json()[0].projectId).toBe(victim.project.id)
        expect(await executionsIn(attacker.project.id)).toHaveLength(0)
    })

    it('ignores a foreign-project bearer token — ownership still comes from the binding row', async () => {
        const victim = await createTestContext(app!)
        const attacker = await createTestContext(app!)
        const binding = await saveBinding(victim, TriggerBindingStatus.ENABLED)
        stubEngineRunHook([{ message: 'foreign token' }])

        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/trigger-bindings/${binding.id}/run`,
            headers: { authorization: `Bearer ${attacker.token}` },
        })

        expect(response.statusCode, response.payload).toBe(StatusCodes.OK)
        expect(response.json()[0].projectId).toBe(victim.project.id)
        expect(await executionsIn(attacker.project.id)).toHaveLength(0)
    })

    it('fails safe on an unknown binding id and creates nothing', async () => {
        const ctx = await createTestContext(app!)
        stubEngineRunHook([{ message: 'should never run' }])

        const response = await runUnauthenticated(apId())

        expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
        expect(await executionsIn(ctx.project.id)).toHaveLength(0)
    })

    it('refuses to execute a disabled binding and creates nothing', async () => {
        const ctx = await createTestContext(app!)
        const binding = await saveBinding(ctx, TriggerBindingStatus.DISABLED)
        const engineHook = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse')

        const response = await runUnauthenticated(binding.id)

        expect(response.statusCode).toBeGreaterThanOrEqual(StatusCodes.BAD_REQUEST)
        expect(engineHook).not.toHaveBeenCalled()
        expect(await executionsIn(ctx.project.id)).toHaveLength(0)
    })

    it('creates one execution per emitted event item, all in the binding project', async () => {
        const ctx = await createTestContext(app!)
        const binding = await saveBinding(ctx, TriggerBindingStatus.ENABLED)
        stubEngineRunHook([{ n: 1 }, { n: 2 }, { n: 3 }])

        const response = await runUnauthenticated(binding.id)

        expect(response.statusCode, response.payload).toBe(StatusCodes.OK)
        const created = response.json()
        expect(created).toHaveLength(3)
        expect(created.every((e: { projectId: string }) => e.projectId === ctx.project.id)).toBe(true)
        expect(await executionsIn(ctx.project.id)).toHaveLength(3)
    })

    it('hands the engine a webhookUrl derived from the configured public API URL without localhost literals (#159)', async () => {
        const ctx = await createTestContext(app!)
        const binding = await saveBinding(ctx, TriggerBindingStatus.ENABLED)
        const spy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockImplementation(async () => ({ output: [] }))

        const response = await runUnauthenticated(binding.id)
        expect(response.statusCode).toBe(StatusCodes.OK)

        expect(spy).toHaveBeenCalledTimes(1)
        const passedJobData = spy.mock.calls[0][0]
        expect(typeof passedJobData.webhookUrl).toBe('string')
        const webhookUrl = String(passedJobData.webhookUrl)
        expect(webhookUrl).not.toContain('localhost:3000')
        expect(webhookUrl).toContain(`/v1/trigger-bindings/${binding.id}/run`)

        // Verify that the handed webhook URL resolves against the served fastify route (not 404)
        const parsedUrl = new URL(webhookUrl)
        const webhookResponse = await app!.inject({
            method: 'POST',
            url: parsedUrl.pathname,
            payload: { message: 'verified-ingress' },
        })
        expect(webhookResponse.statusCode).toBe(StatusCodes.OK)
    })
})

describe('Trigger binding tenant-scoped reads stay scoped', () => {
    /**
     * `getOneOrThrow` now requires `projectId`/`platformId`. The previous revision made
     * them optional and dropped the predicates when nil, which meant any caller that
     * forgot to thread the principal's scope silently performed a cross-tenant read.
     * The authenticated detail route must therefore never surface another project's row.
     */
    it('does not leak a binding to a member of a different project', async () => {
        const victim = await createTestContext(app!)
        const attacker = await createTestContext(app!)
        const binding = await saveBinding(victim, TriggerBindingStatus.ENABLED)

        const response = await attacker.get(`/v1/trigger-bindings/${binding.id}`)

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(response?.payload).not.toContain(binding.id)
    })
})
