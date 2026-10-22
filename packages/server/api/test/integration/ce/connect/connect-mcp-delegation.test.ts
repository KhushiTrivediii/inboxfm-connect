import { AppConnectionStatus, AppConnectionType, CreateConnectMcpTokenResponse, ErrorCode } from '@inboxfm-connect/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { appConnectionsRepo } from '../../../../src/app/app-connection/app-connection-service/app-connection-service'
import { connectMcpService } from '../../../../src/app/connect-mcp/connect-mcp.service'
import { buildExternalUserMcpServer } from '../../../../src/app/connect-mcp/connect-mcp-server-builder'
import { connectSessionService } from '../../../../src/app/connect-sessions/connect-session.service'
import { executeRuntime } from '../../../../src/app/execute/execute.controller'
import { createMockConnection } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('External-User MCP Delegation with Account and Tool Isolation (#214)', () => {
    describe('1. Delegation via Project API Key (POST /v1/connect-mcp/token)', () => {
        it('delegates a bounded MCP token for an external customer with project credentials', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/connect-mcp/token', {
                projectId: ctx.project.id,
                externalUserId: 'cust_alpha_001',
                allowedPieceNames: ['@inboxfm-connect/piece-slack', '@inboxfm-connect/piece-google-drive'],
                expiresInSeconds: 1800,
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response!.json() as CreateConnectMcpTokenResponse
            expect(typeof body.token).toBe('string')
            expect(body.projectId).toBe(ctx.project.id)
            expect(body.externalUserId).toBe('cust_alpha_001')
            expect(body.allowedPieceNames).toEqual([
                '@inboxfm-connect/piece-slack',
                '@inboxfm-connect/piece-google-drive',
            ])
            expect(body.mcpServerUrl).toContain('/mcp')
            expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())

            // Verify the token decodes to the bounded customer context
            const verified = await connectMcpService(app!.log).verifyToken(body.token)
            expect(verified.externalUserId).toBe('cust_alpha_001')
            expect(verified.projectId).toBe(ctx.project.id)
            expect(verified.platformId).toBe(ctx.platform.id)
            expect(verified.allowedPieceNames).toEqual([
                '@inboxfm-connect/piece-slack',
                '@inboxfm-connect/piece-google-drive',
            ])
        })

        it('rejects token delegation with empty externalUserId', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/connect-mcp/token', {
                projectId: ctx.project.id,
                externalUserId: '',
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('denies token delegation for a project the caller does not own', async () => {
            const victim = await createTestContext(app!)
            const attacker = await createTestContext(app!)

            const response = await attacker.post('/v1/connect-mcp/token', {
                projectId: victim.project.id,
                externalUserId: 'cust_victim_target',
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })

    describe('2. Delegation via Connect Session (POST /v1/connect-sessions/:token/mcp-token)', () => {
        it('exchanges an active connect session for a customer MCP token', async () => {
            const ctx = await createTestContext(app!)

            const session = await connectSessionService.create({
                projectId: ctx.project.id,
                externalUserId: 'cust_session_user',
                allowedPieceNames: ['@inboxfm-connect/piece-slack'],
                expiresInSeconds: 900,
            })

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/connect-sessions/${session.token}/mcp-token`,
                payload: {
                    expiresInSeconds: 600,
                },
            })

            expect(response.statusCode).toBe(StatusCodes.CREATED)
            const body = response.json() as CreateConnectMcpTokenResponse
            expect(typeof body.token).toBe('string')
            expect(body.projectId).toBe(ctx.project.id)
            expect(body.externalUserId).toBe('cust_session_user')
            expect(body.allowedPieceNames).toEqual(['@inboxfm-connect/piece-slack'])

            const verified = await connectMcpService(app!.log).verifyToken(body.token)
            expect(verified.externalUserId).toBe('cust_session_user')
            expect(verified.projectId).toBe(ctx.project.id)
        })

        it('rejects exchange on an invalid or expired connect session token', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/connect-sessions/invalid_session_token_xyz/mcp-token',
                payload: {},
            })

            expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describe('3. Multi-Tenant Discovery & Isolation (Criteria 2, 4, 7)', () => {
        it('isolates tool discovery and connection listings across customers in the same project and across projects', async () => {
            const project1 = await createTestContext(app!)
            const project2 = await createTestContext(app!)

            // Seed connections:
            // Project 1, Customer Alpha: Slack and Google Drive
            const alphaSlack = createMockConnection({
                projectIds: [project1.project.id],
                externalId: 'cust_alpha',
                pieceName: '@inboxfm-connect/piece-slack',
                displayName: "Alpha's Slack",
                status: AppConnectionStatus.ACTIVE,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'alpha-token' },
            }, project1.user.id)
            await appConnectionsRepo().save(alphaSlack)

            const alphaDrive = createMockConnection({
                projectIds: [project1.project.id],
                externalId: 'cust_alpha',
                pieceName: '@inboxfm-connect/piece-google-drive',
                displayName: "Alpha's Drive",
                status: AppConnectionStatus.ACTIVE,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'alphaDriveCredentialForIsolationTest' },
            }, project1.user.id)
            await appConnectionsRepo().save(alphaDrive)

            // Project 1, Customer Beta: GitHub only
            const betaGithub = createMockConnection({
                projectIds: [project1.project.id],
                externalId: 'cust_beta',
                pieceName: '@inboxfm-connect/piece-github',
                displayName: "Beta's GitHub",
                status: AppConnectionStatus.ACTIVE,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'beta-token' },
            }, project1.user.id)
            await appConnectionsRepo().save(betaGithub)

            // Project 2, Customer Gamma: Slack in Project 2
            const gammaSlack = createMockConnection({
                projectIds: [project2.project.id],
                externalId: 'cust_gamma',
                pieceName: '@inboxfm-connect/piece-slack',
                displayName: "Gamma's Project 2 Slack",
                status: AppConnectionStatus.ACTIVE,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'gamma-token' },
            }, project2.user.id)
            await appConnectionsRepo().save(gammaSlack)

            // Setup MCP client for Customer Alpha (Project 1)
            const alphaServer = await buildExternalUserMcpServer({
                externalUser: {
                    externalUserId: 'cust_alpha',
                    projectId: project1.project.id,
                    platformId: project1.platform.id,
                    allowedPieceNames: null,
                },
                log: app!.log,
            })
            const [alphaClientTransport, alphaServerTransport] = InMemoryTransport.createLinkedPair()
            const alphaClient = new Client({ name: 'agent-alpha', version: '1.0.0' }, { capabilities: {} })
            await alphaServer.connect(alphaServerTransport)
            await alphaClient.connect(alphaClientTransport)

            // Setup MCP client for Customer Beta (Project 1)
            const betaServer = await buildExternalUserMcpServer({
                externalUser: {
                    externalUserId: 'cust_beta',
                    projectId: project1.project.id,
                    platformId: project1.platform.id,
                    allowedPieceNames: null,
                },
                log: app!.log,
            })
            const [betaClientTransport, betaServerTransport] = InMemoryTransport.createLinkedPair()
            const betaClient = new Client({ name: 'agent-beta', version: '1.0.0' }, { capabilities: {} })
            await betaServer.connect(betaServerTransport)
            await betaClient.connect(betaClientTransport)

            // Setup MCP client for Customer Gamma (Project 2)
            const gammaServer = await buildExternalUserMcpServer({
                externalUser: {
                    externalUserId: 'cust_gamma',
                    projectId: project2.project.id,
                    platformId: project2.platform.id,
                    allowedPieceNames: null,
                },
                log: app!.log,
            })
            const [gammaClientTransport, gammaServerTransport] = InMemoryTransport.createLinkedPair()
            const gammaClient = new Client({ name: 'agent-gamma', version: '1.0.0' }, { capabilities: {} })
            await gammaServer.connect(gammaServerTransport)
            await gammaClient.connect(gammaClientTransport)

            // 1. Tool discovery assertion: External user server exposes integration tools, NOT project table/flow tools
            const alphaTools = await alphaClient.listTools()
            const toolNames = alphaTools.tools.map((t) => t.name)
            expect(toolNames).toContain('ap_list_connections')
            expect(toolNames).toContain('ap_run_action')
            expect(toolNames).toContain('ap_get_piece_props')
            expect(toolNames).toContain('ap_research_pieces')
            expect(toolNames).not.toContain('ap_create_table')
            expect(toolNames).not.toContain('ap_delete_table')
            expect(toolNames).not.toContain('ap_build_flow')

            // 2. Alpha connection listing: sees ONLY Alpha's connections
            const alphaListRes = await alphaClient.callTool({
                name: 'ap_list_connections',
                arguments: {},
            }) as { content: [{ type: string, text: string }] }
            expect(alphaListRes.content[0].text).toContain("Alpha's Slack")
            expect(alphaListRes.content[0].text).toContain("Alpha's Drive")
            expect(alphaListRes.content[0].text).not.toContain("Beta's GitHub")
            expect(alphaListRes.content[0].text).not.toContain("Gamma's Project 2 Slack")

            // 3. Beta connection listing: sees ONLY Beta's connections
            const betaListRes = await betaClient.callTool({
                name: 'ap_list_connections',
                arguments: {},
            }) as { content: [{ type: string, text: string }] }
            expect(betaListRes.content[0].text).toContain("Beta's GitHub")
            expect(betaListRes.content[0].text).not.toContain("Alpha's Slack")
            expect(betaListRes.content[0].text).not.toContain("Alpha's Drive")
            expect(betaListRes.content[0].text).not.toContain("Gamma's Project 2 Slack")

            // 4. Gamma connection listing: sees ONLY Gamma's connections in Project 2
            const gammaListRes = await gammaClient.callTool({
                name: 'ap_list_connections',
                arguments: {},
            }) as { content: [{ type: string, text: string }] }
            expect(gammaListRes.content[0].text).toContain("Gamma's Project 2 Slack")
            expect(gammaListRes.content[0].text).not.toContain("Alpha's Slack")
            expect(gammaListRes.content[0].text).not.toContain("Beta's GitHub")

            await alphaClient.close()
            await betaClient.close()
            await gammaClient.close()
        })
    })

    describe('4. Invocation Revalidation & Security Constraints (Criteria 3, 4, 6)', () => {
        it('executes actions with customer ownership checks and prevents customer ID substitution', async () => {
            const ctx = await createTestContext(app!)

            // Seed Alpha's Slack connection
            const alphaSlack = createMockConnection({
                projectIds: [ctx.project.id],
                externalId: 'cust_alpha_owner',
                pieceName: '@inboxfm-connect/piece-slack',
                displayName: "Alpha's Slack",
                status: AppConnectionStatus.ACTIVE,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: '***' },
            }, ctx.user.id)
            await appConnectionsRepo().save(alphaSlack)

            // Intercept headless runtime execution boundary
            const executeSpy = vi.spyOn(executeRuntime, 'execute').mockImplementation(async (opts) => {
                return {
                    success: true,
                    sentChannel: 'general',
                    connectionIdUsed: opts.connectionId,
                }
            })

            const alphaServer = await buildExternalUserMcpServer({
                externalUser: {
                    externalUserId: 'cust_alpha_owner',
                    projectId: ctx.project.id,
                    platformId: ctx.platform.id,
                    allowedPieceNames: null,
                },
                log: app!.log,
            })
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            const client = new Client({ name: 'agent-exec', version: '1.0.0' }, { capabilities: {} })
            await alphaServer.connect(serverTransport)
            await client.connect(clientTransport)

            // Happy path: Alpha executes action with their own connection
            const happyRes = await client.callTool({
                name: 'ap_run_action',
                arguments: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    actionName: 'send_channel_message',
                    input: { text: 'Hello from Alpha agent' },
                },
            }) as { content: [{ type: string, text: string }] }

            expect(happyRes.content[0].text).toContain('"success": true')
            expect(happyRes.content[0].text).toContain(alphaSlack.id)
            expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({
                connectionId: alphaSlack.id,
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
            }))

            // Customer ID substitution attack: Alpha passes Beta's externalId
            const substituteRes = await client.callTool({
                name: 'ap_run_action',
                arguments: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    actionName: 'send_channel_message',
                    connectionExternalId: 'cust_victim_other',
                },
            }) as { isError: boolean, content: [{ type: string, text: string }] }

            expect(substituteRes.isError).toBe(true)
            expect(substituteRes.content[0].text).toContain('Unauthorized connection')

            // Unconnected piece execution attempt: Alpha attempts to run an integration they haven't connected
            const unconnectedRes = await client.callTool({
                name: 'ap_run_action',
                arguments: {
                    pieceName: '@inboxfm-connect/piece-github',
                    actionName: 'create_issue',
                },
            }) as { isError: boolean, content: [{ type: string, text: string }] }

            expect(unconnectedRes.isError).toBe(true)
            expect(unconnectedRes.content[0].text).toContain('No active connection found')

            await client.close()
            executeSpy.mockRestore()
        })

        it('enforces allowedPieceNames bounds on discovery and execution', async () => {
            const ctx = await createTestContext(app!)

            const conn = createMockConnection({
                projectIds: [ctx.project.id],
                externalId: 'cust_bounded',
                pieceName: '@inboxfm-connect/piece-github',
                status: AppConnectionStatus.ACTIVE,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'token' },
            }, ctx.user.id)
            await appConnectionsRepo().save(conn)

            // Build server bounded ONLY to Slack (GitHub is connected but NOT allowed)
            const boundedServer = await buildExternalUserMcpServer({
                externalUser: {
                    externalUserId: 'cust_bounded',
                    projectId: ctx.project.id,
                    platformId: ctx.platform.id,
                    allowedPieceNames: ['@inboxfm-connect/piece-slack'],
                },
                log: app!.log,
            })
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            const client = new Client({ name: 'agent-bounded', version: '1.0.0' }, { capabilities: {} })
            await boundedServer.connect(serverTransport)
            await client.connect(clientTransport)

            // Listing connections omits GitHub because it is not in allowedPieceNames
            const listRes = await client.callTool({
                name: 'ap_list_connections',
                arguments: {},
            }) as { content: [{ type: string, text: string }] }
            expect(listRes.content[0].text).toContain('No connected accounts found')

            // Running GitHub action is rejected by policy
            const runRes = await client.callTool({
                name: 'ap_run_action',
                arguments: {
                    pieceName: '@inboxfm-connect/piece-github',
                    actionName: 'create_issue',
                },
            }) as { isError: boolean, content: [{ type: string, text: string }] }
            expect(runRes.isError).toBe(true)
            expect(runRes.content[0].text).toContain('Integration not permitted')

            await client.close()
        })
    })

    describe('5. Lifecycle, Account Revocation & Credential Safety (Criteria 5, 6)', () => {
        it('invalidates tool execution immediately when a connection is revoked/deleted (zero stale cache)', async () => {
            const ctx = await createTestContext(app!)

            const conn = createMockConnection({
                projectIds: [ctx.project.id],
                externalId: 'cust_revokable',
                pieceName: '@inboxfm-connect/piece-slack',
                displayName: 'Temporary Slack',
                status: AppConnectionStatus.ACTIVE,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'token' },
            }, ctx.user.id)
            await appConnectionsRepo().save(conn)

            const server = await buildExternalUserMcpServer({
                externalUser: {
                    externalUserId: 'cust_revokable',
                    projectId: ctx.project.id,
                    platformId: ctx.platform.id,
                    allowedPieceNames: null,
                },
                log: app!.log,
            })
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            const client = new Client({ name: 'agent-revoc', version: '1.0.0' }, { capabilities: {} })
            await server.connect(serverTransport)
            await client.connect(clientTransport)

            // Initially present
            const initialList = await client.callTool({ name: 'ap_list_connections', arguments: {} }) as { content: [{ type: string, text: string }] }
            expect(initialList.content[0].text).toContain('Temporary Slack')

            // Customer or operator deletes the connection
            await appConnectionsRepo().delete(conn.id)

            // Immediately subsequent invocation fails
            const revokedList = await client.callTool({ name: 'ap_list_connections', arguments: {} }) as { content: [{ type: string, text: string }] }
            expect(revokedList.content[0].text).toContain('No connected accounts found')

            const runRes = await client.callTool({
                name: 'ap_run_action',
                arguments: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    actionName: 'send_channel_message',
                },
            }) as { isError: boolean, content: [{ type: string, text: string }] }
            expect(runRes.isError).toBe(true)
            expect(runRes.content[0].text).toContain('No active connection found')

            await client.close()
        })

        it('strictly prevents credential leakage in connection listing and diagnostic error formatting', async () => {
            const ctx = await createTestContext(app!)

            const conn = createMockConnection({
                projectIds: [ctx.project.id],
                externalId: 'custLeakProbeUser',
                pieceName: '@inboxfm-connect/piece-slack',
                displayName: 'Secure Slack',
                status: AppConnectionStatus.ACTIVE,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'leakyBearerTokenValueForRedactionTest',
                },
            }, ctx.user.id)
            await appConnectionsRepo().save(conn)

            const server = await buildExternalUserMcpServer({
                externalUser: {
                    externalUserId: 'custLeakProbeUser',
                    projectId: ctx.project.id,
                    platformId: ctx.platform.id,
                    allowedPieceNames: null,
                },
                log: app!.log,
            })
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            const client = new Client({ name: 'agent-sec', version: '1.0.0' }, { capabilities: {} })
            await server.connect(serverTransport)
            await client.connect(clientTransport)

            const listRes = await client.callTool({ name: 'ap_list_connections', arguments: {} }) as { content: [{ type: string, text: string }] }
            expect(listRes.content[0].text).not.toContain('leakyBearerTokenValueForRedactionTest')
            expect(listRes.content[0].text).not.toContain('secret_text')
            expect(JSON.stringify(listRes)).not.toContain('leakyBearerTokenValueForRedactionTest')

            // Error diagnostic redaction
            const errorSpy = vi.spyOn(executeRuntime, 'execute').mockRejectedValueOnce(
                new Error('Upstream rejected Bearer leakyBearerTokenValueForRedactionTest with 401 Unauthorized'),
            )

            const errorRes = await client.callTool({
                name: 'ap_run_action',
                arguments: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    actionName: 'send_channel_message',
                },
            }) as { isError: boolean, content: [{ type: string, text: string }] }

            expect(errorRes.isError).toBe(true)
            expect(errorRes.content[0].text).not.toContain('leakyBearerTokenValueForRedactionTest')
            expect(errorRes.content[0].text).toContain('[REDACTED]')

            errorSpy.mockRestore()
            await client.close()
        })
    })

    describe('6. HTTP Transport & Endpoint Integration (Criterion 8)', () => {
        it('authenticates POST /mcp with delegated external customer token and processes JSON-RPC requests', async () => {
            const ctx = await createTestContext(app!)

            const tokenRes = await ctx.post('/v1/connect-mcp/token', {
                projectId: ctx.project.id,
                externalUserId: 'cust_http_user',
            })
            const token = tokenRes!.json().token

            // Send standard MCP tools/list request over HTTP POST
            const mcpResponse = await app!.inject({
                method: 'POST',
                url: '/mcp',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                },
                payload: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/list',
                    params: {},
                },
            })

            expect(mcpResponse.statusCode).toBe(StatusCodes.OK)
            expect(mcpResponse.payload).toContain('ap_list_connections')
            expect(mcpResponse.payload).toContain('ap_run_action')
        })

        it('rejects unauthenticated and expired token requests with 401 Unauthorized', async () => {
            const noAuth = await app!.inject({
                method: 'POST',
                url: '/mcp',
                headers: { 'content-type': 'application/json' },
                payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            })
            expect(noAuth.statusCode).toBe(StatusCodes.UNAUTHORIZED)

            const badToken = await app!.inject({
                method: 'POST',
                url: '/mcp',
                headers: {
                    authorization: 'Bearer invalid_tampered_token_xyz',
                    'content-type': 'application/json',
                },
                payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            })
            expect(badToken.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        })
    })
})
