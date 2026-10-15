import { ApplicationEvent, ApplicationEventName } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applicationEvents } from '../../../../src/app/helper/application-events'

// Listeners are module-global, so this file owns them in a fresh fork
// (vitest pool is maxForks: 1) — registering here can't pollute other files.
describe('application-events listener rejection containment', () => {
    let log: { error: vi.Mock, info: vi.Mock, debug: vi.Mock, warn: vi.Mock }
    let unhandled: unknown[]
    let onUnhandled: (reason: unknown) => void

    beforeEach(() => {
        log = {
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
        }
        unhandled = []
        onUnhandled = (reason: unknown) => unhandled.push(reason)
        process.on('unhandledRejection', onUnhandled)
    })

    afterEach(() => {
        process.off('unhandledRejection', onUnhandled)
        vi.restoreAllMocks()
    })

    async function flushMicrotasks(): Promise<void> {
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setImmediate(resolve))
        }
    }

    it('sendUserEvent logs, not crashes, when an async listener rejects', async () => {
        applicationEvents(log as unknown as FastifyBaseLogger).registerListeners(
            log as unknown as FastifyBaseLogger,
            {
                userEvent: () => async (): Promise<void> => {
                    throw new Error('listener boom')
                },
                workerEvent: () => async (): Promise<void> => {},
            },
        )

        applicationEvents(log as unknown as FastifyBaseLogger).sendUserEvent(
            { platformId: 'pl_test' },
            { action: ApplicationEventName.CONNECTION_UPSERTED, data: {} },
        )

        await flushMicrotasks()

        expect(log.error).toHaveBeenCalled()
        expect(unhandled).toEqual([])
    })

    it('sendWorkerEvent logs, not crashes, when an async listener rejects', async () => {
        applicationEvents(log as unknown as FastifyBaseLogger).registerListeners(
            log as unknown as FastifyBaseLogger,
            {
                userEvent: () => (): void => {},
                workerEvent: () => async (): Promise<void> => {
                    throw new Error('worker listener boom')
                },
            },
        )

        applicationEvents(log as unknown as FastifyBaseLogger).sendWorkerEvent({
            projectId: 'pj_test',
            platformId: 'pl_test',
            action: ApplicationEventName.CONNECTION_UPSERTED,
            data: {},
        })

        await flushMicrotasks()

        expect(log.error).toHaveBeenCalled()
        expect(unhandled).toEqual([])
    })

    it('still delivers to sync and async listeners on success', async () => {
        const received: ApplicationEvent[] = []
        const workerReceived: ApplicationEvent[] = []
        applicationEvents(log as unknown as FastifyBaseLogger).registerListeners(
            log as unknown as FastifyBaseLogger,
            {
                userEvent: () => async (event: ApplicationEvent): Promise<void> => {
                    received.push(event)
                },
                workerEvent: () => async (_projectId: string, event: ApplicationEvent): Promise<void> => {
                    workerReceived.push(event)
                },
            },
        )

        applicationEvents(log as unknown as FastifyBaseLogger).sendUserEvent(
            { platformId: 'pl_test' },
            { action: ApplicationEventName.CONNECTION_UPSERTED, data: {} },
        )
        applicationEvents(log as unknown as FastifyBaseLogger).sendWorkerEvent({
            projectId: 'pj_test',
            platformId: 'pl_test',
            action: ApplicationEventName.CONNECTION_DELETED,
            data: {},
        })

        await flushMicrotasks()

        // Listeners are module-global and push-only, so the rejecting listeners
        // registered by the two tests above are ALSO dispatched here — and must
        // be contained by the seam rather than escape as unhandled rejections.
        expect(received).toHaveLength(1)
        expect(received[0]?.action).toBe(ApplicationEventName.CONNECTION_UPSERTED)
        expect(workerReceived).toHaveLength(1)
        expect(workerReceived[0]?.action).toBe(ApplicationEventName.CONNECTION_DELETED)
        expect(unhandled).toEqual([])
    })
})
