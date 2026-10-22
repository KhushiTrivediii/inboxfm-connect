import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSave = vi.fn()
const mockUpdate = vi.fn()
const mockFindOneBy = vi.fn()

// transaction(): execute the operation with a shared "manager" that the repos must use.
// If rotate() calls repo() WITHOUT the manager (outside the transaction), the mock repos
// above get called instead of the transaction-scoped ones below — that is what the
// assertions catch.
const mockManager = {
    save: mockSave,
    update: mockUpdate,
}
const mockTransaction = vi.fn(async (operation: (manager: unknown) => Promise<unknown>) => {
    return operation(mockManager)
})

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => (entityManager?: unknown) => ({
        save: entityManager ? mockSave : vi.fn(async () => {
            throw new Error('save called OUTSIDE the transaction manager')
        }),
        update: entityManager ? mockUpdate : vi.fn(async () => {
            throw new Error('update called OUTSIDE the transaction manager')
        }),
        findOneBy: mockFindOneBy,
    }),
}))

vi.mock('../../../../src/app/core/db/transaction', () => ({
    transaction: (operation: (manager: unknown) => Promise<unknown>) => mockTransaction(operation),
}))

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        getNumber: vi.fn(() => undefined),
        get: vi.fn(() => 'postgres'),
    },
}))

beforeEach(() => {
    vi.clearAllMocks()
})

const { connectApiKeyService } = await import('../../../../src/app/connect-api-keys/connect-api-key.service')

describe('connectApiKeyService.rotate — atomicity (unit)', () => {
    it('performs the mint and the old-key grace update inside ONE transaction', async () => {
        mockFindOneBy.mockResolvedValueOnce({
            id: 'key_old_123',
            platformId: 'plat_1',
            projectId: 'proj_1',
            displayName: 'ci-key',
            expiresAt: null,
        })

        const rotated = await connectApiKeyService.rotate({ projectId: 'proj_1', id: 'key_old_123' })

        // exactly one transaction was used for the whole rotation
        expect(mockTransaction).toHaveBeenCalledTimes(1)

        // both writes went through the transaction-scoped manager
        expect(mockSave).toHaveBeenCalledTimes(1)
        expect(mockUpdate).toHaveBeenCalledTimes(1)
        const updateArgs = mockUpdate.mock.calls[0]
        // the old key's grace expiry is set on the old row id, not the new one
        expect(updateArgs[0]).toEqual('key_old_123')
        expect(typeof updateArgs[1].expiresAt).toBe('string')

        // the caller gets the freshly minted value exactly once
        expect(rotated.value).toContain('cak-')
        expect(rotated.value).toHaveLength(64)
    })

    it('does not leak the replacement row when the transaction rolls back', async () => {
        mockFindOneBy.mockResolvedValueOnce({
            id: 'key_old_456',
            platformId: 'plat_1',
            projectId: 'proj_1',
            displayName: 'ci-key',
            expiresAt: null,
        })
        mockTransaction.mockImplementationOnce(async () => {
            throw new Error('simulated crash between mint and grace update')
        })

        await expect(
            connectApiKeyService.rotate({ projectId: 'proj_1', id: 'key_old_456' }),
        ).rejects.toThrow('simulated crash between mint and grace update')

        // nothing was persisted by the failed rotation: the transaction never
        // produced a usable result and no bare repo() write escaped it
        expect(mockSave).toHaveBeenCalledTimes(0)
        expect(mockUpdate).toHaveBeenCalledTimes(0)
    })
})
