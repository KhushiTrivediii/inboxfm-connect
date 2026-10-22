import { beforeEach, describe, expect, it, vi } from 'vitest'

type PieceTagInsertion = {
    id: string
    tagId: string
    pieceName: string
    platformId: string
}

const mockDelete = vi.fn(async () => undefined)
const mockUpsert = vi.fn(async (entities: PieceTagInsertion[], _conflictPaths: string[]) => {
    if (entities.length === 0) {
        throw new Error('Cannot insert empty array into database')
    }
    return undefined
})
const mockFindBy = vi.fn(async (_criteria: unknown) => [])

vi.mock('../../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        delete: mockDelete,
        upsert: mockUpsert,
        findBy: mockFindBy,
    }),
}))

const mockTagUpsert = vi.fn()
const mockConvertIdsToNames = vi.fn()
const mockFindNamesByIds = vi.fn()

vi.mock('../../../../../../src/app/pieces/tags/tag-service', () => ({
    tagService: {
        upsert: (...args: unknown[]) => mockTagUpsert(...args),
        convertIdsToNames: (...args: unknown[]) => mockConvertIdsToNames(...args),
        findNamesByIds: (...args: unknown[]) => mockFindNamesByIds(...args),
    },
}))

beforeEach(() => {
    vi.clearAllMocks()
})

const { pieceTagService } = await import('../../../../../../src/app/pieces/tags/pieces/piece-tag.service')

describe('pieceTagService (unit)', () => {
    describe('set', () => {
        it('deletes existing tags and does not invoke upsert when tags array is empty', async () => {
            await pieceTagService.set('plat_1', '@inboxfm-connect/piece-slack', [])

            expect(mockDelete).toHaveBeenCalledWith({
                pieceName: '@inboxfm-connect/piece-slack',
                platformId: 'plat_1',
            })
            expect(mockUpsert).not.toHaveBeenCalled()
        })

        it('deduplicates tag IDs and passes unique conflict keys to upsert', async () => {
            mockTagUpsert.mockImplementation(async (_platformId: string, tag: string) => {
                const normalized = tag.toLowerCase().trim()
                return {
                    id: normalized === 'crm' ? 'tag_crm' : 'tag_sales',
                    name: normalized,
                    platformId: 'plat_1',
                }
            })

            await pieceTagService.set('plat_1', '@inboxfm-connect/piece-hubspot', ['crm', 'CRM', 'sales'])

            expect(mockDelete).toHaveBeenCalledWith({
                pieceName: '@inboxfm-connect/piece-hubspot',
                platformId: 'plat_1',
            })
            expect(mockUpsert).toHaveBeenCalledTimes(1)
            const [upsertedRows, conflictTargets] = mockUpsert.mock.calls[0]
            expect(conflictTargets).toEqual(['tagId', 'pieceName'])
            expect(upsertedRows).toHaveLength(2)
            expect(upsertedRows.map((r) => r.tagId)).toEqual(['tag_crm', 'tag_sales'])
        })
    })

    describe('findByPlatformAndTags', () => {
        it('returns empty array immediately when pieceTags is empty without querying repository', async () => {
            const result = await pieceTagService.findByPlatformAndTags('plat_1', [])

            expect(result).toEqual([])
            expect(mockConvertIdsToNames).not.toHaveBeenCalled()
            expect(mockFindBy).not.toHaveBeenCalled()
        })

        it('returns empty array immediately when no tag IDs are resolved', async () => {
            mockConvertIdsToNames.mockResolvedValueOnce([])

            const result = await pieceTagService.findByPlatformAndTags('plat_1', ['unknown-tag'])

            expect(result).toEqual([])
            expect(mockConvertIdsToNames).toHaveBeenCalledWith('plat_1', ['unknown-tag'])
            expect(mockFindBy).not.toHaveBeenCalled()
        })

        it('deduplicates piece names when multiple matched tags belong to the same piece', async () => {
            mockConvertIdsToNames.mockResolvedValueOnce(['tag_1', 'tag_2'])
            mockFindBy.mockResolvedValueOnce([
                { pieceName: '@inboxfm-connect/piece-slack', tagId: 'tag_1', platformId: 'plat_1' },
                { pieceName: '@inboxfm-connect/piece-slack', tagId: 'tag_2', platformId: 'plat_1' },
                { pieceName: '@inboxfm-connect/piece-gmail', tagId: 'tag_1', platformId: 'plat_1' },
            ])

            const result = await pieceTagService.findByPlatformAndTags('plat_1', ['chat', 'messaging'])

            expect(result).toEqual([
                '@inboxfm-connect/piece-slack',
                '@inboxfm-connect/piece-gmail',
            ])
        })
    })
})
