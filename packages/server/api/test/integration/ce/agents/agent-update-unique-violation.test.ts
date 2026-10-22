import { ErrorCode } from '@inboxfm-connect/core-utils'
import { FastifyInstance } from 'fastify'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { agentService } from '../../../../src/app/agents/agent.service'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Conflict-mapping pin (hunt/api finding 6): agentService.update() was a blind
// save, so moving an agent's externalId onto a value another agent in the same
// project already holds violated idx_agent_project_id_external_id and the raw
// QueryFailedError (SQLSTATE 23505 + constraint name) escaped the service. The
// unit suite pins the mapping against mocked repos; this suite drives the real
// PGLite driver and the real unique index. What must hold after the fix: the
// loser gets the 409-mapped VALIDATION error the API error handler translates
// to a conflict, the conflicting rows are left untouched, and an agent
// re-saved with its own externalId never trips the mapping.

const EXTERNAL_ID_PREFIX = 'agent-update-conflict-probe'

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
        .where('externalId LIKE :prefix', { prefix: `${EXTERNAL_ID_PREFIX}%` })
        .execute()
})

function createAgentParams(externalId: string) {
    return {
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        externalId,
        displayName: 'Conflict Probe Agent',
        prompt: 'You probe unique-index conflicts',
        model: { provider: 'openai', model: 'gpt-4o' },
    }
}

describe('agentService.update() — moving externalId onto a taken key maps to a conflict', () => {
    it('maps the unique-index violation to a 409-mapped VALIDATION error, not a raw driver 500', async () => {
        const agentA = await agentService.create(createAgentParams(`${EXTERNAL_ID_PREFIX}-a`))
        await agentService.create(createAgentParams(`${EXTERNAL_ID_PREFIX}-b`))

        await expect(agentService.update({
            id: agentA.id,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
            externalId: `${EXTERNAL_ID_PREFIX}-b`,
        })).rejects.toMatchObject({
            error: {
                code: ErrorCode.VALIDATION,
                params: {
                    message: `Agent with externalId "${EXTERNAL_ID_PREFIX}-b" already exists in this project`,
                },
            },
        })

        // The rejected update left both rows exactly where they were.
        const rows = await db.findManyBy<{ id: string, externalId: string }>('agent', {
            projectId: ctx.project.id,
        })
        expect(rows).toHaveLength(2)
    })

    it('re-saving an agent with its own externalId does not trip the mapping', async () => {
        const agentA = await agentService.create(createAgentParams(`${EXTERNAL_ID_PREFIX}-a`))

        const updated = await agentService.update({
            id: agentA.id,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
            externalId: `${EXTERNAL_ID_PREFIX}-a`,
            displayName: 'Conflict Probe Agent (renamed)',
        })

        expect(updated.id).toBe(agentA.id)
        expect(updated.displayName).toBe('Conflict Probe Agent (renamed)')
        expect(updated.externalId).toBe(`${EXTERNAL_ID_PREFIX}-a`)
    })
})
