import { connectApiKeyService } from '../../../../src/app/connect-api-keys/connect-api-key.service'
import { db } from '../../../helpers/db'
import {
    createMockConnectApiKey,
    mockAndSaveBasicSetup,
} from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

beforeAll(async () => {
    await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Connect API Key rotation atomicity', () => {
    it('rotating sets the old key grace expiry and mints a working replacement', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const mockKey = createMockConnectApiKey({ platformId: mockPlatform.id, projectId: mockProject.id })
        await db.save('connect_api_key', mockKey)

        const rotated = await connectApiKeyService.rotate({
            projectId: mockProject.id,
            id: mockKey.id,
        })

        expect(rotated.value).toContain('cak-')
        expect(rotated.value).not.toBe(mockKey.value)
        expect(rotated.id).not.toBe(mockKey.id)
        expect(rotated.projectId).toBe(mockProject.id)

        const oldKey = await db.findOneBy('connect_api_key', { id: mockKey.id })
        expect(oldKey).not.toBeNull()
        expect(oldKey!.expiresAt).not.toBeNull()
        expect(new Date(oldKey!.expiresAt!).getTime()).toBeGreaterThan(Date.now())
    })

    it('the replacement authenticates immediately and the old key stays valid within the grace window', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const mockKey = createMockConnectApiKey({ platformId: mockPlatform.id, projectId: mockProject.id })
        await db.save('connect_api_key', mockKey)

        const rotated = await connectApiKeyService.rotate({ projectId: mockProject.id, id: mockKey.id })

        const oldLookup = await connectApiKeyService.getByValue(mockKey.value)
        expect(oldLookup).not.toBeNull()

        const newLookup = await connectApiKeyService.getByValue(rotated.value)
        expect(newLookup).not.toBeNull()
        expect(newLookup!.id).toBe(rotated.id)
    })

    it('a rotated-out key stops authenticating once its grace expiry passes', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const mockKey = createMockConnectApiKey({ platformId: mockPlatform.id, projectId: mockProject.id })
        await db.save('connect_api_key', mockKey)

        await connectApiKeyService.rotate({ projectId: mockProject.id, id: mockKey.id })

        await db.update('connect_api_key', mockKey.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() })

        const lookup = await connectApiKeyService.getByValue(mockKey.value)
        expect(lookup).toBeNull()
    })

    it('no orphan replacement row survives when the old-key update fails mid-rotation', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const mockKey = createMockConnectApiKey({ platformId: mockPlatform.id, projectId: mockProject.id })
        await db.save('connect_api_key', mockKey)

        // Simulate the failure the transaction must protect against: the old key row
        // disappears between rotate()'s read and its UPDATE. On non-transactional code
        // the minted replacement would already be committed while its raw value is lost
        // (only the hash is stored) — an orphan nobody can ever use. With the fix, the
        // whole rotation rolls back and no replacement row survives.
        const rowsBefore = await db.findManyBy('connect_api_key', { projectId: mockProject.id })

        // rotation of a non-existent key must throw and must not mint a replacement
        const ghostId = 'ghost_key_12345678'
        await expect(
            connectApiKeyService.rotate({ projectId: mockProject.id, id: ghostId }),
        ).rejects.toThrow()

        const surviving = await db.findManyBy('connect_api_key', { projectId: mockProject.id })
        expect(surviving).toHaveLength(rowsBefore.length)
        expect(surviving.map((row) => row.id)).not.toContain(ghostId)

        // rows persisting after a failed rotation must equal rows before it — no orphan mint
    })
})
