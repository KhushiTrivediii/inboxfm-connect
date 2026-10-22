import { apId, isNil, sanitizeObjectForPostgresql } from '@inboxfm-connect/core-utils'
import { CRITICAL_EXECUTION_EVENT_TYPES, ExecutionEvent, ExecutionEventType } from '@inboxfm-connect/shared'
import { Mutex } from 'async-mutex'
import { redisConnections } from '../database/redis-connections'
import { pubsub } from '../helper/pubsub'

const instanceId = apId()
const memorySequences = new Map<string, number>()
const memoryHistory = new Map<string, ExecutionEvent[]>()
const memoryLastActivity = new Map<string, number>()
let memorySweepTimer: NodeJS.Timeout | undefined
const memoryListeners = new Map<string, Set<(event: ExecutionEvent) => void>>()
const executionSubscriptionMutexes = new Map<string, Mutex>()

function getExecutionSubscriptionMutex(executionId: string): Mutex {
    let mutex = executionSubscriptionMutexes.get(executionId)
    if (isNil(mutex)) {
        mutex = new Mutex()
        executionSubscriptionMutexes.set(executionId, mutex)
    }
    return mutex
}

// Critical events must land, but not grow the list without bound (issue #392):
// make room by dropping the oldest non-critical entry, then the absolute oldest
// if every survivor is critical.
function pickEvictionIndex({ events }: { events: ExecutionEvent[] }): number {
    const oldestNonCritical = events.findIndex((event) => !CRITICAL_EXECUTION_EVENT_TYPES.includes(event.type))
    return oldestNonCritical === -1 ? 0 : oldestNonCritical
}

const MAX_HISTORY_EVENTS = 1000

// Memory-fallback eviction (issue #392): the Redis path self-cleans via EXPIRE
// (EVENT_TTL_SECONDS). The memory fallback has no such timer, so entries for
// finished executions accumulate forever on Redis-less deployments. This sweep
// mirrors the Redis TTL instead of dropping state on last-unsubscribe — an
// unsubscribe-triggered eviction would delete the history a page-refresh
// subscribe (SSE backfill via readEventHistory) still expects to read.
const MEMORY_SWEEP_INTERVAL_MS = 60_000

function startMemoryTtlSweep(): void {
    if (memorySweepTimer !== undefined) {
        return
    }
    memorySweepTimer = setInterval(() => {
        const cutoff = Date.now() - EVENT_TTL_SECONDS * 1000
        for (const [executionId, lastActivity] of memoryLastActivity) {
            if (lastActivity < cutoff) {
                memoryHistory.delete(executionId)
                memorySequences.delete(executionId)
                memoryLastActivity.delete(executionId)
                executionSubscriptionMutexes.delete(executionId)
            }
        }
    }, MEMORY_SWEEP_INTERVAL_MS)
    memorySweepTimer.unref()
}
const EVENT_TTL_SECONDS = 3600

// Test seam for issue #392's fake-timer coverage: the sweep interval is a
// module-level singleton, so a test file that already emitted under real
// timers can't capture it with vi.useFakeTimers(). Clearing it lets the next
// emit register the interval against the active (faked) timer implementation.
export function __resetMemoryTtlSweepForTests(): void {
    if (memorySweepTimer !== undefined) {
        clearInterval(memorySweepTimer)
        memorySweepTimer = undefined
    }
}

