import { tryCatch } from '@inboxfm-connect/core-utils'
import { ExecutionEvent, ExecutionEventType } from '@inboxfm-connect/shared'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { __resetMemoryTtlSweepForTests, executionEventService } from '../../../../src/app/execution/execution-event.service'
import { pubsub } from '../../../../src/app/helper/pubsub'

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitUntil: condition not met within timeout')
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

describe('ExecutionEvent Service', () => {
    describe('parseSequenceFromId', () => {
        it('parses valid event ID sequence', () => {
            const seq = executionEventService.parseSequenceFromId({ eventId: 'exec_123:42' })
            expect(seq).toBe(42)
        })

        it('returns null for invalid or empty event ID', () => {
            expect(executionEventService.parseSequenceFromId({ eventId: undefined })).toBeNull()
            expect(executionEventService.parseSequenceFromId({ eventId: 'invalid' })).toBeNull()
        })
    })

    describe('Monotonic Sequence & History Replay', () => {
        it('emits events with monotonic IDs and replays since lastEventId', async () => {
            const executionId = 'exec_test_replay'

            const event1 = await executionEventService.emit({
                executionId,
                type: ExecutionEventType.ExecutionStarted,
                payload: { executionId, prompt: 'hello', timestamp: new Date().toISOString() },
            })

            const event2 = await executionEventService.emit({
                executionId,
                type: ExecutionEventType.PlannerStarted,
                payload: { executionId, model: 'gpt-4o', timestamp: new Date().toISOString() },
            })

            const event3 = await executionEventService.emit({
                executionId,
                type: ExecutionEventType.ExecutionCompleted,
                payload: { executionId, output: { success: true } },
            })

            expect(event1.id).toContain(':')
            expect(event2.id).toContain(':')
            expect(event3.id).toContain(':')

            const seq1 = executionEventService.parseSequenceFromId({ eventId: event1.id })!
            const seq2 = executionEventService.parseSequenceFromId({ eventId: event2.id })!
            const seq3 = executionEventService.parseSequenceFromId({ eventId: event3.id })!

            expect(seq2).toBeGreaterThan(seq1)
            expect(seq3).toBeGreaterThan(seq2)

            const replayed = await executionEventService.getEventsSince({
                executionId,
                lastEventId: event1.id,
            })

            expect(replayed.length).toBe(2)
            expect(replayed[0].id).toBe(event2.id)
            expect(replayed[1].id).toBe(event3.id)
        })
    })

    describe('Cross-replica delivery via Redis pub/sub', () => {
        it('delivers an event published on the pub/sub channel directly, independent of the emitting process\'s in-memory listener map', async () => {
            const executionId = 'exec_test_cross_replica'
            const received: ExecutionEvent[] = []

            await executionEventService.subscribe({
                executionId,
                listener: (event) => received.push(event),
            })

            // Bypasses `emit()`'s local `memoryListeners` notification entirely — this is
            // the same channel a completion signal published from a *different* app
            // replica would use, so a subscriber that only shares Redis with the
            // publisher (not process memory) must still receive it.
            const crossReplicaEvent: ExecutionEvent = {
                id: `${executionId}:999`,
                executionId,
                type: ExecutionEventType.ExecutionCompleted,
                timestamp: new Date().toISOString(),
                payload: { executionId, output: { success: true } },
            }
            const { error: publishError } = await tryCatch(() => pubsub.publish(`execution:${executionId}:events`, JSON.stringify(crossReplicaEvent)))

            if (publishError) {
                // No Redis reachable in this run (matches `execution-event.service.ts`'s own
                // "offline unit tests" fallback) — nothing to assert about cross-replica
                // delivery without a real pub/sub backend.
                await executionEventService.unsubscribe({ executionId })
                return
            }

            await waitUntil(() => received.length === 1)

            expect(received[0].id).toBe(crossReplicaEvent.id)
            expect(received[0].type).toBe(ExecutionEventType.ExecutionCompleted)

            await executionEventService.unsubscribe({ executionId })
        })

        it('delivers cross-replica events exactly once after a close-and-reconnect cycle', async () => {
            const executionId = 'exec_test_reconnect_cross_replica'
            const receivedViewer1: ExecutionEvent[] = []
            const receivedViewer2: ExecutionEvent[] = []

            const listener1 = (e: ExecutionEvent) => receivedViewer1.push(e)
            const listener2 = (e: ExecutionEvent) => receivedViewer2.push(e)

            // Viewer 1 subscribes
            await executionEventService.subscribe({
                executionId,
                listener: listener1,
            })

            // Viewer 1 disconnects (last listener tears down channel)
            await executionEventService.unsubscribe({
                executionId,
                listener: listener1,
            })

            // Viewer 2 subscribes (reconnect on same execution)
            await executionEventService.subscribe({
                executionId,
                listener: listener2,
            })

            const crossReplicaEvent: ExecutionEvent = {
                id: `${executionId}:1001`,
                executionId,
                type: ExecutionEventType.ExecutionCompleted,
                timestamp: new Date().toISOString(),
                payload: { executionId, output: { success: true } },
            }

            const { error: publishError } = await tryCatch(() => pubsub.publish(`execution:${executionId}:events`, JSON.stringify(crossReplicaEvent)))

            if (publishError) {
                await executionEventService.unsubscribe({ executionId, listener: listener2 })
                return
            }

            await waitUntil(() => receivedViewer2.length === 1)

            // Crucial: Viewer 2 receives exactly 1 event; Viewer 1 receives 0 events after disconnect
            expect(receivedViewer2).toHaveLength(1)
            expect(receivedViewer2[0].id).toBe(crossReplicaEvent.id)
            expect(receivedViewer1).toHaveLength(0)

            await executionEventService.unsubscribe({ executionId, listener: listener2 })
        })
    })

    describe('Multi-listener subscription isolation & lifecycle (#158)', () => {
        it('unsubscribes only the specified listener and keeps other listeners active', async () => {
            const executionId = 'exec_multi_listener_test'
            const eventsA: ExecutionEvent[] = []
            const eventsB: ExecutionEvent[] = []

            const listenerA = (e: ExecutionEvent) => eventsA.push(e)
            const listenerB = (e: ExecutionEvent) => eventsB.push(e)

            await executionEventService.subscribe({ executionId, listener: listenerA })
            await executionEventService.subscribe({ executionId, listener: listenerB })

            const event1 = await executionEventService.emit({
                executionId,
                type: ExecutionEventType.ExecutionStarted,
                payload: { executionId, step: 1 },
            })

            expect(eventsA).toHaveLength(1)
            expect(eventsB).toHaveLength(1)
            expect(eventsA[0].id).toBe(event1.id)
            expect(eventsB[0].id).toBe(event1.id)

            // Unsubscribe listener A only
            await executionEventService.unsubscribe({ executionId, listener: listenerA })

            const event2 = await executionEventService.emit({
                executionId,
                type: ExecutionEventType.PlannerStarted,
                payload: { executionId, step: 2 },
            })

            // Listener A did not receive event 2; Listener B received both events
            expect(eventsA).toHaveLength(1)
            expect(eventsB).toHaveLength(2)
            expect(eventsB[1].id).toBe(event2.id)

            // Unsubscribe listener B
            await executionEventService.unsubscribe({ executionId, listener: listenerB })

            await executionEventService.emit({
                executionId,
                type: ExecutionEventType.ExecutionCompleted,
                payload: { executionId, step: 3 },
            })

            // Neither received event 3
            expect(eventsA).toHaveLength(1)
            expect(eventsB).toHaveLength(2)
        })

        it('unsubscribing without listener reference clears all listeners', async () => {
            const executionId = 'exec_clear_all_test'
            const eventsA: ExecutionEvent[] = []
            const eventsB: ExecutionEvent[] = []

            const listenerA = (e: ExecutionEvent) => eventsA.push(e)
            const listenerB = (e: ExecutionEvent) => eventsB.push(e)

            await executionEventService.subscribe({ executionId, listener: listenerA })
            await executionEventService.subscribe({ executionId, listener: listenerB })

            await executionEventService.unsubscribe({ executionId })

            await executionEventService.emit({
                executionId,
                type: ExecutionEventType.ExecutionStarted,
                payload: { executionId },
            })

            expect(eventsA).toHaveLength(0)
            expect(eventsB).toHaveLength(0)
        })
    })

    describe('Forbidden Graph Fields Audit', () => {
        it('ensures ExecutionEvent schema contains zero graph/workflow fields', () => {
            const keys = Object.keys(ExecutionEvent.shape)
            const forbiddenKeys = [
                'flowId',
                'flowVersionId',
                'flowRunId',
                'stepName',
                'stepIndex',
                'nodeId',
                'routerPath',
                'loopIteration',
            ]

            for (const forbiddenKey of forbiddenKeys) {
                expect(keys).not.toContain(forbiddenKey)
            }
        })
    })
})


