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

vi.mock('../../../../../src/app/tables/field/field.service', () => ({
    fieldService: {
        getAllByTableIds: vi.fn(async () => new Map()),
    },
}))

beforeEach(() => {
    vi.clearAllMocks()
})

const { recordService } = await import('../../../../../src/app/tables/record/record.service')

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
