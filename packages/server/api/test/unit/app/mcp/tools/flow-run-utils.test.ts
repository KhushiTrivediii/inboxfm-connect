import { apLogger } from '@inboxfm-connect/server-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeAdhocAction } from '../../../../../src/app/mcp/tools/flow-run-utils'

interface FakeConnection {
    id: string
    externalId: string
    pieceName: string
}

let connections: FakeConnection[] = []

const executeMock = vi.fn()

vi.mock('@inboxfm-connect/runtime', () => ({
    HeadlessRuntime: class {
        execute = (...args: unknown[]) => executeMock(...args)
    },
}))

vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: () => ({
        getOneOrThrow: vi.fn().mockResolvedValue({ id: 'project-1', platformId: 'platform-1' }),
    }),
}))

vi.mock('../../../../../src/app/helper/system/system', () => ({
    system: {
        get: vi.fn().mockReturnValue(undefined),
    },
}))

vi.mock('../../../../../src/app/app-connection/app-connection-service/app-connection-service', () => ({
    appConnectionsRepo: () => ({
        find: async () => connections,
        findOneBy: vi.fn(),
    }),
    appConnectionService: () => ({
        decryptAndRefreshConnection: vi.fn(),
    }),
}))

const log = apLogger.create({ bindings: {} })

const run = ({ pieceName, connectionExternalId }: { pieceName: string, connectionExternalId?: string }) =>
    executeAdhocAction({
        projectId: 'project-1',
        pieceName,
        actionName: 'send_email',
        input: {},
        connectionExternalId,
        log,
    })

describe('executeAdhocAction connection resolution', () => {
    beforeEach(() => {
        executeMock.mockReset()
        executeMock.mockResolvedValue({ status: 'ok' })
        connections = [
            { id: 'conn-store', externalId: 'e2e-store', pieceName: '@inboxfm-connect/piece-store' },
            { id: 'conn-resend', externalId: 'resend-mihir', pieceName: '@inboxfm-connect/piece-resend' },
        ]
    })

    it('uses the requested externalId when it belongs to the requested piece', async () => {
        await run({ pieceName: '@inboxfm-connect/piece-resend', connectionExternalId: 'resend-mihir' })

        expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'conn-resend' }))
    })

    it('never pairs an externalId from another piece with the requested piece', async () => {
        await run({ pieceName: '@inboxfm-connect/piece-resend', connectionExternalId: 'e2e-store' })

        expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'conn-resend' }))
    })

    it('throws an actionable error when only other-piece connections exist', async () => {
        connections = [{ id: 'conn-store', externalId: 'e2e-store', pieceName: '@inboxfm-connect/piece-store' }]

        await expect(run({ pieceName: '@inboxfm-connect/piece-resend', connectionExternalId: 'e2e-store' })).rejects.toThrow(
            /No connection found for integration "@inboxfm-connect\/piece-resend".*e2e-store/,
        )
        expect(executeMock).not.toHaveBeenCalled()
    })

    it('resolves a short piece name to scoped connection rows', async () => {
        await run({ pieceName: 'resend' })

        expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
            integration: '@inboxfm-connect/piece-resend',
            connectionId: 'conn-resend',
        }))
    })

    it('auto-picks the piece connection when no externalId is passed', async () => {
        await run({ pieceName: '@inboxfm-connect/piece-store' })

        expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'conn-store' }))
    })

    it('still demands a connection when the project has none', async () => {
        connections = []

        await expect(run({ pieceName: '@inboxfm-connect/piece-resend' })).rejects.toThrow(
            'A connection must be created first before executing a tool.',
        )
        expect(executeMock).not.toHaveBeenCalled()
    })
})
