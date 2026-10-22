import { ActivepiecesError } from '@inboxfm-connect/core-utils'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { system } from '../../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../../src/app/helper/system/system-props'

// Race regression (audit finding 5): recordService.create validated
// MAX_RECORDS_PER_TABLE with a count that ran outside the insert transaction -
// a pure check-then-act. Two concurrent batch creates both counted below the
// limit and both inserted, so the soft quota drifted by one racing batch.
//
// The fix serializes the count check with the insert behind a per-table
// distributedLock (the same writer serialization field.service relies on): the
// locked fn runs validateCount and the insert transaction together, so every
// create counts the rows the previous create committed. The tests mock RedLock
// semantics exactly like embed-subdomain-upsert-race.test.ts (realRunExclusive
// = no lock, serializingRunExclusive = what a real Redis-backed runExclusive
// guarantees) and back the count mock with the state the record inserts commit
// into, which is what makes the race observable in-process.

const mockFind = vi.fn()
const mockCount = vi.fn()
const mockInsert = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        find: mockFind,
        count: mockCount,
    }),
}))

vi.mock('../../../../../src/app/core/db/transaction', () => ({
    transaction: async (fn: (em: unknown) => Promise<unknown>) =>
        fn({
            getRepository: () => ({
                insert: mockInsert,
            }),
        }),
}))

vi.mock('../../../../../src/app/tables/field/field.service', () => ({
    fieldService: {
        getAll: vi.fn(async () => []),
        getAllByTableIds: vi.fn(async () => new Map()),
    },
}))

const mockRunExclusive = vi.fn()

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({
        runExclusive: mockRunExclusive,
    }),
}))

const MAX_RECORDS_PER_TABLE = 10
const PROJECT_ID = 'proj_1'
const TABLE_ID = 'table_1'

// Simulated table state: validateCount reads it, record inserts commit into it.
let committedRecords: number

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

// RedLock semantics: run the caller's fn under the lock, then release.
async function realRunExclusive<T>({ fn }: { fn: () => Promise<T> }): Promise<T> {
    return fn()
}

// Serializing RedLock semantics for the concurrency test: each locked fn only
// starts after the previous one fully settled (what runExclusive guarantees
// with a real Redis behind it).
let lockChain: Promise<unknown> = Promise.resolve()
async function serializingRunExclusive<T>({ fn }: { fn: () => Promise<T> }): Promise<T> {
    const run = lockChain.then(() => fn())
    lockChain = run.then(() => undefined, () => undefined)
    return run
}

// Record insertions carry a `created` column, cell insertions do not; the
// empty cell batches a cell-less create inserts commit zero rows.
async function insertCommitsRecordRows(rows: Array<Record<string, unknown>>): Promise<void> {
    if (rows.length > 0 && rows.every((row) => 'created' in row)) {
        committedRecords += rows.length
    }
}

function createRequest(tableId: string, recordCount: number): { tableId: string, records: Array<Array<{ fieldId: string, value: string | null }>> } {
    return {
        tableId,
        records: Array.from({ length: recordCount }, () => []),
    }
}

async function create(recordCount: number, tableId: string = TABLE_ID): Promise<unknown> {
    return recordService.create({
        request: createRequest(tableId, recordCount),
        projectId: PROJECT_ID,
        logger: mockLog,
        fields: [],
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(system, 'getNumberOrThrow').mockImplementation((prop: AppSystemProp) => {
        if (prop === AppSystemProp.MAX_RECORDS_PER_TABLE) {
            return MAX_RECORDS_PER_TABLE
        }
        throw new Error(`Unexpected system prop in test: ${prop}`)
    })
    mockRunExclusive.mockImplementation(realRunExclusive)
    mockCount.mockImplementation(async () => committedRecords)
    mockInsert.mockImplementation(insertCommitsRecordRows)
    mockFind.mockResolvedValue([])
    committedRecords = 0
})

const { recordService } = await import('../../../../../src/app/tables/record/record.service')

describe('recordService.create count race (audit finding 5)', () => {
    it('runs the quota check and the insert inside the same per-table lock', async () => {
        const events: string[] = []
        mockRunExclusive.mockImplementation(async ({ key, fn }: { key: string, fn: () => Promise<unknown> }) => {
            expect(key).toContain(TABLE_ID)
            events.push('lock-acquired')
            const result = await fn()
            events.push('lock-released')
            return result
        })
        mockCount.mockImplementation(async () => {
            events.push('count')
            return committedRecords
        })
        mockInsert.mockImplementation(async (rows: Array<Record<string, unknown>>) => {
            await insertCommitsRecordRows(rows)
            events.push('insert')
        })

        await create(2)

        // The count must happen INSIDE the lock, before the insert, with the
        // release only after both - that is the entire fix.
        expect(events).toEqual(['lock-acquired', 'count', 'insert', 'insert', 'lock-released'])
        expect(mockRunExclusive).toHaveBeenCalledTimes(1)
    })

    it('two racing creates at the quota boundary: only one batch lands and the loser still gets the existing VALIDATION error', async () => {
        mockRunExclusive.mockImplementation(serializingRunExclusive)
        // 8 committed + 2 per batch: each create fits alone, both together
        // exceed the limit - exactly the interleaving that used to slip both
        // batches past the check.
        committedRecords = 8

        const [winner, loser] = await Promise.allSettled([create(2), create(2)])

        expect(winner.status).toBe('fulfilled')
        expect(loser.status).toBe('rejected')
        if (loser.status !== 'rejected') {
            throw new Error(`expected the losing create to reject, got ${loser.status}`)
        }
        const reason = loser.reason
        expect(reason).toBeInstanceOf(ActivepiecesError)
        expect(reason).toMatchObject({
            error: {
                code: 'VALIDATION',
                params: { message: `Max records per table reached: ${MAX_RECORDS_PER_TABLE}` },
            },
        })
        // The quota held: one racing batch landed, never both.
        expect(committedRecords).toBe(MAX_RECORDS_PER_TABLE)
        // Only the winning batch inserted (its record + cell batches).
        expect(mockInsert).toHaveBeenCalledTimes(2)
    })

    it('still rejects an over-quota create with the same VALIDATION error before inserting anything', async () => {
        committedRecords = MAX_RECORDS_PER_TABLE

        await expect(create(1)).rejects.toMatchObject({
            error: {
                code: 'VALIDATION',
                params: { message: `Max records per table reached: ${MAX_RECORDS_PER_TABLE}` },
            },
        })
        expect(mockInsert).not.toHaveBeenCalled()
    })

    it('creates records under the quota and still returns the inserted records', async () => {
        const result = await create(2)

        expect(result).toEqual([])
        expect(committedRecords).toBe(2)
        expect(mockInsert).toHaveBeenCalledTimes(2)
    })

    it('locks per table: concurrent creates for different tables serialize on different lock keys', async () => {
        await Promise.allSettled([create(1, 'table_A'), create(1, 'table_B')])

        const keys = mockRunExclusive.mock.calls.map((call) => call[0].key)
        expect(keys).toHaveLength(2)
        expect(keys[0]).toContain('table_A')
        expect(keys[1]).toContain('table_B')
    })
})
