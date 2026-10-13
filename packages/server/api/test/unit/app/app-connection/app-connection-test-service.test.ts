import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #188 (service half): appConnectionService.testConnection maps the
// handler's verdict onto the row — writing `status` only for definite
// outcomes, always persisting the testedAt/testedStatus/testedMessage
// bookkeeping, and returning the same verdict it stored. The handler is
// mocked here; the handler's own branches are covered in
// app-connection-health-check.test.ts.

const mockFindOne = vi.fn()
const mockUpdate = vi.fn()

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOne: mockFindOne,
        findOneBy: vi.fn(),
        findOneByOrFail: vi.fn(),
        update: mockUpdate,
        upsert: vi.fn(),
    }),
}))

vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({
        runExclusive: vi.fn(),
    }),
    redisConnections: {
        getRedisType: () => 'MEMORY',
    },
}))

vi.mock('../../../../src/app/helper/encryption', () => ({
    encryptUtils: {
        encryptObject: async (v: unknown) => v,
        decryptObject: async (v: unknown) => v,
    },
    EncryptedObject: {},
}))

vi.mock('../../../../src/app/helper/exception-handler', () => ({
    exceptionHandler: {
        handle: vi.fn(),
    },
}))

vi.mock('../../../../src/app/helper/user-interaction/user-interaction-watcher', () => ({
    userInteractionWatcher: {
        submitAndWaitForResponse: vi.fn(),
    },
}))

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        get: () => 'test',
        getOrThrow: () => 'test',
        getNumberOrThrow: () => 1,
        getEdition: () => 'ce',
    },
}))

vi.mock('../../../../src/app/pieces/metadata/piece-metadata-service', () => ({
    pieceMetadataService: () => ({
        getOrThrow: async () => ({ version: '0.0.1' }),
    }),
    getPiecePackageWithoutArchive: vi.fn(),
}))

vi.mock('../../../../src/app/ee/secret-managers/secret-managers.service', () => ({
    secretManagersService: () => ({
        resolveObject: async ({ value }: { value: unknown }) => value,
        resolveString: async ({ key }: { key: string }) => key,
    }),
    containsSecretManagerReference: () => false,
}))

vi.mock('../../../../src/app/ee/projects/project-members/project-member.service', () => ({
    projectMemberService: {},
}))

vi.mock('../../../../src/app/user/user-service', () => ({
    userService: {},
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectRepo: () => ({
        countBy: async () => 1,
    }),
}))

vi.mock('../../../../src/app/app-connection/app-connection-service/oauth2', () => ({
    oauth2Handler: {
        OAUTH2: () => ({
            refresh: vi.fn(),
        }),
    },
}))

const mockLockAndTestConnection = vi.fn()

vi.mock('../../../../src/app/app-connection/app-connection-service/app-connection.handler', () => ({
    appConnectionHandler: () => ({
        lockAndTestConnection: mockLockAndTestConnection,
        decryptConnection: vi.fn(),
        needRefresh: vi.fn(),
        lockAndRefreshConnection: vi.fn(),
    }),
}))

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

type AppConnectionService = ReturnType<typeof import('../../../../src/app/app-connection/app-connection-service/app-connection-service').appConnectionService>

async function loadService(): Promise<AppConnectionService> {
    const mod = await import('../../../../src/app/app-connection/app-connection-service/app-connection-service')
    return mod.appConnectionService(mockLog)
}

const storedRow = {
    id: 'conn_1',
    created: new Date(),
    updated: new Date(),
    displayName: 'Test Conn',
    externalId: 'ext-1',
    platformId: 'platform-1',
    projectIds: ['proj-1'],
    ownerId: null,
    scope: 'PROJECT',
    pieceName: '@inboxfm-connect/piece-slack',
    pieceVersion: '1.0.0',
    metadata: null,
    preSelectForNewProjects: false,
    type: 'SECRET_TEXT',
    status: 'ACTIVE',
    value: { type: 'SECRET_TEXT', secret_text: 'xoxb' },
}