// Force the memory fallback deterministically (codeant finding on #393):
// with a live Redis the suite would exercise the Redis path instead, and
// the cap/eviction behavior under test would never run.
import { redisConnections } from '../../../../src/app/database/redis-connections'

describe('memory fallback eviction (issue #392)', () => {
    beforeEach(() => {
        vi.spyOn(redisConnections, 'useExisting').mockRejectedValue(new Error('redis unavailable (test)'))
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('critical events still land past the cap but never grow the list unbounded', async () => {
        const executionId = 'exec_critical_cap_test'
        const criticalType = ExecutionEventType.ExecutionCompleted
        // fill past the cap with non-critical events; the cap drops them at 1000
        for (let i = 0; i < 1005; i++) {
            await executionEventService.emit({
                executionId,
                type: ExecutionEventType.PlannerStarted,
                payload: { i },
            })
        }
        const before = await executionEventService.readEventHistory({ executionId })
        expect(before.length).toBe(1000)
        // critical events must land even when the list is at the cap
        const critical = await executionEventService.emit({
            executionId,
            type: criticalType,
            payload: { done: true },
        })
        const after = await executionEventService.readEventHistory({ executionId })
        expect(after.some((e) => e.id === critical.id)).toBe(true)
        // and the list must not have grown: oldest non-critical was dropped
        expect(after.length).toBe(1000)
    })

    it('sweeps memory-fallback history once the TTL elapses (fake timers, issue #392)', async () => {
        __resetMemoryTtlSweepForTests()
        vi.useFakeTimers()
        try {
            const executionId = 'exec_ttl_sweep_test'
            await executionEventService.emit({
                executionId,
                type: ExecutionEventType.PlannerStarted,
                payload: { i: 0 },
            })
            const fresh = await executionEventService.readEventHistory({ executionId })
            expect(fresh).toHaveLength(1)

            // advance past EVENT_TTL_SECONDS + one sweep interval: the interval
            // fires ~61 times, and every tick after the TTL sees lastActivity
            // older than the cutoff and evicts history, sequence and mutex state
            await vi.advanceTimersByTimeAsync(3600_000 + 60_000)

            const swept = await executionEventService.readEventHistory({ executionId })
            expect(swept).toHaveLength(0)
        } finally {
            __resetMemoryTtlSweepForTests()
            vi.useRealTimers()
            __resetMemoryTtlSweepForTests()
        }
    })
})

describe('memory fallback history isolation', () => {
    beforeEach(() => {
        vi.spyOn(redisConnections, 'useExisting').mockRejectedValue(new Error('redis unavailable (test)'))
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('does not let a later emit mutate a snapshot a caller is still holding', async () => {
        const executionId = 'exec_snapshot_isolation_test'
        await executionEventService.emit({
            executionId,
            type: ExecutionEventType.PlannerStarted,
            payload: { i: 0 },
        })

        // getEventsSince with no lastEventId forwards readEventHistory's result
        // verbatim - this is the array the SSE backfill serializes.
        const snapshot = await executionEventService.getEventsSince({ executionId })
        expect(snapshot).toHaveLength(1)

        await executionEventService.emit({
            executionId,
            type: ExecutionEventType.ExecutionCompleted,
            payload: { done: true },
        })

        // The already-returned snapshot must not grow behind the caller's back.
        expect(snapshot).toHaveLength(1)

        const fresh = await executionEventService.getEventsSince({ executionId })
        expect(fresh).toHaveLength(2)
    })

    it('does not let a caller corrupt stored history by mutating the returned array', async () => {
        const executionId = 'exec_caller_mutation_test'
        await executionEventService.emit({
            executionId,
            type: ExecutionEventType.PlannerStarted,
            payload: { i: 0 },
        })

        const borrowed = await executionEventService.readEventHistory({ executionId })
        borrowed.length = 0

        const stored = await executionEventService.readEventHistory({ executionId })
        expect(stored).toHaveLength(1)
    })

    it('returns a distinct array on every read', async () => {
        const executionId = 'exec_distinct_snapshot_test'
        await executionEventService.emit({
            executionId,
            type: ExecutionEventType.PlannerStarted,
            payload: { i: 0 },
        })

        const first = await executionEventService.readEventHistory({ executionId })
        const second = await executionEventService.readEventHistory({ executionId })

        expect(first).not.toBe(second)
    })
})
