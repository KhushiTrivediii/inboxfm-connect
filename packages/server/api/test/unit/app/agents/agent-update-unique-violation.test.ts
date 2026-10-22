import { ErrorCode } from '@inboxfm-connect/core-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Conflict-mapping regression (hunt/api finding 6): agentService.update() was a
// blind save, so moving an agent's externalId onto a value another agent in the
// same project already holds violates idx_agent_project_id_external_id and the
// raw QueryFailedError (SQLSTATE 23505 + constraint name) escaped the service.
//
// Unlike the create race there is no winner row to converge on - the conflicting
// row belongs to a DIFFERENT agent than the one being updated - so the fix maps
// the violation to an ActivepiecesError with ErrorCode.VALIDATION, which the
// error handler maps to 409 CONFLICT (same shape as the project-role and
// ai-provider duplicate-create mappings). Violations that cannot come from the
// (projectId, externalId) index (externalId not part of the request) stay raw.

const { mockSave, mockFindOneBy } = vi.hoisted(() => ({
    mockSave: vi.fn(),
    mockFindOneBy: vi.fn(),
}))

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        save: mockSave,
        findOneBy: mockFindOneBy,
    }),
}))

import { agentService } from '../../../../src/app/agents/agent.service'

const existingRow = {
    id: 'agent-1',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    platformId: 'platform-1',
    externalId: 'agent-ext-old',
    displayName: 'Support Agent',
    description: null,
    prompt: 'You help users',
    maxSteps: 10,
    model: { provider: 'openai', model: 'gpt-4o' },
    tools: [],
    structuredOutput: null,
    status: 'ENABLED',
}

const baseUpdateParams = {
    id: 'agent-1',
    projectId: 'project-1',
    platformId: 'platform-1',
}

const uniqueViolation = (shape: 'pg' | 'pglite'): Error => Object.assign(
    new Error('duplicate key value violates unique constraint "idx_agent_project_id_external_id"'),
    shape === 'pg' ? { code: '23505' } : { driverError: { code: '23505' } },
)

describe('agentService.update() unique-violation conflict mapping', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockFindOneBy.mockResolvedValueOnce(existingRow)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each([
        ['top-level code (pg shape)', uniqueViolation('pg')],
        ['driverError.code (PGLite shape - the shape the integration suite runs)', uniqueViolation('pglite')],
    ])('maps an externalId collision to a 409-mapped VALIDATION error, not a raw driver 500 (%s)', async (_label, violation) => {
        mockSave.mockRejectedValueOnce(violation)

        await expect(agentService.update({ ...baseUpdateParams, externalId: 'agent-ext-taken' }))
            .rejects
            .toMatchObject({
                error: {
                    code: ErrorCode.VALIDATION,
                    params: {
                        message: 'Agent with externalId "agent-ext-taken" already exists in this project',
                    },
                },
            })
    })

    it('rethrows the raw error when the update does not touch externalId', async () => {
        const violation = uniqueViolation('pg')
        mockSave.mockRejectedValueOnce(violation)

        await expect(agentService.update({ ...baseUpdateParams, displayName: 'Renamed' }))
            .rejects
            .toBe(violation)
    })

    it('propagates non-unique errors raw', async () => {
        const failure = new Error('connection refused')
        mockSave.mockRejectedValueOnce(failure)

        await expect(agentService.update({ ...baseUpdateParams, externalId: 'agent-ext-taken' }))
            .rejects
            .toBe(failure)
    })

    it('returns the saved row when no violation occurs', async () => {
        const savedRow = { ...existingRow, displayName: 'Renamed' }
        mockSave.mockResolvedValueOnce(savedRow)

        const result = await agentService.update({ ...baseUpdateParams, displayName: 'Renamed' })

        expect(result).toEqual(savedRow)
    })
})
