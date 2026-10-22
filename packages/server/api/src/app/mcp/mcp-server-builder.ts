import { isNil } from '@inboxfm-connect/core-utils'
import { McpToolDefinition, PopulatedMcpServer, ProjectScopedMcpServer } from '@inboxfm-connect/shared'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FastifyBaseLogger } from 'fastify'
import { ALLOW_ALL, PermissionChecker, resolvePermissionChecker } from './mcp-permissions'
import { mcpProjectSelection, ProjectSelectionScope } from './mcp-project-selection'
import { activepiecesTools, ALL_CONTROLLABLE_TOOL_NAMES, LOCKED_TOOL_NAMES, PLATFORM_LEVEL_TOOL_NAMES } from './tools'
import { apSetProjectContextTool } from './tools/ap-set-project-context'

const PLATFORM_LEVEL_TOOL_SET = new Set(PLATFORM_LEVEL_TOOL_NAMES)

const MCP_SERVER_INSTRUCTIONS = `## Inboxfm Connect MCP Server

### Workflow
1. Discover: ap_research_pieces, ap_list_connections, ap_list_ai_models
2. Schema: ap_get_piece_props (get field names/types before configuring)
3. Build: ap_build_flow (one call for new flows) OR ap_create_flow → ap_update_trigger → ap_add_step (granular)
4. Validate: ap_validate_flow
5. Publish: ap_lock_and_publish → ap_change_flow_status

### Key patterns
- **Auth**: ap_list_connections → get \`externalId\` → pass as \`auth\` param on ap_update_step/ap_update_trigger.
- **Step refs**: \`{{stepName['output'].field}}\` — a step's data is nested under \`['output']\` (e.g. \`{{trigger['output'].body.email}}\`, \`{{step_1['output'].id}}\`). The trigger follows the same rule: use \`{{trigger['output'].field}}\`, never \`{{trigger.field}}\`. For a continue-on-failure step's error, use \`{{stepName['error'].message}}\`.
- **Step names**: \`trigger\`, \`step_1\`, \`step_2\`, etc. Use ap_flow_structure to see all names.
- **Piece names**: full format (e.g. "@inboxfm-connect/piece-slack") for ap_add_step/ap_update_trigger. Short names work for lookup tools.
- **Modifying steps**: use ap_update_step/ap_update_trigger. Never delete+recreate — loses sample data.
- **CODE steps**: export a \`code\` fn; access inputs via \`inputs.key\`.
- **Tables**: use field names, not IDs.`

export async function buildMcpServer({ mcp, userId, selectionScope, log, resolveProjectMcp }: {
    mcp: PopulatedMcpServer
    userId?: string
    selectionScope: ProjectSelectionScope | null
    log: FastifyBaseLogger
    resolveProjectMcp?: (projectId: string) => Promise<PopulatedMcpServer>
}): Promise<McpServer> {
    const projectId = mcp.projectId

    const server = new McpServer({
        name: 'Inboxfm Connect',
        title: 'Inboxfm Connect',
        version: '1.0.0',
        websiteUrl: 'https://activepieces.com',
        description: 'Automation and workflow MCP server by Inboxfm Connect',
        icons: [
            {
                src: 'https://cdn.activepieces.com/brand/logo.svg',
                mimeType: 'image/svg+xml',
            },
            {
                src: 'https://cdn.activepieces.com/brand/logo-192.png',
                mimeType: 'image/png',
                sizes: ['192x192'],
            },
        ],
    }, {
        instructions: MCP_SERVER_INSTRUCTIONS,
    })

    if (projectId) {
        const permissionChecker = userId
            ? await resolvePermissionChecker({ userId, projectId, log })
            : ALLOW_ALL
        registerStaticTools({ server, mcp, projectId, userId, permissionChecker, log })
    }
    else if (!isNil(mcp.platformId) && !isNil(userId) && !isNil(resolveProjectMcp)) {
        registerPlatformTools({ server, mcp, userId, selectionScope: selectionScope ?? { platformId: mcp.platformId, userId }, resolveProjectMcp, log })
    }
    else {
        registerPlaceholderTools(server)
    }

    registerEmptyResourcesAndPrompts(server)
    return server
}