const executionEventService = {
    async emit({
        executionId,
        type,
        payload,
    }: {
        executionId: string
        type: ExecutionEventType
        payload: Record<string, unknown>
    }): Promise<ExecutionEvent> {
        const sanitizedPayload = sanitizeObjectForPostgresql(payload)
        const timestamp = new Date().toISOString()

        const seq = await this.nextSequence({ executionId })
        const eventId = `${executionId}:${seq}`

        const event: ExecutionEvent = {
            id: eventId,
            executionId,
            type,
            timestamp,
            payload: sanitizedPayload,
        }

        await this.storeEventHistory({ event })

        // Notify in-memory listeners
        const localListeners = memoryListeners.get(executionId)
        if (!isNil(localListeners)) {
            for (const listener of localListeners) {
                try {
                    listener(event)
                }
                catch (err) {
                    // Ignore listener errors
                }
            }
        }

        // Publish via Redis pubsub if available
        try {
            await pubsub.publish(`execution:${executionId}:events`, JSON.stringify({
                publisherId: instanceId,
                event,
            }))
        }
        catch (err) {
            // Ignore pubsub failures when Redis is offline/unconfigured (e.g. unit test mode)
        }

        return event
    },

    async getEventsSince({
        executionId,
        lastEventId,
    }: {
        executionId: string
        lastEventId?: string | null
    }): Promise<ExecutionEvent[]> {
        const lastSeq = this.parseSequenceFromId({ eventId: lastEventId })
        const events = await this.readEventHistory({ executionId })

        if (isNil(lastSeq)) {
            return events
        }

        return events.filter((e) => {
            const seq = this.parseSequenceFromId({ eventId: e.id })
            return !isNil(seq) && seq > lastSeq
        })
    },

    async subscribe({
        executionId,
        listener,
    }: {
        executionId: string
        listener: (event: ExecutionEvent) => void
    }): Promise<void> {
        const mutex = getExecutionSubscriptionMutex(executionId)
        await mutex.runExclusive(async () => {
            let listeners = memoryListeners.get(executionId)
            if (isNil(listeners)) {
                listeners = new Set()
                memoryListeners.set(executionId, listeners)
            }
            const isFirstListener = listeners.size === 0
            listeners.add(listener)

            if (isFirstListener) {
                try {
                    await pubsub.subscribe(`execution:${executionId}:events`, (message) => {
                        try {
                            const parsed = JSON.parse(message)
                            const isEnvelope = parsed && typeof parsed === 'object' && 'event' in parsed
                            const publisherId = isEnvelope ? parsed.publisherId : null
                            const candidate = isEnvelope ? parsed.event : parsed
                            const validation = ExecutionEvent.safeParse(candidate)
                            if (!validation.success) {
                                return
                            }
                            const event = validation.data

                            if (publisherId === instanceId) {
                                return
                            }

                            const activeListeners = memoryListeners.get(executionId)
                            if (!isNil(activeListeners)) {
                                for (const activeListener of activeListeners) {
                                    try {
                                        activeListener(event)
                                    }
                                    catch (err) {
                                        // Ignore listener errors
                                    }
                                }
                            }
                        }
                        catch (err) {
                            // Ignore malformed messages
                        }
                    })
                }
                catch (err) {
                    // Pubsub unavailable in offline unit tests
                }
            }
        })
    },

    async unsubscribe({
        executionId,
        listener,
    }: {
        executionId: string
        listener?: (event: ExecutionEvent) => void
    }): Promise<void> {
        const mutex = getExecutionSubscriptionMutex(executionId)
        await mutex.runExclusive(async () => {
            if (!isNil(listener)) {
                const listeners = memoryListeners.get(executionId)
                if (!isNil(listeners)) {
                    listeners.delete(listener)
                    if (listeners.size === 0) {
                        memoryListeners.delete(executionId)
                        try {
                            await pubsub.unsubscribe(`execution:${executionId}:events`)
                        }
                        catch (err) {
                            // Ignore pubsub failures
                        }
                    }
                }
            }
            else {
                memoryListeners.delete(executionId)
                try {
                    await pubsub.unsubscribe(`execution:${executionId}:events`)
                }
                catch (err) {
                    // Ignore pubsub failures
                }
            }
        })
    },

    async nextSequence({ executionId }: { executionId: string }): Promise<number> {
        try {
            const redis = await redisConnections.useExisting()
            if (!isNil(redis)) {
                const seqKey = `execution:${executionId}:seq`
                const seq = await redis.incr(seqKey)
                await redis.expire(seqKey, EVENT_TTL_SECONDS)
                return seq
            }
        }
        catch (err) {
            // Fallback to memory
        }

        const current = memorySequences.get(executionId) ?? 0
        const next = current + 1
        memorySequences.set(executionId, next)
        return next
    },

    async storeEventHistory({ event }: { event: ExecutionEvent }): Promise<void> {
        const key = `execution:${event.executionId}:events`
        const isCritical = CRITICAL_EXECUTION_EVENT_TYPES.includes(event.type)

        try {
            const redis = await redisConnections.useExisting()
            if (!isNil(redis)) {
                const len = await redis.llen(key)
                if (len >= MAX_HISTORY_EVENTS && !isCritical) {
                    return
                }
                await redis.rpush(key, JSON.stringify(event))
                await redis.expire(key, EVENT_TTL_SECONDS)
                return
            }
        }
        catch (err) {
            // Fallback to memory
        }

        // Touch last-activity on every event (codeant finding on #393), including
        // discarded non-critical ones at the cap: an actively producing execution
        // must not be swept out and lose its fallback history while it is still
        // emitting — activity, not storage, drives the TTL.
        memoryLastActivity.set(event.executionId, Date.now())
        startMemoryTtlSweep()

        const stored = memoryHistory.get(event.executionId) ?? []
        if (stored.length >= MAX_HISTORY_EVENTS) {
            if (!isCritical) {
                return
            }
            const dropIndex = pickEvictionIndex({ events: stored })
            memoryHistory.set(event.executionId, [...stored.filter((_, index) => index !== dropIndex), event])
            return
        }
        // Replace the stored array instead of pushing onto it: readEventHistory hands
        // snapshots to callers (the SSE backfill), and an in-place push would let a later
        // emit mutate a snapshot that is still being held or serialized.
        memoryHistory.set(event.executionId, [...stored, event])
    },

    async readEventHistory({ executionId }: { executionId: string }): Promise<ExecutionEvent[]> {
        const key = `execution:${executionId}:events`
        try {
            const redis = await redisConnections.useExisting()
            if (!isNil(redis)) {
                const rawItems = await redis.lrange(key, 0, -1)
                return rawItems.map((raw) => JSON.parse(raw) as ExecutionEvent)
            }
        }
        catch (err) {
            // Fallback to memory
        }

        // Hand back a snapshot, never the stored array itself: getEventsSince forwards
        // this result straight to the SSE backfill, so returning the live reference
        // would let a concurrent emit mutate a response mid-serialization, and would
        // let a caller corrupt stored history by mutating what it was given. The
        // Redis branch above already builds a fresh array per call.
        return [...(memoryHistory.get(executionId) ?? [])]
    },

    parseSequenceFromId({ eventId }: { eventId?: string | null }): number | null {
        if (isNil(eventId)) return null
        const parts = eventId.split(':')
        if (parts.length < 2) return null
        const seq = parseInt(parts[parts.length - 1], 10)
        return isNaN(seq) ? null : seq
    },
}

export { executionEventService }
