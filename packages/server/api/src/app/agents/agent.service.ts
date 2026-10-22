import { ActivepiecesError, apId, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { Agent, AgentOutputField, AgentTool } from '@inboxfm-connect/shared'
import { repoFactory } from '../core/db/repo-factory'
import { AgentEntity, AgentSchema } from './agent.entity'

const agentRepo = repoFactory<AgentSchema>(AgentEntity)

export const agentService = {
    async create(params: {
        id?: string
        projectId: string
        platformId: string
        externalId: string
        displayName: string
        description?: string | null
        prompt: string
        maxSteps?: number
        model: { provider: string, model: string }
        tools?: AgentTool[]
        structuredOutput?: AgentOutputField[] | null
        status?: 'ENABLED' | 'DISABLED'
    }): Promise<Agent> {
        const id = params.id ?? apId()
        const newAgent: Agent = {
            id,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            projectId: params.projectId,
            platformId: params.platformId,
            externalId: params.externalId,
            displayName: params.displayName,
            description: params.description ?? null,
            prompt: params.prompt,
            maxSteps: params.maxSteps ?? 10,
            model: params.model,
            tools: params.tools ?? [],
            structuredOutput: params.structuredOutput ?? null,
            status: params.status ?? 'ENABLED',
        }

        // create() is only reachable from the project-replace apply loop, which is
        // meant to be idempotent against its destination project. Two concurrent
        // applies (a retried deploy, two replicas) both pass their checks and both
        // INSERT, and the loser of idx_agent_project_id_external_id failed the
        // whole replace batch with the raw driver error. The row it was about to
        // write already exists under the same natural key, so converge on the
        // winner's row the same way the get-or-create legs do (#469/#509); a
        // violation that does not resolve to the natural key (e.g. a colliding
        // explicit id) still propagates raw.
        try {
            return await agentRepo().save(newAgent)
        }
        catch (error: unknown) {
            if (!isUniqueViolation(error)) {
                throw error
            }
            const winner = await agentRepo().findOneBy({ projectId: params.projectId, externalId: params.externalId })
            if (isNil(winner)) {
                throw error
            }
            return winner
        }
    },

    async update(params: {
        id: string
        projectId: string
        platformId: string
        externalId?: string
        displayName?: string
        description?: string | null
        prompt?: string
        maxSteps?: number
        model?: { provider: string, model: string }
        tools?: AgentTool[]
        structuredOutput?: AgentOutputField[] | null
        status?: 'ENABLED' | 'DISABLED'
    }): Promise<Agent> {
        const existing = await agentRepo().findOneBy({ id: params.id, projectId: params.projectId, platformId: params.platformId })
        if (isNil(existing)) {
            throw new Error(`Agent not found: id=${params.id}`)
        }

        const updated: AgentSchema = {
            ...existing,
            updated: new Date().toISOString(),
            ...(params.externalId !== undefined && { externalId: params.externalId }),
            ...(params.displayName !== undefined && { displayName: params.displayName }),
            ...(params.description !== undefined && { description: params.description }),
            ...(params.prompt !== undefined && { prompt: params.prompt }),
            ...(params.maxSteps !== undefined && { maxSteps: params.maxSteps }),
            ...(params.model !== undefined && { model: params.model }),
            ...(params.tools !== undefined && { tools: params.tools }),
            ...(params.structuredOutput !== undefined && { structuredOutput: params.structuredOutput }),
            ...(params.status !== undefined && { status: params.status }),
        }

        // A unique loss on update means the requested externalId is already taken
        // by a DIFFERENT agent in the same project. Unlike the create race there
        // is no winner row to converge on - returning the conflicting row would
        // hand back an entity the caller never named - so map it to the
        // 409-mapped conflict code (the shape project-role and the ai-provider
        // create use) instead of leaking the raw driver error with its constraint
        // name. Violations that cannot come from the (projectId, externalId)
        // index still propagate raw.
        try {
            return await agentRepo().save(updated)
        }
        catch (error: unknown) {
            if (isUniqueViolation(error) && params.externalId !== undefined) {
                throw new ActivepiecesError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        message: `Agent with externalId "${params.externalId}" already exists in this project`,
                    },
                })
            }
            throw error
        }
    },

    async delete(params: { id: string, projectId: string, platformId: string }): Promise<void> {
        await agentRepo().delete({ id: params.id, projectId: params.projectId, platformId: params.platformId })
    },

    async getOne(params: { id: string, projectId?: string, platformId?: string }): Promise<Agent | null> {
        return agentRepo().findOneBy({
            id: params.id,
            ...(params.projectId && { projectId: params.projectId }),
            ...(params.platformId && { platformId: params.platformId }),
        })
    },

    async getByExternalId(params: { externalId: string, projectId: string, platformId?: string }): Promise<Agent | null> {
        return agentRepo().findOneBy({
            externalId: params.externalId,
            projectId: params.projectId,
            ...(params.platformId && { platformId: params.platformId }),
        })
    },

    async listByProjectId(params: { projectId: string, platformId?: string }): Promise<Agent[]> {
        return agentRepo().findBy({
            projectId: params.projectId,
            ...(params.platformId && { platformId: params.platformId }),
        })
    },
}

// Postgres surfaces a unique violation as SQLSTATE 23505 on `code`, and pglite puts it
// on `driverError.code` instead, so a matcher keyed on the message misses half the
// supported drivers. Same shape as the user-service / managed-authn helpers.
function isUniqueViolation(error: unknown): boolean {
    const candidate = error as { code?: string, driverError?: { code?: string } } | null | undefined
    return candidate?.code === '23505' || candidate?.driverError?.code === '23505'
}
