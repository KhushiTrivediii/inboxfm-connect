import { AgentOutputField, AgentTool } from '@inboxfm-connect/core-execution'
import { AIProviderName } from '@inboxfm-connect/core-utils'
import { z } from 'zod'
import { AppConnectionType } from '../../automation/app-connection/app-connection'
import { FieldType } from '../../automation/tables/field'
import { TableAutomationStatus, TableAutomationTrigger } from '../../automation/tables/table'
import { ScheduledTaskStatus } from '../../execution/scheduled-task'
import { TriggerBindingStatus } from '../../execution/trigger-binding'

export const ProjectReplaceResourceKind = z.enum([
    'table',
    'agent',
    'trigger_binding',
    'scheduled_task',
    'mcp_server',
    'custom_piece',
    'connection',
])
export type ProjectReplaceResourceKind = z.infer<typeof ProjectReplaceResourceKind>

export const ProjectReplaceOp = z.enum(['CREATE', 'UPDATE', 'DELETE', 'ROTATE'])
export type ProjectReplaceOp = z.infer<typeof ProjectReplaceOp>

export const TableSnapshotSchema = z.object({
    name: z.string(),
    externalId: z.string(),
    fields: z.array(z.object({
        name: z.string(),
        type: z.union([z.nativeEnum(FieldType), z.string()]),
        externalId: z.string().optional(),
    })).optional(),
    status: z.union([z.nativeEnum(TableAutomationStatus), z.string()]).nullable().optional(),
    trigger: z.union([z.nativeEnum(TableAutomationTrigger), z.string()]).nullable().optional(),
})
export type TableSnapshotSchema = z.infer<typeof TableSnapshotSchema>

export const TriggerBindingSnapshotSchema = z.object({
    externalId: z.string().optional(),
    pieceName: z.string(),
    pieceVersion: z.string(),
    triggerName: z.string(),
    promptTemplate: z.string(),
    connectionExternalId: z.string().nullable().optional(),
    settings: z.record(z.string(), z.unknown()),
    propertySettings: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z.union([z.nativeEnum(TriggerBindingStatus), z.string()]),
})
export type TriggerBindingSnapshotSchema = z.infer<typeof TriggerBindingSnapshotSchema>

export const ScheduledTaskSnapshotSchema = z.object({
    externalId: z.string().optional(),
    prompt: z.string(),
    cronExpression: z.string(),
    timezone: z.string(),
    status: z.union([z.nativeEnum(ScheduledTaskStatus), z.string()]),
})
export type ScheduledTaskSnapshotSchema = z.infer<typeof ScheduledTaskSnapshotSchema>

export const McpServerSnapshotSchema = z.object({
    externalId: z.string().optional().default('default'),
    disabledTools: z.array(z.string()).nullable().optional(),
})
export type McpServerSnapshotSchema = z.infer<typeof McpServerSnapshotSchema>

export const MAX_CUSTOM_PIECE_ARCHIVE_BYTES = 15 * 1024 * 1024 // 15MB cap
export const MAX_CUSTOM_PIECE_BASE64_LENGTH = Math.ceil((MAX_CUSTOM_PIECE_ARCHIVE_BYTES * 4) / 3) + 4

export const AgentSnapshotSchema = z.object({
    externalId: z.string(),
    displayName: z.string(),
    description: z.string().nullable().optional(),
    prompt: z.string(),
    maxSteps: z.number().int().positive().optional().default(10),
    model: z.object({
        provider: z.nativeEnum(AIProviderName).or(z.string()),
        model: z.string(),
    }),
    tools: z.array(AgentTool).optional().default([]),
    structuredOutput: z.array(AgentOutputField).nullable().optional(),
    status: z.enum(['ENABLED', 'DISABLED']).optional().default('ENABLED'),
})
export type AgentSnapshotSchema = z.infer<typeof AgentSnapshotSchema>

export const Agent = z.object({
    id: z.string(),
    created: z.string(),
    updated: z.string(),
    projectId: z.string(),
    platformId: z.string(),
    externalId: z.string(),
    displayName: z.string(),
    description: z.string().nullable().optional(),
    prompt: z.string(),
    maxSteps: z.number().default(10),
    model: z.object({
        provider: z.string(),
        model: z.string(),
    }),
    tools: z.array(AgentTool).default([]),
    structuredOutput: z.array(AgentOutputField).nullable().optional(),
    status: z.enum(['ENABLED', 'DISABLED']).default('ENABLED'),
})
export type Agent = z.infer<typeof Agent>

export const ProviderMappingSchema = z.object({
    sourceProvider: z.string(),
    destProvider: z.string(),
})
export type ProviderMappingSchema = z.infer<typeof ProviderMappingSchema>

