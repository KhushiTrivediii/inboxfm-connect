import { PlatformId, ProjectId } from '@inboxfm-connect/core-utils'

export const getPlatformPlanNameKey = (platformId: PlatformId): string => `platform_plan:plan:${platformId}`
export const getProjectConcurrencyPoolKey = (projectId: ProjectId): string => `project:concurrency-pool:${projectId}` // gets pool id for the project
export const getConcurrencyPoolLimitKey = (poolId: string): string => `concurrency-pool:limit:${poolId}` // gets limit value for the pool
export const getConcurrencyPoolSetKey = (poolId: string): string => `active_jobs_set:pool:${poolId}`
export const getSystemJobTickLockKey = (jobId: string): string => `system-job:tick-lock:${jobId}` // cluster-wide leader claim for one cron tick of a repeated system job
export const getScheduledTaskTickLockKey = (taskId: string): string => `scheduled-task:tick-lock:${taskId}` // cluster-wide leader claim for one cron tick of a scheduled task
export const getTriggerBindingTickLockKey = (bindingId: string, cronType: 'run' | 'renew'): string => `trigger-binding:tick-lock:${cronType}:${bindingId}` // cluster-wide leader claim for trigger binding cron
