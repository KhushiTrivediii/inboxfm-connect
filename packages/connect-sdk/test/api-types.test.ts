import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Connection, ConnectionsPage } from '../src/api-types'
import type { ConnectionContract } from '../src/generated/connections'
import type { ToolContract, ToolInputContract } from '../src/generated/tools'
import type { CreateConnectSessionResult, ExecuteParams, ListConnectionsResult, Tool, ToolInput } from '../src/index'

describe('generated API contracts', () => {
    it('never exposes server-only fields (platformId, ownerId, owner) on the public Connection type', () => {
        expectTypeOf<Connection>().not.toHaveProperty('platformId')
        expectTypeOf<Connection>().not.toHaveProperty('ownerId')
        expectTypeOf<Connection>().not.toHaveProperty('owner')
    })

    it('keeps the public Connection type structurally assignable from the raw generated contract minus server-only fields', () => {
        const raw: ConnectionContract = {
            id: 'conn_1',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            externalId: 'user_1',
            displayName: 'Slack',
            type: 'OAUTH2',
            pieceName: '@inboxfm-connect/piece-slack',
            projectIds: ['project_1'],
            scope: 'PROJECT',
            status: 'ACTIVE',
            pieceVersion: '1.0.0',
            preSelectForNewProjects: false,
            usingSecretManager: false,
        }
        const publicShape: Connection = raw
        expect(publicShape.id).toBe('conn_1')
    })

    it('ListConnectionsResult matches the generated ConnectionsPage contract (data/next/previous)', () => {
        const page: ListConnectionsResult = { data: [], next: null, previous: null }
        expectTypeOf(page).toEqualTypeOf<ConnectionsPage>()
    })

    it('CreateConnectSessionResult matches the server response contract (token/connectUrl/expiresAt)', () => {
        expectTypeOf<CreateConnectSessionResult>().toEqualTypeOf<{ token: string, connectUrl: string, expiresAt: string }>()
    })

    it('ExecuteParams derives its wire fields from the generated ExecuteRequestContract (integration/tool/input required, projectId excluded)', () => {
        expectTypeOf<ExecuteParams>().not.toHaveProperty('projectId')
        expectTypeOf<ExecuteParams>().toHaveProperty('integration')
        expectTypeOf<ExecuteParams>().toHaveProperty('tool')
        expectTypeOf<ExecuteParams>().toHaveProperty('input')
    })

    it('derives Tool and ToolInput from the generated integration-framework contracts instead of hand-copying them', () => {
        expectTypeOf<Omit<Tool, 'inputs'>>().toEqualTypeOf<ToolContract>()
        expectTypeOf<Tool['inputs']>().toEqualTypeOf<ToolInput[]>()
        expectTypeOf<Omit<ToolInput, 'name'>>().toEqualTypeOf<ToolInputContract>()
        expectTypeOf<ToolInput['type']>().toEqualTypeOf<ToolInputContract['type']>()
    })
})
