import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFind = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        find: mockFind,
    }),
}))

beforeEach(() => {
    vi.clearAllMocks()
})

const { fieldService } = await import('../../../../../src/app/tables/field/field.service')

describe('fieldService.getAllByTableIds (unit)', () => {
    it('returns an empty Map immediately when tableIds is empty without querying repository', async () => {
        const result = await fieldService.getAllByTableIds({ projectId: 'proj_123', tableIds: [] })
        expect(result).toBeInstanceOf(Map)
        expect(result.size).toBe(0)
        expect(mockFind).not.toHaveBeenCalled()
    })

    it('returns an empty Map immediately when tableIds is nil', async () => {
        // @ts-expect-error testing defensive check against invalid caller data
        const result = await fieldService.getAllByTableIds({ projectId: 'proj_123', tableIds: null })
        expect(result).toBeInstanceOf(Map)
        expect(result.size).toBe(0)
        expect(mockFind).not.toHaveBeenCalled()
    })
})
