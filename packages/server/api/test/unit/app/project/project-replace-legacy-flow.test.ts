import { AgentTool } from '@inboxfm-connect/shared'
import { describe, expect, it } from 'vitest'
import { projectReplaceTesting } from '../../../../src/app/project/replace/project-replace.service'

const { extractAgentsFromFlows, isTableNotFoundError } = projectReplaceTesting

describe('project-replace legacy flow agent derivation (Issue #125)', () => {
    describe('isTableNotFoundError', () => {
        it('identifies Postgres 42P01 (undefined_table) as table not found', () => {
            const err = { code: '42P01', message: 'relation "flow" does not exist' }
            expect(isTableNotFoundError(err)).toBe(true)
        })

        it('identifies relation does not exist messages', () => {
            expect(isTableNotFoundError(new Error('relation "flow" does not exist'))).toBe(true)
            expect(isTableNotFoundError(new Error('relation "flow_version" does not exist'))).toBe(true)
            expect(isTableNotFoundError({ message: 'Table "flow" does not exist' })).toBe(true)
            expect(isTableNotFoundError({ message: 'no such table: flow' })).toBe(true)
            expect(isTableNotFoundError({ message: 'Error: undefined_table' })).toBe(true)
        })

        it('does NOT treat real DB failures (auth, connection timeout, deadlock, syntax error) as table not found', () => {
            expect(isTableNotFoundError(new Error('Connection terminated unexpectedly'))).toBe(false)
            expect(isTableNotFoundError(new Error('ETIMEDOUT: Connection pool exhausted'))).toBe(false)
            expect(isTableNotFoundError({ code: '40P01', message: 'deadlock detected' })).toBe(false)
            expect(isTableNotFoundError({ code: '28P01', message: 'password authentication failed' })).toBe(false)
            expect(isTableNotFoundError({ code: '42601', message: 'syntax error at or near "SELECT"' })).toBe(false)
            expect(isTableNotFoundError(null)).toBe(false)
            expect(isTableNotFoundError(undefined)).toBe(false)
            expect(isTableNotFoundError('random string')).toBe(false)
        })
    })

    describe('extractAgentsFromFlows — empty, absent, and malformed inputs', () => {
        it('returns empty array when flows array is empty, undefined, or not an array', () => {
            expect(extractAgentsFromFlows()).toEqual([])
            expect(extractAgentsFromFlows(undefined)).toEqual([])
            expect(extractAgentsFromFlows([])).toEqual([])
            expect(extractAgentsFromFlows(null as unknown as Array<Record<string, unknown>>)).toEqual([])
        })

        it('safely skips malformed flow entries (null, primitives, missing version/trigger)', () => {
            const malformedFlows = [
                null,
                undefined,
                {},
                { id: 'f1' },
                { id: 'f2', version: null },
                { id: 'f3', version: { trigger: null } },
                { id: 'f4', version: { trigger: 'not-an-object' } },
            ] as unknown as Array<Record<string, unknown>>

            expect(extractAgentsFromFlows(malformedFlows)).toEqual([])
        })

        it('handles malformed step settings and input without throwing', () => {
            const flowWithBadSteps = [
                {
                    id: 'flow-1',
                    version: {
                        trigger: {
                            name: 'trigger',
                            settings: null,
                            nextAction: {
                                name: 'step-1',
                                settings: {
                                    input: null,
                                },
                                nextAction: {
                                    name: 'step-2',
                                    settings: {
                                        input: {
                                            agentId: '', // empty agentId ignored
                                        },
                                    },
                                    children: [
                                        {
                                            name: 'child-1',
                                            settings: {
                                                input: 'string-instead-of-object',
                                            },
                                        },
                                        null,
                                    ],
                                },
                            },
                        },
                    },
                },
            ] as unknown as Array<Record<string, unknown>>

            expect(extractAgentsFromFlows(flowWithBadSteps)).toEqual([])
        })

        it('prevents infinite recursion on cyclic step references', () => {
            const stepA: Record<string, unknown> = {
                name: 'stepA',
                settings: {
                    input: {
                        agentId: 'agent-cycle',
                        prompt: 'Cycle prompt',
                    },
                },
            }
            const stepB: Record<string, unknown> = {
                name: 'stepB',
                nextAction: stepA,
            }
            stepA.nextAction = stepB

            const cyclicFlow = [
                {
                    id: 'cyclic-flow',
                    version: {
                        trigger: stepA,
                    },
                },
            ]

            const agents = extractAgentsFromFlows(cyclicFlow)
            expect(agents).toHaveLength(1)
            expect(agents[0].externalId).toBe('agent-cycle')
        })
    })

    describe('extractAgentsFromFlows — valid extraction and deduplication', () => {
        it('extracts agent definitions from linear and branched step hierarchies', () => {
            const toolSample: AgentTool = {
                type: 'PIECE',
                pieceName: '@inboxfm-connect/piece-slack',
                actionName: 'send_message',
                pieceVersion: '1.0.0',
            }

            const flows = [
                {
                    id: 'flow-main',
                    version: {
                        trigger: {
                            name: 'webhook_trigger',
                            nextAction: {
                                name: 'sales_agent_step',
                                displayName: 'Sales Qualifier Agent',
                                description: 'Qualifies inbound sales leads',
                                settings: {
                                    input: {
                                        agentId: 'agent-sales-001',
                                        prompt: 'You are a sales assistant.',
                                        maxSteps: 15,
                                        model: {
                                            provider: 'OPENAI',
                                            model: 'gpt-4o',
                                        },
                                        agentTools: [toolSample],
                                    },
                                },
                                children: [
                                    {
                                        name: 'support_agent_step',
                                        displayName: 'Support Triage Agent',
                                        settings: {
                                            input: {
                                                externalAgentId: 'agent-support-002',
                                                prompt: 'Triage support tickets.',
                                                provider: 'ANTHROPIC',
                                                modelName: 'claude-3-5-sonnet',
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            ]

            const agents = extractAgentsFromFlows(flows)
            expect(agents).toHaveLength(2)

            const salesAgent = agents.find((a) => a.externalId === 'agent-sales-001')
            expect(salesAgent).toBeDefined()
            expect(salesAgent?.displayName).toBe('Sales Qualifier Agent')
            expect(salesAgent?.description).toBe('Qualifies inbound sales leads')
            expect(salesAgent?.prompt).toBe('You are a sales assistant.')
            expect(salesAgent?.maxSteps).toBe(15)
            expect(salesAgent?.model).toEqual({ provider: 'OPENAI', model: 'gpt-4o' })
            expect(salesAgent?.tools).toEqual([toolSample])
            expect(salesAgent?.status).toBe('ENABLED')

            const supportAgent = agents.find((a) => a.externalId === 'agent-support-002')
            expect(supportAgent).toBeDefined()
            expect(supportAgent?.displayName).toBe('Support Triage Agent')
            expect(supportAgent?.model).toEqual({ provider: 'ANTHROPIC', model: 'claude-3-5-sonnet' })
            expect(supportAgent?.maxSteps).toBe(10) // default fallback
        })

        it('deduplicates agents across multiple flows and steps by externalId', () => {
            const duplicateFlows = [
                {
                    id: 'flow-1',
                    version: {
                        trigger: {
                            name: 't1',
                            nextAction: {
                                name: 'step1',
                                settings: {
                                    input: {
                                        agentId: 'shared-agent-ext-id',
                                        displayName: 'First Occurrence',
                                        prompt: 'First prompt',
                                    },
                                },
                            },
                        },
                    },
                },
                {
                    id: 'flow-2',
                    version: {
                        trigger: {
                            name: 't2',
                            nextAction: {
                                name: 'step2',
                                settings: {
                                    input: {
                                        agentId: 'shared-agent-ext-id',
                                        displayName: 'Second Occurrence',
                                        prompt: 'Second prompt',
                                    },
                                },
                            },
                        },
                    },
                },
            ]

            const agents = extractAgentsFromFlows(duplicateFlows)
            expect(agents).toHaveLength(1)
            expect(agents[0].externalId).toBe('shared-agent-ext-id')
            expect(agents[0].prompt).toBe('First prompt')
        })
    })

    describe('deterministic version selection for multiple flow_version rows', () => {
        it('picks the latest flow_version deterministically based on created date', () => {
            const flowVersions = [
                {
                    id: 'fv-older',
                    flowId: 'flow-abc',
                    created: '2026-01-01T10:00:00.000Z',
                    trigger: {
                        name: 'old_trigger',
                        nextAction: {
                            name: 'old_step',
                            settings: { input: { agentId: 'agent-old-version' } },
                        },
                    },
                },
                {
                    id: 'fv-newest',
                    flowId: 'flow-abc',
                    created: '2026-06-15T12:00:00.000Z',
                    trigger: {
                        name: 'new_trigger',
                        nextAction: {
                            name: 'new_step',
                            settings: { input: { agentId: 'agent-new-version' } },
                        },
                    },
                },
                {
                    id: 'fv-middle',
                    flowId: 'flow-abc',
                    created: '2026-03-01T10:00:00.000Z',
                    trigger: {
                        name: 'mid_trigger',
                        nextAction: {
                            name: 'mid_step',
                            settings: { input: { agentId: 'agent-middle-version' } },
                        },
                    },
                },
            ]

            // Simulate the version resolution logic in projectReplaceService
            const versionsByFlowId = new Map<string, Record<string, unknown>>()
            for (const fv of flowVersions) {
                const flowId = fv.flowId as string
                if (!flowId) continue
                const existing = versionsByFlowId.get(flowId)
                if (!existing) {
                    versionsByFlowId.set(flowId, fv)
                }
                else {
                    const existingCreated = new Date((existing.created as string | number | Date) ?? 0).getTime()
                    const currentCreated = new Date((fv.created as string | number | Date) ?? 0).getTime()
                    if (currentCreated > existingCreated) {
                        versionsByFlowId.set(flowId, fv)
                    }
                }
            }

            const chosenVersion = versionsByFlowId.get('flow-abc')
            expect(chosenVersion?.id).toBe('fv-newest')

            const flowSnapshot = [
                {
                    id: 'flow-abc',
                    version: chosenVersion,
                },
            ]

            const agents = extractAgentsFromFlows(flowSnapshot)
            expect(agents).toHaveLength(1)
            expect(agents[0].externalId).toBe('agent-new-version')
        })
    })
})
