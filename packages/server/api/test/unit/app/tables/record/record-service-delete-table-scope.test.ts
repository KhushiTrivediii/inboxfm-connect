import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFindOne = vi.fn()
const mockFind = vi.fn()
const mockDelete = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOne: mockFindOne,
        find: mockFind,
        delete: mockDelete,
    }),
}))

vi.mock('../../../../../src/app/core/db/transaction', () => ({
    transaction: async (fn: (em: unknown) => Promise<unknown>) => fn({}),
}))

vi.mock('../../../../../src/app/tables/field/field.service', () => ({
    fieldService: {
        getAllByTableIds: vi.fn(async ({ tableIds }: { tableIds: string[] }) =>
            new Map(tableIds.map((tableId) => [tableId, []]))),
        getAll: vi.fn(async () => []),
    },
}))

beforeEach(() => {
    vi.clearAllMocks()
})

const { recordService } = await import('../../../../../src/app/tables/record/record.service')

const ALL_RECORDS = [
    { id: 'rec_A1', tableId: 'tableA', cells: [] },
    { id: 'rec_B1', tableId: 'tableB', cells: [] },
]

describe('recordService.delete (unit)', () => {
    it('returns an empty array immediately when ids array is empty without querying the repository', async () => {
        const result = await recordService.delete({ ids: [], projectId: 'proj_123' })
        expect(result).toEqual([])
        expect(mockFindOne).not.toHaveBeenCalled()
        expect(mockFind).not.toHaveBeenCalled()
        expect(mockDelete).not.toHaveBeenCalled()
    })

    it('returns an empty array immediately when ids is undefined or null', async () => {
        // @ts-expect-error testing defensive check against invalid caller data
        const result = await recordService.delete({ ids: undefined, projectId: 'proj_123' })
        expect(result).toEqual([])
        expect(mockFindOne).not.toHaveBeenCalled()
        expect(mockFind).not.toHaveBeenCalled()
        expect(mockDelete).not.toHaveBeenCalled()
    })
})

describe('recordService.delete cross-table scoping (delete pinned the batch to ids[0] table)', () => {
    it('deletes every requested id across mixed tables instead of dropping rows from other tables', async () => {
        // ids[0] belongs to tableA, ids[1] belongs to tableB (same project).
        // The service used to resolve tableId from ids[0] and filter BOTH the
        // find and the delete on that single table - the tableB row was silently
        // dropped while the caller got a success shape for the whole batch.
        mockFind.mockImplementationOnce(async (criteria: { where: { id: { value: string[] } } }) => {
            const wanted = criteria.where.id.value
            return ALL_RECORDS.filter((r) => wanted.includes(r.id))
        })

        const result = await recordService.delete({
            ids: ['rec_A1', 'rec_B1'],
            projectId: 'proj_123',
        })

        // The resolved find must be table-agnostic (projectId only)
        expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ projectId: 'proj_123' }),
        }))

        // Per-table deletes must cover both tables
        const deletedScopes = mockDelete.mock.calls.map((call) => call[0])
        expect(deletedScopes).toContainEqual(expect.objectContaining({ tableId: 'tableA' }))
        expect(deletedScopes).toContainEqual(expect.objectContaining({ tableId: 'tableB' }))
        expect(result).toHaveLength(2)
    })

    it('pins the batch to the declared tableId when the caller supplies one', async () => {
        // The REST DeleteRecordsRequest contract carries a tableId; the security
        // middleware resolves the permission target from it, so the delete must
        // stay scoped to exactly that table.
        mockFind.mockImplementationOnce(async () => [{ id: 'rec_A1', tableId: 'tableA', cells: [] }])

        const result = await recordService.delete({
            ids: ['rec_A1', 'rec_B1'],
            projectId: 'proj_123',
            tableId: 'tableA',
        })

        // The find must be pinned to the declared table
        expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ tableId: 'tableA', projectId: 'proj_123' }),
        }))

        // Only tableA rows deleted; rec_B1 (a tableB row) must not be touched
        const deletedScopes = mockDelete.mock.calls.map((call) => call[0])
        expect(deletedScopes.every((scope) => scope.tableId === 'tableA')).toBe(true)
        expect(result).toHaveLength(1)
    })

    it('returns empty array when no id resolves to any record (no partial-batch error)', async () => {
        mockFind.mockImplementationOnce(async () => [])

        const result = await recordService.delete({
            ids: ['rec_missing_1', 'rec_missing_2'],
            projectId: 'proj_123',
        })

        expect(result).toEqual([])
        expect(mockDelete).not.toHaveBeenCalled()
    })
})