export const RequiredPieceSchema = z.object({
    name: z.string(),
    version: z.string(),
    pieceType: z.enum(['OFFICIAL', 'CUSTOM']).optional(),
    packageType: z.enum(['ARCHIVE', 'REGISTRY']).optional(),
    archiveChecksum: z.string().optional(),
    minimumSupportedRelease: z.string().optional(),
    maximumSupportedRelease: z.string().optional(),
    archiveFileBase64: z.string().max(MAX_CUSTOM_PIECE_BASE64_LENGTH, 'Archive base64 payload exceeds 15MB limit').optional(),
})
export type RequiredPieceSchema = z.infer<typeof RequiredPieceSchema>

export const ProjectStateSnapshot = z.object({
    schemaVersion: z.literal(1),
    sourceActivepiecesVersion: z.string(),
    exportedAt: z.string(),
    sourceEnvironment: z.object({
        platformId: z.string().optional(),
        projectId: z.string().optional(),
    }).optional(),
    tables: z.array(TableSnapshotSchema),
    agents: z.array(AgentSnapshotSchema).optional().default([]),
    triggerBindings: z.array(TriggerBindingSnapshotSchema),
    scheduledTasks: z.array(ScheduledTaskSnapshotSchema),
    mcp: McpServerSnapshotSchema.nullable().optional(),
    requiredPieces: z.array(RequiredPieceSchema),
    customPieces: z.array(RequiredPieceSchema).optional(),
    requiredConnections: z.array(z.object({
        externalId: z.string(),
        pieceName: z.string(),
    })),
    flows: z.array(z.record(z.string(), z.unknown())).optional(),
})
export type ProjectStateSnapshot = z.infer<typeof ProjectStateSnapshot>

export const PreflightError = z.object({
    kind: z.enum([
        'VERSION_SKEW',
        'MISSING_PIECE',
        'MISSING_CUSTOM_PIECE',
        'MISSING_CONNECTION',
        'INCOMPATIBLE_CONNECTION',
        'CHECKSUM_MISMATCH',
        'INCOMPATIBLE_INTEGRATION',
        'MISSING_AI_PROVIDER',
        'INCOMPATIBLE_AI_PROVIDER',
        'REDACTED_CREDENTIAL',
        'PERMISSIONS',
        'GENERAL',
    ]),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
})
export type PreflightError = z.infer<typeof PreflightError>

export const ConnectionMappingType = z.enum(['EXISTING_MATCH', 'REMAP', 'BOOTSTRAP'])
export type ConnectionMappingType = z.infer<typeof ConnectionMappingType>

export const ConnectionMappingSchema = z.object({
    sourceExternalId: z.string(),
    destExternalId: z.string().optional(),
    destConnectionId: z.string().optional(),
    pieceName: z.string().optional(),
    type: z.nativeEnum(AppConnectionType).optional(),
    value: z.record(z.string(), z.unknown()).optional(),
    displayName: z.string().optional(),
})
export type ConnectionMappingSchema = z.infer<typeof ConnectionMappingSchema>

export const ConnectionPreflightItemSchema = z.object({
    externalId: z.string(),
    pieceName: z.string(),
})
export type ConnectionPreflightItemSchema = z.infer<typeof ConnectionPreflightItemSchema>

export const ConnectionMatchItemSchema = z.object({
    sourceExternalId: z.string(),
    destExternalId: z.string(),
    destConnectionId: z.string(),
    pieceName: z.string(),
    status: z.string(),
})
export type ConnectionMatchItemSchema = z.infer<typeof ConnectionMatchItemSchema>

export const ConnectionMissingItemSchema = z.object({
    externalId: z.string(),
    pieceName: z.string(),
    actionableHelp: z.string(),
})
export type ConnectionMissingItemSchema = z.infer<typeof ConnectionMissingItemSchema>

export const ConnectionMappedItemSchema = z.object({
    sourceExternalId: z.string(),
    destExternalId: z.string().optional(),
    destConnectionId: z.string().optional(),
    pieceName: z.string().optional(),
    mappingType: ConnectionMappingType,
})
export type ConnectionMappedItemSchema = z.infer<typeof ConnectionMappedItemSchema>

export const ConnectionPreflightReportSchema = z.object({
    required: z.array(ConnectionPreflightItemSchema),
    matched: z.array(ConnectionMatchItemSchema),
    missing: z.array(ConnectionMissingItemSchema),
    mapped: z.array(ConnectionMappedItemSchema),
})
export type ConnectionPreflightReportSchema = z.infer<typeof ConnectionPreflightReportSchema>

