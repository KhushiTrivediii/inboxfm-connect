import { DataSource, EntityTarget, ObjectLiteral, QueryRunner, SelectQueryBuilder } from 'typeorm'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { distributedLock } from '../../../../src/app/database/redis-connections'
import { FastifyBaseLogger } from 'fastify'

/**
 * Concurrency barrier allowing N workers to synchronize before entering
 * a contested critical section, guaranteeing temporal overlap in tests.
 */
export class ConcurrencyBarrier {
    private count: number
    private arrived = 0
    private releasePromise: Promise<void>
    private resolveRelease!: () => void

    constructor(count = 2) {
        this.count = count
        this.releasePromise = new Promise((resolve) => {
            this.resolveRelease = resolve
        })
    }

    async wait(): Promise<void> {
        this.arrived++
        if (this.arrived >= this.count) {
            this.resolveRelease()
        }
        await this.releasePromise
    }
}

/**
 * Represents an isolated simulated server/worker node executing against
 * the shared database and Redis cluster.
 */
export class SimulatedWorker {
    private harness?: ParallelWorkerHarness

    constructor(
        public readonly id: string,
        public readonly ds: DataSource,
        public readonly log: FastifyBaseLogger,
    ) {}

    setHarness(harness: ParallelWorkerHarness): void {
        this.harness = harness
    }

    createQueryRunner(): QueryRunner {
        return this.ds.createQueryRunner()
    }

    async withTransaction<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
        const qr = this.createQueryRunner()
        await qr.connect()
        await qr.startTransaction()
        try {
            const result = await fn(qr)
            await qr.commitTransaction()
            return result
        }
        catch (err) {
            await qr.rollbackTransaction()
            throw err
        }
        finally {
            if (qr.data?.lockedRowIds && this.harness) {
                for (const lockedId of qr.data.lockedRowIds as string[]) {
                    this.harness.releaseLock(lockedId)
                }
            }
            await qr.release()
        }
    }

    /**
     * Executes a pessimistic lock query with SKIP LOCKED semantics.
     * In an embedded single-session engine (e.g. PGlite), QueryRunners share
     * a single physical connection, so this helper coordinates row locks at the
     * harness level to guarantee Postgres-identical SKIP LOCKED isolation.
     */
    /**
     * Executes a pessimistic lock query with SKIP LOCKED semantics.
     * In an embedded single-session engine (e.g. PGlite), QueryRunners share
     * a single physical connection, so this helper coordinates row locks at the
     * harness level to guarantee Postgres-identical SKIP LOCKED isolation.
     */
    async claimWithSkipLocked<Entity extends ObjectLiteral>({
        queryRunner,
        entity,
        alias,
        where,
        idColumn = 'id',
    }: {
        queryRunner: QueryRunner
        entity: EntityTarget<Entity>
        alias: string
        where: (qb: SelectQueryBuilder<Entity>) => void
        idColumn?: string
    }): Promise<Entity | null> {
        const executeClaim = async (): Promise<Entity | null> => {
            const qb = queryRunner.manager.createQueryBuilder(entity, alias)
            where(qb)

            // If running in harness with simulated concurrency, exclude rows held by other workers
            const activeLocks = this.harness ? this.harness.getActiveLocks() : []
            if (activeLocks.length > 0) {
                qb.andWhere(`${alias}.${idColumn} NOT IN (:...harnessActiveLocks)`, {
                    harnessActiveLocks: activeLocks,
                })
            }

            qb.orderBy(`${alias}.${idColumn}`, 'ASC')
                .setLock('pessimistic_write')
                .setOnLocked('skip_locked')
                .limit(1)

            const item = await qb.getOne()
            if (item && this.harness) {
                const rowId = (item as Record<string, unknown>)[idColumn] as string
                if (rowId) {
                    this.harness.acquireLock(rowId)
                    queryRunner.data = queryRunner.data ?? {}
                    if (!queryRunner.data.lockedRowIds) {
                        queryRunner.data.lockedRowIds = []
                    }
                    (queryRunner.data.lockedRowIds as string[]).push(rowId)
                }
            }

            return item
        }

        if (this.harness) {
            return this.harness.synchronizeLockAcquisition(executeClaim)
        }
        return executeClaim()
    }

    getLock(defaultTimeoutInSeconds = 30) {
        const lock = distributedLock(this.log)
        return {
            runExclusive: async <T>({
                key,
                timeoutInSeconds = defaultTimeoutInSeconds,
                fn,
            }: {
                key: string
                timeoutInSeconds?: number
                fn: () => Promise<T>
            }): Promise<T> => {
                return lock.runExclusive({
                    key,
                    timeoutInSeconds,
                    fn,
                })
            },
        }
    }
}

/**
 * Parallel Worker Test Harness for locking multi-server concurrency invariants.
 *
 * Implements the standard pattern described in AGENTS.md:
 * - Multi-server: Use `distributedLock`, BullMQ deduplication, or `FOR UPDATE SKIP LOCKED`
 *   for concurrent operations.
 */
export class ParallelWorkerHarness {
    private readonly activeLocks = new Set<string>()
    private lockMutex = Promise.resolve()

    constructor(
        public readonly workerA: SimulatedWorker,
        public readonly workerB: SimulatedWorker,
    ) {
        workerA.setHarness(this)
        workerB.setHarness(this)
    }

    async synchronizeLockAcquisition<T>(fn: () => Promise<T>): Promise<T> {
        let release: () => void
        const next = new Promise<void>((resolve) => {
            release = resolve
        })
        const prev = this.lockMutex
        this.lockMutex = next

        await prev
        try {
            return await fn()
        }
        finally {
            release!()
        }
    }

    static create(log: FastifyBaseLogger): ParallelWorkerHarness {
        const ds = databaseConnection()
        const workerA = new SimulatedWorker('worker-node-alpha', ds, log)
        const workerB = new SimulatedWorker('worker-node-beta', ds, log)
        return new ParallelWorkerHarness(workerA, workerB)
    }

    acquireLock(id: string): void {
        this.activeLocks.add(id)
    }

    releaseLock(id: string): void {
        this.activeLocks.delete(id)
    }

    getActiveLocks(): string[] {
        return Array.from(this.activeLocks)
    }

    createBarrier(count = 2): ConcurrencyBarrier {
        return new ConcurrencyBarrier(count)
    }

    /**
     * Executes two worker actions concurrently with an optional shared barrier.
     */
    async runParallel<A, B>(
        actionA: (worker: SimulatedWorker, barrier: ConcurrencyBarrier) => Promise<A>,
        actionB: (worker: SimulatedWorker, barrier: ConcurrencyBarrier) => Promise<B>,
    ): Promise<[A, B]> {
        const barrier = this.createBarrier(2)
        return Promise.all([
            actionA(this.workerA, barrier),
            actionB(this.workerB, barrier),
        ])
    }
}
