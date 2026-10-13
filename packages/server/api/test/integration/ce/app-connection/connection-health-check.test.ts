import { apId } from '@inboxfm-connect/core-utils'
import { AppConnectionScope, AppConnectionStatus, AppConnectionType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConnectionService, appConnectionsRepo } from '../../../../src/app/app-connection/app-connection-service/app-connection-service'
import { encryptUtils } from '../../../../src/app/helper/encryption'
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

async function upsertConnection(params: { ctx: TestContext, externalId: string, status?: AppConnectionStatus }): Promise<{ id: string }> {
    const connection = await appConnectionService(app!.log).upsert({
        projectIds: [params.ctx.project.id],
        platformId: params.ctx.platform.id,
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
        status: params.status,
        ownerId: null,
    })
    return { id: connection.id }
}

describe('POST /v1/app-connections/:id/test (Issue #188)', () => {
    let ctx: TestContext

    beforeEach(async () => {
        ctx = await createTestContext(app!)
    })

    it('returns pass and ACTIVE for a healthy secret-text connection', async () => {
        const { id } = await upsertConnection({ ctx, externalId: 'conn-healthy' })

        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/connections/${id}/test`,
            headers: { authorization: `Bearer ${ctx.token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.ok).toBe(true)
        expect(body.status).toBe(AppConnectionStatus.ACTIVE)
        expect(typeof body.testedAt).toBe('string')

        // The verdict is persisted on the row, so GET serves it after a reload too.
        const stored = await appConnectionsRepo().findOneByOrFail({ id })
        expect(stored.status).toBe(AppConnectionStatus.ACTIVE)
        expect(stored.testedAt).toBe(body.testedAt)
        expect(stored.testedStatus).toBe(AppConnectionStatus.ACTIVE)
        expect(stored.testedMessage).toBeNull()

        const fetched = await app!.inject({
            method: 'GET',
            url: `/api/v1/connections/${id}`,
            headers: { authorization: `Bearer ${ctx.token}` },
        })
        expect(fetched.statusCode).toBe(StatusCodes.OK)
        const fetchedBody = fetched.json()
        expect(fetchedBody.testedAt).toBe(body.testedAt)
        expect(fetchedBody.testedStatus).toBe(AppConnectionStatus.ACTIVE)
        expect(fetchedBody.testedMessage).toBeNull()
    })

    /**
     * Regression (issue #188): an ERROR row used to be rubber-stamped back to
     * ACTIVE with ok:true — without any verification running at all, because
     * needRefresh short-circuits on the stored ERROR status. A secret-text
     * connection has nothing refreshable to re-verify, so the honest verdict is
     * a failure that tells the user to reconnect.
     */
    it('reports failure for an ERROR connection with nothing refreshable to verify', async () => {
        const { id } = await upsertConnection({ ctx, externalId: 'conn-stays-error', status: AppConnectionStatus.ERROR })

        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/connections/${id}/test`,
            headers: { authorization: `Bearer ${ctx.token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.ok).toBe(false)
        expect(body.status).toBe(AppConnectionStatus.ERROR)
        expect(body.message).toBeDefined()

        const stored = await appConnectionsRepo().findOneByOrFail({ id })
        expect(stored.status).toBe(AppConnectionStatus.ERROR)
        expect(stored.testedStatus).toBe(AppConnectionStatus.ERROR)
        expect(stored.testedMessage).toContain('Reconnect the app')
    })

    /**
     * markConnectionTested previously guarded its write with
     * `current.status !== status`, a condition that is true precisely when the
     * stored status differs - i.e. exactly the stale-result case - so the guard
     * inverted its own stated intent. It is now an unconditional write; this
     * pins that the write actually happens rather than being skipped, and that
     * the row reflects the verdict the caller was told about.
     */
    it('persists the verdict it returns, even when the stored status already matches', async () => {
        const { id } = await upsertConnection({ ctx, externalId: 'conn-already-active', status: AppConnectionStatus.ACTIVE })

        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/connections/${id}/test`,
            headers: { authorization: `Bearer ${ctx.token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().status).toBe(AppConnectionStatus.ACTIVE)

        const stored = await appConnectionsRepo().findOneByOrFail({ id })
        expect(stored.status).toBe(AppConnectionStatus.ACTIVE)
    })

    it('fails the check and persists ERROR when the stored value cannot be decrypted', async () => {
        const { id } = await upsertConnection({ ctx, externalId: 'conn-goes-bad', status: AppConnectionStatus.ACTIVE })

        // Corrupt the ciphertext (a value that decrypts to garbage instead of
        // adding inert json keys, which decryptObject silently ignores).
        const repo = appConnectionsRepo()
        await repo.update({ id }, {
            value: {
                iv: '0'.repeat(32),
                data: 'deadbeef',
            },
        })

        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/connections/${id}/test`,
            headers: { authorization: `Bearer ${ctx.token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.ok).toBe(false)
        expect(body.status).toBe(AppConnectionStatus.ERROR)
        expect(body.message).toContain('decrypted')

        const stored = await appConnectionsRepo().findOneByOrFail({ id })
        expect(stored.status).toBe(AppConnectionStatus.ERROR)
        expect(stored.testedStatus).toBe(AppConnectionStatus.ERROR)
        expect(stored.testedMessage).toContain('decrypted')
    })

    /**
     * Regression (issue #188): a refresh that fails for a transient reason
     * (provider unreachable, SSRF-guarded token URL) must fail the verdict but
     * must NOT flip the row to ERROR — that would stop executions from retrying
     * the refresh. Previously any non-null return from the refresh machinery was
     * reported as healthy.
     */
    it('fails the verdict without marking the row ERROR on a transient refresh failure', async () => {
        const expiredOauth2Value = {
            type: AppConnectionType.OAUTH2,
            client_id: 'cid',
            client_secret: 'csecret',
            redirect_url: 'http://localhost:3000/callback',
            token_type: 'Bearer',
            access_token: 'stale',
            refresh_token: 'rt',
            claimed_at: 0,
            expires_in: 3600,
            scope: 'read',
            token_url: 'http://127.0.0.1:9/token',
            grant_type: 'authorization_code',
            data: {},
        }
        const connection = {
            id: apId(),
            created: new Date(),
            updated: new Date(),
            displayName: 'Unreachable OAuth2',
            externalId: 'conn-transient',
            type: AppConnectionType.OAUTH2,
            status: AppConnectionStatus.ACTIVE,
            platformId: ctx.platform.id,
            pieceName: '@inboxfm-connect/piece-slack',
            ownerId: null,
            projectIds: [ctx.project.id],
            scope: AppConnectionScope.PROJECT,
            value: await encryptUtils.encryptObject(expiredOauth2Value),
            metadata: null,
            pieceVersion: '1.0.0',
            preSelectForNewProjects: false,
        }
        await appConnectionsRepo().upsert(connection, ['id'])

        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/connections/${connection.id}/test`,
            headers: { authorization: `Bearer ${ctx.token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.ok).toBe(false)
        expect(body.status).toBe(AppConnectionStatus.ERROR)
        expect(body.message).toBeTruthy()

        const stored = await appConnectionsRepo().findOneByOrFail({ id: connection.id })
        // Row stays ACTIVE: a transient failure is not evidence the connection is bad.
        expect(stored.status).toBe(AppConnectionStatus.ACTIVE)
        expect(stored.testedStatus).toBe(AppConnectionStatus.ERROR)
        expect(stored.testedMessage).toBeTruthy()
    })

    it('returns 404 for an unknown connection id', async () => {
        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/connections/${apId()}/test`,
            headers: { authorization: `Bearer ${ctx.token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
    })

    it('rejects a foreign-platform caller with 403', async () => {
        const { id } = await upsertConnection({ ctx, externalId: 'conn-private' })
        const foreignCtx = await createTestContext(app!)

        const response = await app!.inject({
            method: 'POST',
            url: `/api/v1/connections/${id}/test`,
            headers: { authorization: `Bearer ${foreignCtx.token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})
