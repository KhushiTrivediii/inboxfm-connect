import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Convergence regression (hunt/api finding 6): agentService.create() was a blind
// save against idx_agent_project_id_external_id (projectId, externalId). The only
// production caller is the project-replace apply loop, which is meant to be
// idempotent against its destination project - two concurrent applies (a retried
// deploy, two replicas) both INSERT the same agent and the loser failed the whole
// replace batch with the raw QueryFailedError (SQLSTATE 23505 + constraint name).
//
// The fix converges the loser on the winner's row: re-read the natural key, return
// it if a row is there, propagate the original error otherwise (e.g. a colliding
// explicit id, where the natural key resolves nothing).

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

const winnerRow = {
    id: 'winner-id',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    platformId: 'platform-1',
    externalId: 'agent-ext-1',
    displayName: 'Support Agent (winner)',
    description: null,
    prompt: 'winner prompt',
    maxSteps: 10,
    model: { provider: 'openai', model: 'gpt-4o' },
    tools: [],
    structuredOutput: null,
    status: 'ENABLED',
}

const createParams = {
    projectId: 'project-1',
    platformId: 'platform-1',
    externalId: 'agent-ext-1',
    displayName: 'Support Agent',
    prompt: 'You help users',
    model: { provider: 'openai', model: 'gpt-4o' },
}

const uniqueViolation = (shape: 'pg' | 'pglite'): Error => Object.assign(
    new Error('duplicate key value violates unique constraint "idx_agent_project_id_external_id"'),
    shape === 'pg' ? { code: '23505' } : { driverError: { code: '23505' } },
)

describe('agentService.create() unique-violation convergence', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each([
        ['top-level code (pg shape)', uniqueViolation('pg')],
        ['driverError.code (PGLite shape - the shape the integration suite runs)', uniqueViolation('pglite')],
    ])('converges on the winner row instead of throwing the raw driver error (%s)', async (_label, violation) => {
        mockSave.mockRejectedValueOnce(violation)
        mockFindOneBy.mockResolvedValueOnce(winnerRow)

        const result = await agentService.create(createParams)

        expect(result).toEqual(winnerRow)
        expect(mockSave).toHaveBeenCalledTimes(1)
        expect(mockFindOneBy).toHaveBeenCalledWith({ projectId: 'project-1', externalId: 'agent-ext-1' })
    })

    it('rethrows the original violation when the natural key resolves no winner row', async () => {
        const violation = uniqueViolation('pg')
        mockSave.mockRejectedValueOnce(violation)
        mockFindOneBy.mockResolvedValueOnce(null)

        await expect(agentService.create(createParams)).rejects.toBe(violation)
        expect(mockFindOneBy).toHaveBeenCalledWith({ projectId: 'project-1', externalId: 'agent-ext-1' })
    })

    it('propagates non-unique errors raw without touching the natural key', async () => {
        const failure = new Error('connection refused')
        mockSave.mockRejectedValueOnce(failure)

        await expect(agentService.create(createParams)).rejects.toBe(failure)
        expect(mockFindOneBy).not.toHaveBeenCalled()
    })

    it('returns the saved row untouched when no violation occurs', async () => {
        const savedRow = { ...winnerRow, id: 'saved-id' }
        mockSave.mockResolvedValueOnce(savedRow)

        const result = await agentService.create(createParams)

        expect(result).toEqual(savedRow)
        expect(mockFindOneBy).not.toHaveBeenCalled()
    })
})
