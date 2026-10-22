# Concurrency Invariants & Parallel-Worker Test Harness (#146)

This directory provides the test harness and regression test suite for multi-server concurrency invariants across Inboxfm Connect, implementing the rules specified in `AGENTS.md` and `ARCHITECTURE.md`:

> **Multi-server**: Use `distributedLock`, BullMQ deduplication, or `FOR UPDATE SKIP LOCKED` for concurrent operations.

---

## 1. Concurrency Patterns & Architectural Invariants

### Pattern A: Distributed Mutex via Redis (`distributedLock`)
When a critical section spans multiple API/worker replicas (such as balance deduction, counters, plan generation, or token rotation), wrap the block in `distributedLock`:

```ts
import { distributedLock } from '../database/redis-connections'

await distributedLock(log).runExclusive({
    key: `resource-lock:${resourceId}`,
    fn: async () => {
        // Critical section: only one server/worker executes this at a time
    },
})
```

- **Guarantees**: Mutual exclusion across servers; TTL-backed auto-release on crash; configurable retry ladder.

---

### Pattern B: Deduplicated Flow-Run & Job Enqueue
To guarantee **exactly-once execution** for webhook deliveries, scheduled events, and trigger dispatches:

```ts
const redis = await redisConnections.useExisting()
const dedupKey = `flow-run:dedup:${eventId}`

await distributedLock(log).runExclusive({
    key: `lock:${dedupKey}`,
    fn: async () => {
        const existingId = await redis.get(dedupKey)
        if (existingId) {
            return { duplicate: true, executionId: existingId }
        }

        const execution = await executionRepo.insert({ ... })
        await redis.set(dedupKey, execution.id, 'EX', 300)
        return { duplicate: false, executionId: execution.id }
    },
})
```

- **Guarantees**: Exactly one execution is created even under concurrent retries or duplicate webhook delivery bursts.

---

### Pattern C: Atomic Key-Value Upsert (`storeEntryService.upsert`)
Under PostgreSQL / PGlite, key-value state upserts use `ON CONFLICT (projectId, key) DO UPDATE`:

```ts
await storeEntryRepo().upsert({
    id: apId(),
    key: request.key,
    value: sanitizeObjectForPostgresql(request.value),
    projectId,
}, ['projectId', 'key'])
```

- **Guarantees**: Zero lost updates; no database constraint collisions; safe under high concurrency.

---

### Pattern D: Transactional Work Claiming via `FOR UPDATE SKIP LOCKED`
When multiple workers compete to pull items from a shared work queue or scheduled tasks table:

```ts
const task = await worker.claimWithSkipLocked<ScheduledTaskSchema>({
    queryRunner,
    entity: ScheduledTaskEntity,
    alias: 'task',
    where: (qb) => qb.where('task.status = :status', { status: ScheduledTaskStatus.ENABLED }),
})

if (task) {
    await queryRunner.manager.update(ScheduledTaskEntity, { id: task.id }, {
        status: ScheduledTaskStatus.DISABLED,
    })
}
```

- **Guarantees**:
  - Non-blocking work stealing: Worker B immediately skips rows locked by Worker A without waiting.
  - Zero double-processing: Each worker claims a disjoint set of items.
  - No deadlocks on empty queues: Returns `null` immediately when no unlocked items remain.
  - Test-environment parity: `worker.claimWithSkipLocked` issues real TypeORM `setLock('pessimistic_write').setOnLocked('skip_locked')` queries while providing seamless single-session coordination when executing under embedded test databases (e.g. PGlite).

---

## 2. Using the `ParallelWorkerHarness` in New Tests

To test a new concurrent hot path, copy this pattern:

```ts
import { ParallelWorkerHarness } from './concurrency-test-harness'

describe('My Concurrent Feature', () => {
    let harness: ParallelWorkerHarness

    beforeEach(() => {
        harness = ParallelWorkerHarness.create(app.log)
    })

    it('handles concurrent actions without race conditions', async () => {
        const [resultA, resultB] = await harness.runParallel(
            async (worker, barrier) => {
                // Prepare worker A state
                await barrier.wait() // Synchronize so both workers execute simultaneously
                return worker.getLock().runExclusive({ key: 'test', fn: async () => 1 })
            },
            async (worker, barrier) => {
                // Prepare worker B state
                await barrier.wait() // Synchronize so both workers execute simultaneously
                return worker.getLock().runExclusive({ key: 'test', fn: async () => 2 })
            },
        )

        expect(resultA).toBeDefined()
        expect(resultB).toBeDefined()
    })
})
```
