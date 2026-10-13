import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #188: the health check (POST /v1/app-connections/:id/test) must report
// an honest verdict. These tests pin the verdict branches of
// appConnectionHandler.lockAndTestConnection without a database: the repo,
// distributed lock, encryption, and the oauth2 handler are all mocked, so the
// cases that previously produced false positives (refresh failure reported as
// healthy, ERROR rows rubber-stamped ACTIVE) fail loudly here.

const mockFindOneBy = vi.fn()
const mockUpdate = vi.fn()

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOneBy: mockFindOneBy,
        update: mockUpdate,
    }),
}))

const mockRunExclusive = vi.fn()

vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({
        runExclusive: mockRunExclusive,
    }),
    // jwt-utils reads the redis type at module load when minting engine tokens.
    redisConnections: {
        getRedisType: () => 'MEMORY',
    },
}))

vi.mock('../../../../src/app/helper/encryption', () => ({
    encryptUtils: {
        encryptObject: async (v: unknown) => v,
        decryptObject: vi.fn(async (v: unknown) => v),
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

const mockOauth2Refresh = vi.fn()

vi.mock('../../../../src/app/app-connection/app-connection-service/oauth2', () => ({
    oauth2Handler: {
        OAUTH2: () => ({
            refresh: mockOauth2Refresh,
        }),
    },
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

type AppConnectionHandler = ReturnType<typeof import('../../../../src/app/app-connection/app-connection-service/app-connection.handler').appConnectionHandler>

async function loadHandler(): Promise<AppConnectionHandler> {
    const mod = await import('../../../../src/app/app-connection/app-connection-service/app-connection.handler')
    return mod.appConnectionHandler(mockLog)
}

// RedLock semantics: run the caller's fn under the lock, then release.
async function realRunExclusive<T>({ fn }: { fn: () => Promise<T> }): Promise<T> {
    return fn()
}

const baseRow = {
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
    type: 'OAUTH2',
}

const expiredOauth2Value = {
    type: 'OAUTH2',
    client_id: 'cid',
    client_secret: 'csecret',
    redirect_url: 'http://localhost:3000/callback',
    token_type: 'Bearer',
    access_token: 'stale',
    refresh_token: 'rt',
    claimed_at: 0,
    expires_in: 3600,
    scope: 'read',
    token_url: 'http://example.com/token',
    grant_type: 'authorization_code',
    data: {},
}

const secretTextValue = {
    type: 'SECRET_TEXT',
    secret_text: 'xoxb-token',
}

function axiosLikeUserError(): Error {
    // axios's isAxiosError only checks payload.isAxiosError; isUserError then
    // reads response.data.error === 'invalid_grant'.
    return Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: {
            data: {
                error: 'invalid_grant',
                error_description: 'The refresh token is invalid or expired.',
            },
        },
    })
}

async function runTest(row: Record<string, unknown>): Promise<{
    ok: boolean
    markRowError: boolean
    message?: string
}> {
    mockFindOneBy.mockResolvedValue(row)
    const handler = await loadHandler()
    return handler.lockAndTestConnection({
        platformId: 'platform-1',
        projectId: 'proj-1',
        externalId: 'ext-1',
        log: mockLog,
    })
}

describe('appConnectionHandler.lockAndTestConnection (issue #188)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
        mockRunExclusive.mockImplementation(realRunExclusive)
    })

    it('reports failure and marks the row ERROR when the app rejects the credentials', async () => {
        mockOauth2Refresh.mockRejectedValue(axiosLikeUserError())

        const outcome = await runTest({ ...baseRow, status: 'ACTIVE', value: expiredOauth2Value })

        expect(outcome.ok).toBe(false)
        expect(outcome.markRowError).toBe(true)
        expect(outcome.message).toContain('rejected')
        expect(outcome.message).toContain('Reconnect the app')
        expect(mockUpdate).toHaveBeenCalledWith('conn_1', expect.objectContaining({ status: 'ERROR' }))
    })

    it('reports pass and stores the refreshed value when refresh succeeds', async () => {
        mockOauth2Refresh.mockResolvedValue({
            ...expiredOauth2Value,
            access_token: 'fresh',
        })

        const outcome = await runTest({ ...baseRow, status: 'ACTIVE', value: expiredOauth2Value })

        expect(outcome.ok).toBe(true)
        expect(outcome.message).toBeUndefined()
        expect(mockUpdate).toHaveBeenCalledWith('conn_1', expect.objectContaining({ status: 'ACTIVE' }))
    })

    it('revives an ERROR row by attempting the refresh despite the stored verdict', async () => {
        // needRefresh short-circuits on status ERROR; the health check must bypass
        // that so a stale-but-valid token still gets a refresh attempt.
        mockOauth2Refresh.mockResolvedValue({
            ...expiredOauth2Value,
            access_token: 'fresh',
        })

        const outcome = await runTest({ ...baseRow, status: 'ERROR', value: expiredOauth2Value })

        expect(mockOauth2Refresh).toHaveBeenCalledTimes(1)
        expect(outcome.ok).toBe(true)
        expect(mockUpdate).toHaveBeenCalledWith('conn_1', expect.objectContaining({ status: 'ACTIVE' }))
    })

    it('reports failure for an ERROR row with nothing refreshable to verify', async () => {
        const outcome = await runTest({ ...baseRow, status: 'ERROR', value: secretTextValue })

        expect(mockOauth2Refresh).not.toHaveBeenCalled()
        expect(outcome.ok).toBe(false)
        expect(outcome.markRowError).toBe(true)
        expect(outcome.message).toContain('Reconnect the app')
    })

    it('passes a healthy non-refreshable connection without writing a status', async () => {
        const outcome = await runTest({ ...baseRow, status: 'ACTIVE', value: secretTextValue })

        expect(mockOauth2Refresh).not.toHaveBeenCalled()
        expect(outcome.ok).toBe(true)
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('reports failure for a MISSING placeholder connection', async () => {
        const outcome = await runTest({ ...baseRow, status: 'MISSING', value: { type: 'NO_AUTH' } })

        expect(outcome.ok).toBe(false)
        expect(outcome.markRowError).toBe(false)
        expect(outcome.message).toContain('no credentials yet')
    })

    it('reports failure and marks the row ERROR when decryption fails', async () => {
        const { encryptUtils } = await import('../../../../src/app/helper/encryption')
        vi.mocked(encryptUtils.decryptObject).mockRejectedValueOnce(new Error('bad decrypt'))

        const outcome = await runTest({ ...baseRow, status: 'ACTIVE', value: secretTextValue })

        expect(outcome.ok).toBe(false)
        expect(outcome.markRowError).toBe(true)
        expect(outcome.message).toContain('decrypted')
    })

    it('reports a non-definite failure for a transient refresh error', async () => {
        mockOauth2Refresh.mockRejectedValue(new Error('ECONNREFUSED'))

        const outcome = await runTest({ ...baseRow, status: 'ACTIVE', value: expiredOauth2Value })

        expect(outcome.ok).toBe(false)
        expect(outcome.markRowError).toBe(false)
        expect(outcome.message).toBeTruthy()
        // No status write happened — only the tested* bookkeeping the service adds.
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('reports failure when the connection row is missing under the lock', async () => {
        mockFindOneBy.mockResolvedValue(null)
        const handler = await loadHandler()

        const outcome = await handler.lockAndTestConnection({
            platformId: 'platform-1',
            projectId: 'proj-1',
            externalId: 'ext-1',
            log: mockLog,
        })

        expect(outcome.ok).toBe(false)
        expect(outcome.markRowError).toBe(false)
        expect(outcome.message).toContain('could not be found')
    })

    it('serializes against the execution refresh with the same lock key', async () => {
        mockOauth2Refresh.mockResolvedValue({ ...expiredOauth2Value, access_token: 'fresh' })
        mockFindOneBy.mockResolvedValue({ ...baseRow, status: 'ACTIVE', value: expiredOauth2Value })

        await runTest({ ...baseRow, status: 'ACTIVE', value: expiredOauth2Value })

        const lockArgs = mockRunExclusive.mock.calls[0][0]
        expect(lockArgs.key).toBe('platform-1_ext-1')
        expect(lockArgs.timeoutInSeconds).toBe(60)
    })
})
