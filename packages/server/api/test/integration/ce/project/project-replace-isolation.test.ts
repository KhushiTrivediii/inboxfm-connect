import { AppConnectionScope, AppConnectionType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConnectionService } from '../../../../src/app/app-connection/app-connection-service/app-connection-service'
import { triggerBindingService } from '../../../../src/app/execution/trigger-binding/trigger-binding.service'
import { userInteractionWatcher } from '../../../../src/app/helper/user-interaction/user-interaction-watcher'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(async () => {
    vi.restoreAllMocks()
})

const MINIMAL_SNAPSHOT = {
    schemaVersion: 1,
    sourceActivepiecesVersion: '0.120.0',
    exportedAt: new Date().toISOString(),
    sourceEnvironment: { projectId: 'source-project' },
    tables: [],
    triggerBindings: [],
    scheduledTasks: [],
    mcp: { disabledTools: [] },
    requiredPieces: [],
    requiredConnections: [],
}

async function upsertProjectConnection(params: { projectId: string, platformId: string, externalId: string }): Promise<{ id: string }> {
    const connection = await appConnectionService(app!.log).upsert({
        projectIds: [params.projectId],
        platformId: params.platformId,
        externalId: params.externalId,
        displayName: params.externalId,
        pieceName: '@inboxfm-connect/piece-slack',
        pieceVersion: '1.0.0',
        type: AppConnectionType.SECRET_TEXT,
        value: {
            type: AppConnectionType.SECRET_TEXT,
            secret_text: 'xoxb-test-token',
        },
        scope: AppConnectionScope.PROJECT,
        ownerId: null,
    })
    return { id: connection.id }
}

describe('Project replace cross-project isolation (Issue #133)', () => {
    let ctxA: TestContext
    let ctxB: TestContext

    beforeEach(async () => {
        ctxA = await createTestContext(app!)
        ctxB = await createTestContext(app!)
        vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockResolvedValue({ output: [] } as never)
    })

    it('rejects cross-platform access on all five replace endpoints with 403', async () => {
        const planRes = await app!.inject({
            method: 'POST',
            url: `/api/v1/projects/${ctxA.project.id}/replace/plan`,
            headers: { authorization: `Bearer ${ctxA.token}` },
            body: MINIMAL_SNAPSHOT,
        })
        expect(planRes.statusCode).toBe(StatusCodes.OK)
        const artifact = planRes.json()

        const attempts: { method: 'GET' | 'POST', url: string, body?: Record<string, unknown> }[] = [
            { method: 'GET', url: `/api/v1/projects/${ctxA.project.id}/replace/export` },
            { method: 'POST', url: `/api/v1/projects/${ctxA.project.id}/replace/plan`, body: MINIMAL_SNAPSHOT },
            {
                method: 'POST',
                url: `/api/v1/projects/${ctxA.project.id}/replace/inspect`,
                body: { plan: artifact.plan, snapshot: artifact.snapshot },
            },
            {
                method: 'POST',
                url: `/api/v1/projects/${ctxA.project.id}/replace/apply`,
                body: { plan: artifact.plan, snapshot: artifact.snapshot },
            },
            {
                method: 'POST',
                url: `/api/v1/projects/${ctxA.project.id}/replace`,
                body: { snapshot: MINIMAL_SNAPSHOT, dryRun: true },
            },
        ]

        for (const attempt of attempts) {
            const response = await app!.inject({
                method: attempt.method,
                url: attempt.url,
                headers: { authorization: `Bearer ${ctxB.token}` },
                body: attempt.body,
            })
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        }
    })

    it('never succeeds with an empty project segment', async () => {
        const response = await app!.inject({
            method: 'GET',
            url: '/api/v1/projects//replace/export',
            headers: { authorization: `Bearer ${ctxA.token}` },
        })
        // Empty :projectId matches no route (404) or fails auth — either way it
        // must never reach the export logic.
        expect(response.statusCode).toBeGreaterThanOrEqual(400)
        expect(response.statusCode).toBeLessThan(500)
    })

    it('export emits only source-project connections', async () => {
        const connA = await upsertProjectConnection({
            projectId: ctxA.project.id,
            platformId: ctxA.platform.id,
            externalId: 'conn-a-visible',
        })
        await upsertProjectConnection({
            projectId: ctxB.project.id,
            platformId: ctxB.platform.id,
            externalId: 'conn-b-secret',
        })
        await triggerBindingService.create({
            request: {
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                triggerName: 'new_message',
                connectionId: connA.id,
                promptTemplate: 'Handle Slack message',
                settings: {},
                propertySettings: null,
            },
            projectId: ctxA.project.id,
            platformId: ctxA.platform.id,
        })

        const exportA = await app!.inject({
            method: 'GET',
            url: `/api/v1/projects/${ctxA.project.id}/replace/export`,
            headers: { authorization: `Bearer ${ctxA.token}` },
        })
        expect(exportA.statusCode).toBe(StatusCodes.OK)
        const exportedExternalIds = (exportA.json().triggerBindings as { connectionExternalId: string | null }[])
            .map((binding) => binding.connectionExternalId)
        expect(exportedExternalIds).toContain('conn-a-visible')
        expect(exportedExternalIds).not.toContain('conn-b-secret')
    })

    it('fails closed when a mapping points at another projects connection', async () => {
        await upsertProjectConnection({
            projectId: ctxB.project.id,
            platformId: ctxB.platform.id,
            externalId: 'conn-b-foreign',
        })

        const snapshot = {
            ...MINIMAL_SNAPSHOT,
            triggerBindings: [
                {
                    externalId: 'tb-foreign-conn',
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '1.0.0',
                    triggerName: 'new_message',
                    promptTemplate: 'Handle Slack message',
                    connectionExternalId: 'staging-slack-conn',
                    settings: {},
                    propertySettings: null,
                    status: 'ENABLED',
                },
            ],
            requiredConnections: [
                { externalId: 'staging-slack-conn', pieceName: '@inboxfm-connect/piece-slack' },
            ],
        }
        const planRes = await app!.inject({
            method: 'POST',
            url: `/api/v1/projects/${ctxA.project.id}/replace/plan`,
            headers: { authorization: `Bearer ${ctxA.token}` },
            body: {
                snapshot,
                connectionMappings: [{ sourceExternalId: 'staging-slack-conn', destExternalId: 'conn-b-foreign' }],
            },
        })

        // The foreign externalId is unknown in the target project: preflight
        // must fail (400) rather than resolving across the boundary.
        expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('keeps connections-list pagination project-scoped', async () => {
        const listOwn = await app!.inject({
            method: 'GET',
            url: `/api/v1/connections?projectId=${ctxA.project.id}`,
            headers: { authorization: `Bearer ${ctxA.token}` },
        })
        expect(listOwn.statusCode).toBe(StatusCodes.OK)

        const listForeign = await app!.inject({
            method: 'GET',
            url: `/api/v1/connections?projectId=${ctxA.project.id}`,
            headers: { authorization: `Bearer ${ctxB.token}` },
        })
        expect(listForeign.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})
