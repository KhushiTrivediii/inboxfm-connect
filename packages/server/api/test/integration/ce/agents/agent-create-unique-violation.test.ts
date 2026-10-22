import { FastifyInstance } from 'fastify'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { agentService } from '../../../../src/app/agents/agent.service'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Convergence pin (hunt/api finding 6): agentService.create() was a blind save
// against idx_agent_project_id_external_id (projectId, externalId). The unit
// suite pins the branch logic against mocked repos; this suite drives the real
// PGLite driver and the real unique index, so the violation shape that reaches
// the catch - and the one row the index leaves behind - are exercised, not
// assumed. What must hold after the fix: a create that loses the natural key
// returns the winner's row instead of failing the project-replace apply batch
// with a raw QueryFailedError, and the table still holds exactly one row.
//
// The race is pinned in its post-commit state on purpose. On production
// Postgres the loser of two concurrent inserts observes exactly this state:
// the winner's row is committed, its own insert rejects with 23505, and the
// natural-key re-read finds the winner. Truly overlapping inserts cannot be
// simulated faithfully on PGLite (the driver the integration suite runs): its
// single shared session rolls the winner's not-yet-final insert back together
// with the loser's transaction, so after a genuinely concurrent pair the row
// is absent and the loser correctly propagates the original violation - the
// designed behaviour when the re-read resolves nothing. That session artifact
// would be pinned, not the service contract, so the overlap is left to the
// unit suite (both driver shapes: error.code for pg, driverError.code for
// PGLite).

const EXTERNAL_ID = 'agent-create-convergence-probe'

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
    await databaseConnection()
        .getRepository('agent')
        .createQueryBuilder()
        .delete()
        .where('externalId LIKE :prefix', { prefix: `${EXTERNAL_ID}%` })
        .execute()
})

function createAgentParams(externalId: string) {
    return {
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        externalId,
        displayName: 'Convergence Probe Agent',
        prompt: 'You probe unique-index convergence',
        model: { provider: 'openai', model: 'gpt-4o' },
    }
}

describe('agentService.create() — duplicate natural-key creates converge', () => {
    it('a create against an existing (projectId, externalId) returns the winner row, not a raw driver error', async () => {
        const winner = await agentService.create(createAgentParams(EXTERNAL_ID))

        // The second create hits the unique index head-on: a retried
        // project-replace apply, or two replicas applying the same plan.
        const converged = await agentService.create(createAgentParams(EXTERNAL_ID))

        expect(converged.id).toBe(winner.id)
        expect(converged.externalId).toBe(EXTERNAL_ID)

        const rows = await db.findManyBy<{ id: string, externalId: string }>('agent', {
            projectId: ctx.project.id,
            externalId: EXTERNAL_ID,
        })
        expect(rows).toHaveLength(1)
        expect(rows[0]!.id).toBe(winner.id)
    })

    it('convergence is idempotent: repeated creates keep resolving to the one row', async () => {
        const winner = await agentService.create(createAgentParams(EXTERNAL_ID))
        const ids: string[] = [winner.id]

        for (let attempt = 0; attempt < 3; attempt++) {
            const converged = await agentService.create(createAgentParams(EXTERNAL_ID))
            ids.push(converged.id)
        }

        expect(new Set(ids).size).toBe(1)

        const rows = await db.findManyBy<{ id: string }>('agent', {
            projectId: ctx.project.id,
            externalId: EXTERNAL_ID,
        })
        expect(rows).toHaveLength(1)
        expect(rows[0]!.id).toBe(winner.id)
    })
})
