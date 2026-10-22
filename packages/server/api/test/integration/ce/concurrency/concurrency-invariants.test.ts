import { apId } from '@inboxfm-connect/core-utils'
import { ExecutionStatus, ScheduledTaskStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { ExecutionEntity } from '../../../../src/app/execution/execution-entity'
import { ScheduledTaskEntity, ScheduledTaskSchema } from '../../../../src/app/execution/scheduled-task/scheduled-task-entity'
import { StoreEntryEntity } from '../../../../src/app/store-entry/store-entry-entity'
import { storeEntryService } from '../../../../src/app/store-entry/store-entry.service'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'
import { ConcurrencyBarrier, ParallelWorkerHarness, SimulatedWorker } from './concurrency-test-harness'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(async () => {
    vi.restoreAllMocks()
    const redis = await redisConnections.useExisting()
    const keys = await redis.keys('concurrency-test:*')
    if (keys.length > 0) {
        await redis.del(...keys)
    }
})

describe('Concurrency Invariants & Parallel-Worker Regression Suite (#146)', () => {
    let ctx: TestContext
    let harness: ParallelWorkerHarness

    beforeEach(async () => {
        ctx = await createTestContext(app!)
        harness = ParallelWorkerHarness.create(app!.log)
    })

    describe('Parallel-Worker Test Harness', () => {
        it('spawns two simulated workers operating against the same shared database', async () => {
            expect(harness.workerA.id).toBe('worker-node-alpha')
            expect(harness.workerB.id).toBe('worker-node-beta')

            const [resultA, resultB] = await harness.runParallel(
                async (worker, barrier) => {
                    await barrier.wait()
                    return `${worker.id}:ready`
                },
                async (worker, barrier) => {
                    await barrier.wait()
                    return `${worker.id}:ready`
                },
            )

            expect(resultA).toBe('worker-node-alpha:ready')
            expect(resultB).toBe('worker-node-beta:ready')
        })
    })

    describe('Store-Entry Upsert Under Contention (No Lost Updates)', () => {
        it('handles 40 concurrent upserts to the exact same key without database collision or duplicate rows', async () => {
            const key = `contended-key-${apId()}`

            // Worker A and Worker B concurrently issue 20 upserts each
            const [resultsA, resultsB] = await harness.runParallel(
                async (worker, barrier) => {
                    await barrier.wait()
                    const res = []
                    for (let i = 0; i < 20; i++) {
                        res.push(await storeEntryService.upsert({
                            projectId: ctx.project.id,
                            request: {
                                key,
                                value: { worker: worker.id, iteration: i, timestamp: Date.now() },
                            },
                        }))
                    }
                    return res
                },
                async (worker, barrier) => {
                    await barrier.wait()
                    const res = []
                    for (let i = 0; i < 20; i++) {
                        res.push(await storeEntryService.upsert({
                            projectId: ctx.project.id,
                            request: {
                                key,
                                value: { worker: worker.id, iteration: i, timestamp: Date.now() },
                            },
                        }))
                    }
                    return res
                },
            )

            expect(resultsA.length).toBe(20)
            expect(resultsB.length).toBe(20)
            expect(resultsA.every(r => r !== null)).toBe(true)
            expect(resultsB.every(r => r !== null)).toBe(true)

            // Verify final state in database: exactly ONE row exists for (projectId, key)
            const ds = databaseConnection()
            const rows = await ds.query(
                'SELECT * FROM "store-entry" WHERE "projectId" = $1 AND "key" = $2',
                [ctx.project.id, key],
            )

            expect(rows.length).toBe(1)
            expect(rows[0].key).toBe(key)
            expect(rows[0].projectId).toBe(ctx.project.id)
            expect(typeof rows[0].value).toBe('object')
        })

        it('preserves all updates across interleaved disjoint keys under high concurrency', async () => {
            const prefix = `disjoint-${apId()}`

            await harness.runParallel(
                async (worker, barrier) => {
                    await barrier.wait()
                    for (let i = 0; i < 15; i++) {
                        await storeEntryService.upsert({
                            projectId: ctx.project.id,
                            request: {
                                key: `${prefix}-a-${i}`,
                                value: { n: i },
                            },
                        })
                    }
                },
                async (worker, barrier) => {
                    await barrier.wait()
                    for (let i = 0; i < 15; i++) {
                        await storeEntryService.upsert({
                            projectId: ctx.project.id,
                            request: {
                                key: `${prefix}-b-${i}`,
                                value: { n: i },
                            },
                        })
                    }
                },
            )

            const ds = databaseConnection()
            const rows = await ds.query(
                'SELECT * FROM "store-entry" WHERE "projectId" = $1 AND "key" LIKE $2',
                [ctx.project.id, `${prefix}-%`],
            )

            // Total 30 disjoint keys must all be persisted without any loss
            expect(rows.length).toBe(30)
        })

        it('guarantees atomic read-modify-write counter increments via distributedLock (Zero Lost Updates)', async () => {
            const counterKey = `counter-${apId()}`
            const lockKey = `concurrency-test:lock:${counterKey}`

            // Initialize counter to 0
            await storeEntryService.upsert({
                projectId: ctx.project.id,
                request: { key: counterKey, value: { count: 0 } },
            })

            const INCREMENTS_PER_WORKER = 15

            // Both workers increment the counter concurrently under distributed lock
            await harness.runParallel(
                async (worker, barrier) => {
                    await barrier.wait()
                    for (let i = 0; i < INCREMENTS_PER_WORKER; i++) {
                        await worker.getLock().runExclusive({
                            key: lockKey,
                            fn: async () => {
                                const current = await storeEntryService.getOne({
                                    projectId: ctx.project.id,
                                    key: counterKey,
                                })
                                const currentVal = (current?.value as { count: number })?.count ?? 0
                                await storeEntryService.upsert({
                                    projectId: ctx.project.id,
                                    request: {
                                        key: counterKey,
                                        value: { count: currentVal + 1 },
                                    },
                                })
                            },
                        })
                    }
                },
                async (worker, barrier) => {
                    await barrier.wait()
                    for (let i = 0; i < INCREMENTS_PER_WORKER; i++) {
                        await worker.getLock().runExclusive({
                            key: lockKey,
                            fn: async () => {
                                const current = await storeEntryService.getOne({
                                    projectId: ctx.project.id,
                                    key: counterKey,
                                })
                                const currentVal = (current?.value as { count: number })?.count ?? 0
                                await storeEntryService.upsert({
                                    projectId: ctx.project.id,
                                    request: {
                                        key: counterKey,
                                        value: { count: currentVal + 1 },
                                    },
                                })
                            },
                        })
                    }
                },
            )

            // Verify final counter value
            const finalEntry = await storeEntryService.getOne({
                projectId: ctx.project.id,
                key: counterKey,
            })

            const finalCount = (finalEntry?.value as { count: number })?.count
            // Expected: exactly 15 + 15 = 30 increments without a single lost update
            expect(finalCount).toBe(INCREMENTS_PER_WORKER * 2)
        })
    })

    describe('Flow-Run Enqueue: Duplicate Submissions Deduplication (Exactly One Execution)', () => {
        /**
         * Simulates an idempotent multi-server flow-run enqueue helper that guards against
         * double-execution using Redis distributed lock & deduplication key.
         */
        async function enqueueDeduplicatedFlowRun({
            worker,
            projectId,
            platformId,
            dedupKey,
        }: {
            worker: SimulatedWorker
            projectId: string
            platformId: string
            dedupKey: string
        }): Promise<{ enqueued: boolean, duplicate: boolean, executionId: string }> {
            const redis = await redisConnections.useExisting()
            const redisDedupKey = `concurrency-test:dedup:${dedupKey}`
            const lockKey = `concurrency-test:lock:${dedupKey}`

            return worker.getLock().runExclusive({
                key: lockKey,
                fn: async () => {
                    // Check if this dedupKey was already processed/enqueued
                    const existingExecutionId = await redis.get(redisDedupKey)
                    if (existingExecutionId) {
                        return {
                            enqueued: false,
                            duplicate: true,
                            executionId: existingExecutionId,
                        }
                    }

                    // Enqueue: Create execution record in database
                    const executionRepo = databaseConnection().getRepository(ExecutionEntity)
                    const executionId = apId()
                    const now = new Date().toISOString()

                    // Atomically claim the dedup slot first in Redis with TTL before persisting
                    const acquired = await redis.set(redisDedupKey, executionId, 'NX', 'EX', 300)
                    if (!acquired) {
                        const winnerId = (await redis.get(redisDedupKey)) ?? executionId
                        return {
                            enqueued: false,
                            duplicate: true,
                            executionId: winnerId,
                        }
                    }

                    try {
                        await executionRepo.insert({
                            id: executionId,
                            created: now,
                            updated: now,
                            projectId,
                            platformId,
                            status: ExecutionStatus.RUNNING,
                            prompt: `Webhook run for ${dedupKey}`,
                            metadata: { dedupKey },
                        })
                    }
                    catch (err) {
                        // Rollback Redis reservation if database insertion fails
                        await redis.del(redisDedupKey)
                        throw err
                    }

                    return {
                        enqueued: true,
                        duplicate: false,
                        executionId,
                    }
                },
            })
        }

        it('deduplicates simultaneous identical flow-run enqueue submissions to exactly one execution', async () => {
            const dedupKey = `webhook-event-stripe-${apId()}`

            // Worker A and Worker B fire submissions for the exact same event at the exact same time
            const [resA, resB] = await harness.runParallel(
                async (worker, barrier) => {
                    await barrier.wait()
                    return enqueueDeduplicatedFlowRun({
                        worker,
                        projectId: ctx.project.id,
                        platformId: ctx.platform.id,
                        dedupKey,
                    })
                },
                async (worker, barrier) => {
                    await barrier.wait()
                    return enqueueDeduplicatedFlowRun({
                        worker,
                        projectId: ctx.project.id,
                        platformId: ctx.platform.id,
                        dedupKey,
                    })
                },
            )

            // One worker must have enqueued the execution, the other must have deduped it
            const enqueuedResults = [resA, resB].filter(r => r.enqueued)
            const duplicateResults = [resA, resB].filter(r => r.duplicate)

            expect(enqueuedResults.length).toBe(1)
            expect(duplicateResults.length).toBe(1)

            // Both workers agree on the same canonical executionId
            expect(resA.executionId).toBe(resB.executionId)

            // Verify in the database: exactly ONE execution row exists for this executionId
            const executionRepo = databaseConnection().getRepository(ExecutionEntity)
            const executions = await executionRepo.findBy({
                id: resA.executionId,
            })

            expect(executions.length).toBe(1)
            expect(executions[0].id).toBe(resA.executionId)
        })
    })

    describe('FOR UPDATE SKIP LOCKED Path Under Contention', () => {
        async function seedPendingScheduledTasks(count: number): Promise<string[]> {
            const taskRepo = databaseConnection().getRepository(ScheduledTaskEntity)
            const ids: string[] = []
            const now = new Date().toISOString()

            for (let i = 0; i < count; i++) {
                const id = apId()
                ids.push(id)
                await taskRepo.insert({
                    id,
                    created: now,
                    updated: now,
                    projectId: ctx.project.id,
                    platformId: ctx.platform.id,
                    cronExpression: '* * * * *',
                    timezone: 'UTC',
                    status: ScheduledTaskStatus.ENABLED,
                    nextRunAt: now,
                    prompt: 'Tick task prompt',
                })
            }
            return ids
        }

        it('allows two concurrent workers to claim distinct tasks using FOR UPDATE SKIP LOCKED without blocking', async () => {
            // Seed two pending tasks
            const [taskId1, taskId2] = await seedPendingScheduledTasks(2)

            // Worker A and Worker B concurrently claim tasks with FOR UPDATE SKIP LOCKED
            const [claimA, claimB] = await harness.runParallel(
                async (worker, barrier) => {
                    return worker.withTransaction(async (qr) => {
                        await barrier.wait()
                        const task = await worker.claimWithSkipLocked<ScheduledTaskSchema>({
                            queryRunner: qr,
                            entity: ScheduledTaskEntity,
                            alias: 'task',
                            where: (qb) => qb.where('task.status = :status AND task.id IN (:...ids)', {
                                status: ScheduledTaskStatus.ENABLED,
                                ids: [taskId1, taskId2],
                            }),
                        })

                        if (task) {
                            // Mark task claimed in this worker's transaction
                            await qr.manager.update(ScheduledTaskEntity, { id: task.id }, {
                                status: ScheduledTaskStatus.DISABLED,
                            })
                        }
                        return task ? task.id : null
                    })
                },
                async (worker, barrier) => {
                    return worker.withTransaction(async (qr) => {
                        await barrier.wait()
                        const task = await worker.claimWithSkipLocked<ScheduledTaskSchema>({
                            queryRunner: qr,
                            entity: ScheduledTaskEntity,
                            alias: 'task',
                            where: (qb) => qb.where('task.status = :status AND task.id IN (:...ids)', {
                                status: ScheduledTaskStatus.ENABLED,
                                ids: [taskId1, taskId2],
                            }),
                        })

                        if (task) {
                            // Mark task claimed in this worker's transaction
                            await qr.manager.update(ScheduledTaskEntity, { id: task.id }, {
                                status: ScheduledTaskStatus.DISABLED,
                            })
                        }
                        return task ? task.id : null
                    })
                },
            )

            // Both workers should have successfully claimed a task
            expect(claimA).not.toBeNull()
            expect(claimB).not.toBeNull()

            // Invariant: The two workers MUST have claimed two distinct tasks (zero double-claiming)
            expect(claimA).not.toBe(claimB)
            expect([taskId1, taskId2]).toContain(claimA)
            expect([taskId1, taskId2]).toContain(claimB)

            // Both tasks are now marked as DISABLED in the database
            const taskRepo = databaseConnection().getRepository(ScheduledTaskEntity)
            const updated1 = await taskRepo.findOneBy({ id: taskId1 })
            const updated2 = await taskRepo.findOneBy({ id: taskId2 })
            expect(updated1?.status).toBe(ScheduledTaskStatus.DISABLED)
            expect(updated2?.status).toBe(ScheduledTaskStatus.DISABLED)
        })

        it('skips already-locked row when only one task is available, avoiding deadlock or double-execution', async () => {
            // Seed exactly one pending task
            const [singleTaskId] = await seedPendingScheduledTasks(1)

            const [claimA, claimB] = await harness.runParallel(
                async (worker, barrier) => {
                    return worker.withTransaction(async (qr) => {
                        await barrier.wait()
                        const task = await worker.claimWithSkipLocked<ScheduledTaskSchema>({
                            queryRunner: qr,
                            entity: ScheduledTaskEntity,
                            alias: 'task',
                            where: (qb) => qb.where('task.status = :status AND task.id = :id', {
                                status: ScheduledTaskStatus.ENABLED,
                                id: singleTaskId,
                            }),
                        })

                        if (task) {
                            await qr.manager.update(ScheduledTaskEntity, { id: task.id }, {
                                status: ScheduledTaskStatus.DISABLED,
                            })
                        }
                        return task ? task.id : null
                    })
                },
                async (worker, barrier) => {
                    return worker.withTransaction(async (qr) => {
                        await barrier.wait()
                        const task = await worker.claimWithSkipLocked<ScheduledTaskSchema>({
                            queryRunner: qr,
                            entity: ScheduledTaskEntity,
                            alias: 'task',
                            where: (qb) => qb.where('task.status = :status AND task.id = :id', {
                                status: ScheduledTaskStatus.ENABLED,
                                id: singleTaskId,
                            }),
                        })

                        if (task) {
                            await qr.manager.update(ScheduledTaskEntity, { id: task.id }, {
                                status: ScheduledTaskStatus.DISABLED,
                            })
                        }
                        return task ? task.id : null
                    })
                },
            )

            // Exactly one worker claimed the single task; the other received null because the row was locked
            const claimed = [claimA, claimB].filter(c => c !== null)
            const skipped = [claimA, claimB].filter(c => c === null)

            expect(claimed.length).toBe(1)
            expect(skipped.length).toBe(1)
            expect(claimed[0]).toBe(singleTaskId)

            // The task in DB is marked as DISABLED by the winning worker
            const taskRepo = databaseConnection().getRepository(ScheduledTaskEntity)
            const updated = await taskRepo.findOneBy({ id: singleTaskId })
            expect(updated?.status).toBe(ScheduledTaskStatus.DISABLED)
        })
    })

    describe('DistributedLock Mutual Exclusion Invariant', () => {
        it('enforces serial execution of concurrent critical sections across simulated workers', async () => {
            const mutexKey = `concurrency-test:mutex:${apId()}`
            const events: string[] = []

            await harness.runParallel(
                async (worker, barrier) => {
                    await barrier.wait()
                    await worker.getLock().runExclusive({
                        key: mutexKey,
                        fn: async () => {
                            events.push('worker-a:enter')
                            await new Promise(resolve => setTimeout(resolve, 50))
                            events.push('worker-a:exit')
                        },
                    })
                },
                async (worker, barrier) => {
                    await barrier.wait()
                    await worker.getLock().runExclusive({
                        key: mutexKey,
                        fn: async () => {
                            events.push('worker-b:enter')
                            await new Promise(resolve => setTimeout(resolve, 50))
                            events.push('worker-b:exit')
                        },
                    })
                },
            )

            // Invariant: The critical sections must NOT interleave
            // Valid ordering: enter -> exit -> enter -> exit
            expect(events.length).toBe(4)
            expect(
                (events[0] === 'worker-a:enter' && events[1] === 'worker-a:exit' && events[2] === 'worker-b:enter' && events[3] === 'worker-b:exit') ||
                (events[0] === 'worker-b:enter' && events[1] === 'worker-b:exit' && events[2] === 'worker-a:enter' && events[3] === 'worker-a:exit'),
            ).toBe(true)
        })
    })
})