export const ProjectReplaceDiffItem = z.object({
    kind: ProjectReplaceResourceKind,
    externalId: z.string(),
    op: ProjectReplaceOp,
    name: z.string().optional(),
    description: z.string().optional(),
    changes: z.record(z.string(), z.unknown()).optional(),
})
export type ProjectReplaceDiffItem = z.infer<typeof ProjectReplaceDiffItem>

export const ProjectReplacePlan = z.object({
    planId: z.string(),
    schemaVersion: z.literal(1),
    toolVersion: z.string(),
    createdAt: z.string(),
    sourceActivepiecesVersion: z.string(),
    targetActivepiecesVersion: z.string(),
    targetProjectId: z.string(),
    checksum: z.string(),
    destinationStateHash: z.string(),
    signature: z.string(),
    preflight: z.object({
        passed: z.boolean(),
        errors: z.array(PreflightError),
        warnings: z.array(PreflightError).optional().default([]),
        customIntegrations: z.object({
            required: z.array(RequiredPieceSchema),
            missing: z.array(RequiredPieceSchema),
            deployable: z.array(RequiredPieceSchema),
            compatible: z.array(RequiredPieceSchema),
        }).optional(),
        connections: ConnectionPreflightReportSchema.optional(),
    }),
    connectionMappings: z.array(ConnectionMappingSchema).optional(),
    // Provider remaps applied when the plan was generated. Carried in the artifact so an
    // apply driven by `--plan-file` can see that a remap happened instead of silently
    // writing destination agents against the source provider (#502). Signed alongside
    // connectionMappings.
    providerMappings: z.array(ProviderMappingSchema).optional(),
    changes: z.object({
        creates: z.array(ProjectReplaceDiffItem),
        updates: z.array(ProjectReplaceDiffItem),
        deletes: z.array(ProjectReplaceDiffItem),
        unchanged: z.array(z.object({
            kind: ProjectReplaceResourceKind,
            externalId: z.string(),
        })),
    }),
    summary: z.object({
        created: z.number(),
        updated: z.number(),
        deleted: z.number(),
        unchanged: z.number(),
    }),
})
export type ProjectReplacePlan = z.infer<typeof ProjectReplacePlan>

export const ProjectReplaceArtifactSchema = z.object({
    artifactVersion: z.literal(1),
    toolVersion: z.string(),
    createdAt: z.string(),
    snapshot: ProjectStateSnapshot,
    plan: ProjectReplacePlan,
})
export const ProjectReplaceArtifact = ProjectReplaceArtifactSchema
export type ProjectReplaceArtifact = z.infer<typeof ProjectReplaceArtifactSchema>

export const ProjectReplaceApplyRequest = z.object({
    plan: ProjectReplacePlan,
    snapshot: ProjectStateSnapshot,
    dryRun: z.boolean().optional(),
    force: z.boolean().optional(),
    deployCustomIntegrations: z.boolean().optional(),
    inspectOnly: z.boolean().optional(),
    connectionMappings: z.array(ConnectionMappingSchema).optional(),
    providerMappings: z.array(ProviderMappingSchema).optional(),
    rotateMcpToken: z.boolean().optional(),
})
export type ProjectReplaceApplyRequest = z.infer<typeof ProjectReplaceApplyRequest>

export const ProjectReplaceApplyResult = z.object({
    applied: z.object({
        tablesCreated: z.number(),
        tablesUpdated: z.number(),
        tablesDeleted: z.number(),
        tablesUnchanged: z.number(),
        agentsCreated: z.number(),
        agentsUpdated: z.number(),
        agentsDeleted: z.number(),
        agentsUnchanged: z.number(),
        triggerBindingsCreated: z.number(),
        triggerBindingsUpdated: z.number(),
        triggerBindingsDeleted: z.number(),
        triggerBindingsUnchanged: z.number(),
        scheduledTasksCreated: z.number(),
        scheduledTasksUpdated: z.number(),
        scheduledTasksDeleted: z.number(),
        scheduledTasksUnchanged: z.number(),
        mcpCreated: z.number().optional().default(0),
        mcpUpdated: z.number(),
        mcpDeleted: z.number().optional().default(0),
        mcpUnchanged: z.number().optional().default(0),
        customPiecesInstalled: z.number(),
        customPiecesUnchanged: z.number(),
        connectionsCreated: z.number(),
        connectionsUpdated: z.number(),
        connectionsUnchanged: z.number(),
    }),
    mcpCredentials: z.object({
        token: z.string(),
        serverUrl: z.string().optional(),
    }).nullable().optional(),
    failed: z.array(z.object({
        kind: ProjectReplaceResourceKind,
        externalId: z.string(),
        op: ProjectReplaceOp,
        error: z.string(),
    })),
    durationMs: z.number(),
})
export type ProjectReplaceApplyResult = z.infer<typeof ProjectReplaceApplyResult>
