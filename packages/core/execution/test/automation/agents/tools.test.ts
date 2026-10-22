import { describe, expect, it } from 'vitest'
import {
    AgentFlowTool,
    AgentKnowledgeBaseTool,
    AgentMcpTool,
    AgentPieceTool,
    AgentTool,
    AgentToolType,
    FieldControlMode,
    KnowledgeBaseSourceType,
    McpAuthType,
    McpProtocol,
    PredefinedInputsStructure,
    TASK_COMPLETION_TOOL_NAME,
} from '../../../src/lib/agents/tools'

describe('agent tools schemas and definitions', () => {
    it('defines the standard task completion tool name', () => {
        expect(TASK_COMPLETION_TOOL_NAME).toBe('updateTaskStatus')
    })

    describe('AgentPieceTool parsing', () => {
        it('validates a piece tool with predefined input mappings', () => {
            const raw = {
                type: AgentToolType.PIECE,
                toolName: 'send_slack_message',
                pieceMetadata: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '0.3.1',
                    actionName: 'send_channel_message',
                    predefinedInput: {
                        auth: 'conn_slack_123',
                        fields: {
                            channel: {
                                mode: FieldControlMode.CHOOSE_YOURSELF,
                                value: '#general',
                            },
                            text: {
                                mode: FieldControlMode.AGENT_DECIDE,
                                value: undefined,
                            },
                            dryRun: {
                                mode: FieldControlMode.LEAVE_EMPTY,
                                value: null,
                            },
                        },
                    },
                },
            }

            const parsed = AgentTool.parse(raw)
            expect(parsed.type).toBe(AgentToolType.PIECE)
            if (parsed.type === AgentToolType.PIECE) {
                expect(parsed.toolName).toBe('send_slack_message')
                expect(parsed.pieceMetadata.pieceName).toBe('@inboxfm-connect/piece-slack')
                expect(parsed.pieceMetadata.predefinedInput?.auth).toBe('conn_slack_123')
                expect(parsed.pieceMetadata.predefinedInput?.fields.channel.mode).toBe(FieldControlMode.CHOOSE_YOURSELF)
            }
        })

        it('rejects piece tool without toolName', () => {
            const invalid = {
                type: AgentToolType.PIECE,
                toolName: '',
                pieceMetadata: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '0.1.0',
                    actionName: 'send_message',
                },
            }
            expect(() => AgentPieceTool.parse(invalid)).toThrow()
        })
    })

    describe('AgentFlowTool parsing', () => {
        it('validates flow tool with externalFlowId and optional displayName', () => {
            const valid = {
                type: AgentToolType.FLOW,
                toolName: 'escalate_incident',
                externalFlowId: 'flow_xyz789',
                flowDisplayName: 'Escalate to PagerDuty',
            }

            const parsed = AgentFlowTool.parse(valid)
            expect(parsed.type).toBe(AgentToolType.FLOW)
            expect(parsed.externalFlowId).toBe('flow_xyz789')
            expect(parsed.flowDisplayName).toBe('Escalate to PagerDuty')
        })

        it('validates flow tool without optional displayName', () => {
            const valid = {
                type: AgentToolType.FLOW,
                toolName: 'trigger_subflow',
                externalFlowId: 'flow_abc123',
            }

            const parsed = AgentFlowTool.parse(valid)
            expect(parsed.flowDisplayName).toBeUndefined()
        })
    })

    describe('AgentMcpTool and McpAuthConfig variants', () => {
        it('validates MCP tool with NONE auth and SSE protocol', () => {
            const raw = {
                type: AgentToolType.MCP,
                toolName: 'mcp_fetch_weather',
                serverUrl: 'https://mcp.weather.internal/sse',
                protocol: McpProtocol.SSE,
                auth: {
                    type: McpAuthType.NONE,
                },
            }

            const parsed = AgentMcpTool.parse(raw)
            expect(parsed.type).toBe(AgentToolType.MCP)
            expect(parsed.protocol).toBe(McpProtocol.SSE)
            expect(parsed.auth.type).toBe(McpAuthType.NONE)
        })

        it('validates MCP tool with ACCESS_TOKEN auth and STREAMABLE_HTTP protocol', () => {
            const raw = {
                type: AgentToolType.MCP,
                toolName: 'mcp_github_issues',
                serverUrl: 'https://mcp.github.com/v1',
                protocol: McpProtocol.STREAMABLE_HTTP,
                auth: {
                    type: McpAuthType.ACCESS_TOKEN,
                    accessToken: 'ghp_secretToken12345',
                },
            }

            const parsed = AgentMcpTool.parse(raw)
            expect(parsed.auth.type).toBe(McpAuthType.ACCESS_TOKEN)
            if (parsed.auth.type === McpAuthType.ACCESS_TOKEN) {
                expect(parsed.auth.accessToken).toBe('ghp_secretToken12345')
            }
        })

        it('validates MCP tool with API_KEY auth and SIMPLE_HTTP protocol', () => {
            const raw = {
                type: AgentToolType.MCP,
                toolName: 'mcp_brave_search',
                serverUrl: 'https://api.search.brave.com/res/v1',
                protocol: McpProtocol.SIMPLE_HTTP,
                auth: {
                    type: McpAuthType.API_KEY,
                    apiKey: 'bs_apikey_9999',
                    apiKeyHeader: 'X-Subscription-Token',
                },
            }

            const parsed = AgentMcpTool.parse(raw)
            expect(parsed.auth.type).toBe(McpAuthType.API_KEY)
            if (parsed.auth.type === McpAuthType.API_KEY) {
                expect(parsed.auth.apiKeyHeader).toBe('X-Subscription-Token')
            }
        })

        it('validates MCP tool with custom HEADERS auth', () => {
            const raw = {
                type: AgentToolType.MCP,
                toolName: 'mcp_custom_service',
                serverUrl: 'https://internal-service.local/rpc',
                protocol: McpProtocol.SIMPLE_HTTP,
                auth: {
                    type: McpAuthType.HEADERS,
                    headers: {
                        'X-Custom-Tenant': 'tenant_42',
                        Authorization: 'Bearer token_abc',
                    },
                },
            }

            const parsed = AgentMcpTool.parse(raw)
            expect(parsed.auth.type).toBe(McpAuthType.HEADERS)
            if (parsed.auth.type === McpAuthType.HEADERS) {
                expect(parsed.auth.headers['X-Custom-Tenant']).toBe('tenant_42')
            }
        })

        it('rejects MCP tool with invalid serverUrl', () => {
            const invalid = {
                type: AgentToolType.MCP,
                toolName: 'mcp_invalid',
                serverUrl: 'not-a-valid-url',
                protocol: McpProtocol.SSE,
                auth: { type: McpAuthType.NONE },
            }
            expect(() => AgentMcpTool.parse(invalid)).toThrow()
        })
    })

    describe('AgentKnowledgeBaseTool parsing', () => {
        it('validates knowledge base tool with FILE source type', () => {
            const raw = {
                type: AgentToolType.KNOWLEDGE_BASE,
                toolName: 'search_policy_docs',
                sourceType: KnowledgeBaseSourceType.FILE,
                sourceId: 'file_id_001',
                sourceName: 'Company Policy 2026.pdf',
            }

            const parsed = AgentKnowledgeBaseTool.parse(raw)
            expect(parsed.type).toBe(AgentToolType.KNOWLEDGE_BASE)
            expect(parsed.sourceType).toBe(KnowledgeBaseSourceType.FILE)
            expect(parsed.sourceId).toBe('file_id_001')
            expect(parsed.sourceName).toBe('Company Policy 2026.pdf')
        })

        it('validates knowledge base tool with TABLE source type', () => {
            const raw = {
                type: AgentToolType.KNOWLEDGE_BASE,
                toolName: 'lookup_customer_table',
                sourceType: KnowledgeBaseSourceType.TABLE,
                sourceId: 'tbl_customers_555',
                sourceName: 'Customers',
            }

            const parsed = AgentKnowledgeBaseTool.parse(raw)
            expect(parsed.sourceType).toBe(KnowledgeBaseSourceType.TABLE)
        })
    })

    describe('AgentTool discriminated union dispatcher', () => {
        it('correctly discriminates all four tool types', () => {
            const tools = [
                {
                    type: AgentToolType.PIECE,
                    toolName: 'piece1',
                    pieceMetadata: { pieceName: 'p', pieceVersion: '1', actionName: 'a' },
                },
                {
                    type: AgentToolType.FLOW,
                    toolName: 'flow1',
                    externalFlowId: 'ext1',
                },
                {
                    type: AgentToolType.MCP,
                    toolName: 'mcp1',
                    serverUrl: 'https://mcp.io',
                    protocol: McpProtocol.SSE,
                    auth: { type: McpAuthType.NONE },
                },
                {
                    type: AgentToolType.KNOWLEDGE_BASE,
                    toolName: 'kb1',
                    sourceType: KnowledgeBaseSourceType.FILE,
                    sourceId: 's1',
                    sourceName: 'f.txt',
                },
            ]

            const parsedList = tools.map(t => AgentTool.parse(t))
            expect(parsedList.map(p => p.type)).toEqual([
                AgentToolType.PIECE,
                AgentToolType.FLOW,
                AgentToolType.MCP,
                AgentToolType.KNOWLEDGE_BASE,
            ])
        })
    })
})