function registerPlatformTools({ server, mcp, userId, selectionScope, resolveProjectMcp, log }: {
    server: McpServer
    mcp: PopulatedMcpServer
    userId: string
    selectionScope: ProjectSelectionScope
    resolveProjectMcp: (projectId: string) => Promise<PopulatedMcpServer>
    log: FastifyBaseLogger
}): void {
    const platformId = mcp.platformId!
    const contextTool = apSetProjectContextTool({ platformId, userId, selectionScope, log })
    server.registerTool(contextTool.title, buildToolConfig(contextTool), (args: Record<string, unknown>) => contextTool.execute(args))

    const templateMcp: ProjectScopedMcpServer = { ...mcp, projectId: platformId }
    const allTools = activepiecesTools(templateMcp, userId, log)
    const disabledToolSet = new Set(mcp.disabledTools ?? [])
    const tools = allTools.filter(t => LOCKED_TOOL_NAMES.includes(t.title) || !disabledToolSet.has(t.title))

    tools.forEach((tool) => {
        if (PLATFORM_LEVEL_TOOL_SET.has(tool.title)) {
            server.registerTool(tool.title, buildToolConfig(tool), (args: Record<string, unknown>) => tool.execute(args))
            return
        }

        server.registerTool(tool.title, buildToolConfig(tool), async (args: Record<string, unknown>) => {
            const selectedProjectId = await mcpProjectSelection.get(selectionScope)
            if (isNil(selectedProjectId)) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: 'No project selected. Use ap_set_project_context to select a project first.',
                    }],
                }
            }
            const projectMcp = await resolveProjectMcp(selectedProjectId)
            const projectScopedMcp: ProjectScopedMcpServer = { ...projectMcp, projectId: selectedProjectId }
            const permissionChecker = await resolvePermissionChecker({ userId, projectId: selectedProjectId, log })
            const realTools = activepiecesTools(projectScopedMcp, userId, log)
            const realTool = realTools.find(t => t.title === tool.title)
            if (isNil(realTool)) {
                return {
                    content: [{ type: 'text' as const, text: `Tool "${tool.title}" is not available for this project.` }],
                }
            }
            const execute = permissionChecker.wrapExecute({ execute: realTool.execute, permission: realTool.permission, toolTitle: realTool.title })
            return execute(args)
        })
    })
}

function registerStaticTools({ server, mcp, projectId, userId, permissionChecker, log }: RegisterToolsParams): void {
    const allTools = activepiecesTools({ ...mcp, projectId }, userId, log)
    const disabledToolSet = new Set(mcp.disabledTools ?? [])
    const tools = allTools.filter(t => LOCKED_TOOL_NAMES.includes(t.title) || !disabledToolSet.has(t.title))

    tools.forEach((tool) => {
        const execute = permissionChecker.wrapExecute({ execute: tool.execute, permission: tool.permission, toolTitle: tool.title })
        server.registerTool(tool.title, buildToolConfig(tool), (args: Record<string, unknown>) => execute(args))
    })
}

function registerPlaceholderTools(server: McpServer): void {
    const allToolNames = [...LOCKED_TOOL_NAMES, ...ALL_CONTROLLABLE_TOOL_NAMES]
    allToolNames.forEach((toolName) => {
        server.registerTool(toolName, {
            title: toolName,
            description: `${toolName} — requires a project to be selected first.`,
        }, async () => ({
            content: [{ type: 'text' as const, text: `No project selected. Please select a project from the dropdown in the chat input area before using ${toolName}.` }],
        }))
    })
}

function registerEmptyResourcesAndPrompts(server: McpServer): void {
    server.registerResource(
        '_',
        new ResourceTemplate('activepieces://empty', {
            list: async () => ({ resources: [] }),
        }),
        {},
        async () => ({ contents: [] }),
    )
    server.registerPrompt('_', {}, () => ({ messages: [] }))
}

function buildToolConfig(tool: McpToolDefinition): Record<string, unknown> {
    return {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
    }
}

type RegisterToolsParams = {
    server: McpServer
    mcp: PopulatedMcpServer
    projectId: string
    userId?: string
    permissionChecker: PermissionChecker
    log: FastifyBaseLogger
}