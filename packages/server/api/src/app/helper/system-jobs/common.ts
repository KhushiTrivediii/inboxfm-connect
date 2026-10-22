import { PlatformId, ProjectId, UserId } from '@inboxfm-connect/core-utils'
// BullMQ types replaced with minimal local stubs — the scheduler now runs in-process
type Job<T = unknown> = { data: T, updateData(data: T): Promise<void>, isFailed(): Promise<boolean>, retry(): Promise<void> }
type JobsOptions = Record<string, unknown>
import { Dayjs } from 'dayjs'

export enum SystemJobName {
    PIECES_ANALYTICS = 'pieces-analytics',
    PIECES_SYNC = 'pieces-sync',
    FILE_CLEANUP_TRIGGER = 'file-cleanup-trigger',
    TRIAL_TRACKER = 'trial-tracker',
    AI_CREDIT_UPDATE_CHECK = 'ai-credit-update-check',
    HARD_DELETE_PROJECT = 'hard-delete-project',
    HARD_DELETE_PLATFORM = 'hard-delete-platform',
    TOOL_SEARCH_REINDEX = 'tool-search-reindex',
    BUNDLE_PIECE = 'bundle-piece',
    CONNECT_SESSION_CLEANUP = 'connect-session-cleanup',
}

type BundlePieceSystemJobData = {
    name: string
    version: string
}

type AiCreditUpdateCheckSystemJobData = {
    apiKeyHash: string
    platformId: string
}

type HardDeleteProjectSystemJobData = {
    projectId: ProjectId
    platformId: PlatformId
    // Retry counter for the flow-bundle cleanup step; absent/undefined means "first attempt".
    // See flowBundleCleanupService#nextFlowBundleCleanupAttempt.
    attempt?: number
}

type HardDeletePlatformSystemJobData = {
    platformId: PlatformId
    userId: UserId
    identityId: string
    // Retry counter for the flow-bundle cleanup step; absent/undefined means "first attempt".
    // See flowBundleCleanupService#nextFlowBundleCleanupAttempt.
    attempt?: number
    // Separate retry counter for the "child projects not hard-deleted yet" wait loop — kept apart
    // from `attempt` so waiting for sibling project hard-deletes never eats into the flow-bundle
    // cleanup retry budget (or vice versa). See platformBackgroundJobs#hardDeletePlatformHandler.
    remainingProjectsAttempt?: number
}

// Scope shape kept inline (structurally equal to tool-search's ReindexScope) so this generic
// job framework does not depend on the tool-search feature module.
type ToolSearchReindexSystemJobData = {
    scope: { type: 'all' } | { type: 'platform', platformId: PlatformId }
}

type SystemJobDataMap = {
    [SystemJobName.PIECES_ANALYTICS]: Record<string, never>
    [SystemJobName.PIECES_SYNC]: Record<string, never>
    [SystemJobName.FILE_CLEANUP_TRIGGER]: Record<string, never>
    [SystemJobName.TRIAL_TRACKER]: Record<string, never>
    [SystemJobName.AI_CREDIT_UPDATE_CHECK]: AiCreditUpdateCheckSystemJobData
    [SystemJobName.HARD_DELETE_PROJECT]: HardDeleteProjectSystemJobData
    [SystemJobName.HARD_DELETE_PLATFORM]: HardDeletePlatformSystemJobData
    [SystemJobName.TOOL_SEARCH_REINDEX]: ToolSearchReindexSystemJobData
    [SystemJobName.BUNDLE_PIECE]: BundlePieceSystemJobData
    [SystemJobName.CONNECT_SESSION_CLEANUP]: Record<string, never>
}

export type SystemJobData<T extends SystemJobName = SystemJobName> = T extends SystemJobName ? SystemJobDataMap[T] : never

export type SystemJobDefinition<T extends SystemJobName> = {
    name: T
    data: SystemJobData<T>
    jobId: string
}

export type SystemJobHandler<T extends SystemJobName = SystemJobName> = (data: SystemJobData<T>) => Promise<void>

type OneTimeJobSchedule = {
    type: 'one-time'
    date: Dayjs
}

type RepeatedJobSchedule = {
    type: 'repeated'
    cron: string
}

export type JobSchedule = OneTimeJobSchedule | RepeatedJobSchedule

type UpsertJobParams<T extends SystemJobName> = {
    job: SystemJobDefinition<T>
    schedule: JobSchedule
    customConfig?: JobsOptions
}

export type SystemJobSchedule = {
    init(): Promise<void>
    startWorker(): Promise<void>
    upsertJob<T extends SystemJobName>(params: UpsertJobParams<T>): Promise<void>
    getJob<T extends SystemJobName>(jobId: string): Promise<Job<SystemJobData<T>> | undefined>
    close(): Promise<void>
}