async function runTestConnection(): Promise<ReturnType<AppConnectionService['testConnection']>> {
    const service = await loadService()
    return service.testConnection({
        id: 'conn_1',
        projectId: 'proj-1',
        platformId: 'platform-1',
    })
}

describe('appConnectionService.testConnection (issue #188)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
        mockFindOne.mockResolvedValue(storedRow)
    })

    it('stores the pass verdict and the tested bookkeeping on the row', async () => {
        mockLockAndTestConnection.mockResolvedValue({ ok: true, markRowError: false })

        const result = await runTestConnection()

        expect(result.ok).toBe(true)
        expect(result.status).toBe('ACTIVE')
        expect(typeof result.testedAt).toBe('string')
        expect(result.message).toBeUndefined()

        expect(mockUpdate).toHaveBeenCalledTimes(1)
        const [criteria, patch] = mockUpdate.mock.calls[0]
        expect(criteria).toEqual({ id: 'conn_1' })
        expect(patch.status).toBe('ACTIVE')
        expect(patch.testedAt).toBe(result.testedAt)
        expect(patch.testedStatus).toBe('ACTIVE')
        expect(patch.testedMessage).toBeNull()
    })

    it('writes ERROR on the row for a definite failure and persists the reason', async () => {
        mockLockAndTestConnection.mockResolvedValue({
            ok: false,
            markRowError: true,
            message: 'The app rejected the stored credentials. Reconnect the app to fix this connection.',
        })

        const result = await runTestConnection()

        expect(result.ok).toBe(false)
        expect(result.status).toBe('ERROR')
        expect(result.message).toContain('Reconnect the app')

        const patch = mockUpdate.mock.calls[0][1]
        expect(patch.status).toBe('ERROR')
        expect(patch.testedStatus).toBe('ERROR')
        expect(patch.testedMessage).toContain('Reconnect the app')
    })

    it('leaves the row status alone for a transient failure but still fails the verdict', async () => {
        mockLockAndTestConnection.mockResolvedValue({
            ok: false,
            markRowError: false,
            message: 'The app could not be reached to verify the connection. Try again in a moment.',
        })

        const result = await runTestConnection()

        expect(result.ok).toBe(false)
        expect(result.status).toBe('ERROR')

        const patch = mockUpdate.mock.calls[0][1]
        expect(patch.status).toBeUndefined()
        expect(patch.testedStatus).toBe('ERROR')
        expect(patch.testedMessage).toContain('could not be reached')
    })

    it('sanitizes control characters and caps the persisted message length', async () => {
        mockLockAndTestConnection.mockResolvedValue({
            ok: false,
            markRowError: true,
            message: `bad${'\u0000'}message ${'x'.repeat(600)}`,
        })

        const result = await runTestConnection()

        expect(result.message).toBe(`bad${'\u0000'}message ${'x'.repeat(600)}`)
        const patch = mockUpdate.mock.calls[0][1]
        expect(patch.testedMessage).toBe('bad message '.padEnd(512, 'x').slice(0, 512))
        expect(patch.testedMessage!.length).toBeLessThanOrEqual(512)
        expect(patch.testedMessage).not.toContain('\u0000')
    })

    it('throws ENTITY_NOT_FOUND for an unknown connection id', async () => {
        mockFindOne.mockResolvedValue(null)

        await expect(runTestConnection()).rejects.toThrow()
        expect(mockLockAndTestConnection).not.toHaveBeenCalled()
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('degrades to a non-definite failure when the lock infrastructure blows up', async () => {
        mockLockAndTestConnection.mockRejectedValue(new Error('ECONNREFUSED redis'))

        const result = await runTestConnection()

        expect(result.ok).toBe(false)
        expect(result.status).toBe('ERROR')
        expect(result.message).toContain('could not be tested')

        const patch = mockUpdate.mock.calls[0][1]
        expect(patch.status).toBeUndefined()
        expect(patch.testedStatus).toBe('ERROR')
    })
})
