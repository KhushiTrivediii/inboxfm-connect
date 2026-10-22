import { ActivepiecesError, apId, ErrorCode, isNil, SeekPage, tryCatch } from '@inboxfm-connect/core-utils'
import { cronParser, scheduler } from '@inboxfm-connect/scheduler'
import { apLogger } from '@inboxfm-connect/server-utils'
import {
    CreateTriggerBindingRequest,
    ExecuteTriggerResponse,
    Execution,
    PackageType,
    PiecePackage,
    PieceType,
    PlatformId,
    ProjectId,
    TriggerBinding,
    TriggerBindingStatus,
    TriggerHookType,
    UpdateTriggerBindingRequest,
    WorkerJobType,
} from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { MoreThan } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { getTriggerBindingTickLockKey } from '../../database/redis/keys'
import { distributedStore } from '../../database/redis-connections'
import { domainHelper } from '../../helper/domain-helper'
import { userInteractionWatcher } from '../../helper/user-interaction/user-interaction-watcher'
import { projectExecutionConcurrencyGuard } from '../concurrency/project-execution-concurrency-guard'
import { executionService } from '../execution.service'
import { TriggerBindingEntity, TriggerBindingSchema } from './trigger-binding-entity'

/**
 * Lazy getter: resolving the repository at module scope binds it to whichever
 * DataSource existed when `app.ts` was first imported, which is not necessarily
 * the initialized one.
 */
const triggerBindingRepo = repoFactory<TriggerBindingSchema>(TriggerBindingEntity)

/**
 * Boot-path re-registration reads enabled bindings in keyset batches
 * (`id > cursor, take`) instead of one unbounded cross-tenant `findBy`, so a
 * replica restart pins at most one batch in memory rather than the global
 * enabled-row count. 500 follows the MAX_PAGE_SIZE pagination convention
 * (see tables/record/record.service.ts).
 */
const RE_REGISTER_BATCH_SIZE = 500

/**
 * Sentinel primary key for the pre-scan DB reachability probe in
 * `reRegisterEnabledSchedules`: it is longer than the 21-char `apId()`
 * column, so it can never match a row.
 */
const DB_AVAILABILITY_PROBE_ID = 'boot-scan-db-availability-probe'

export const triggerBindingService = {
    async create({ request, projectId, platformId }: CreateParams): Promise<TriggerBinding> {
        const id = apId()
        const newBinding: TriggerBinding = {
            id,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            projectId,
            platformId,
            pieceName: request.pieceName,
            pieceVersion: request.pieceVersion,
            triggerName: request.triggerName,
            connectionId: request.connectionId ?? null,
            promptTemplate: request.promptTemplate,
            settings: request.settings,
            propertySettings: request.propertySettings,
            status: request.status ?? TriggerBindingStatus.ENABLED,
        }

        const saved = await triggerBindingRepo().save(newBinding)

        if (saved.status === TriggerBindingStatus.ENABLED) {
            await executeEngineHook({
                binding: saved,
                hookType: TriggerHookType.ON_ENABLE,
            })
            await syncTriggerSchedule(saved)
        }

        return saved
    },

    /**
     * Tenant-scoped read for every authenticated route. `projectId`/`platformId` are
     * required: an earlier revision accepted them as optional and dropped the
     * predicates whenever they were nil, so a caller that forgot to thread the
     * principal's scope silently got a cross-tenant lookup. Callers that genuinely
     * have no principal must go through `getByIdForIngressOrThrow` instead, which
     * names that intent.
     */
    async getOneOrThrow({ id, projectId, platformId }: GetOneParams): Promise<TriggerBinding> {
        const binding = await triggerBindingRepo().findOneBy({ id, projectId, platformId })
        if (isNil(binding)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { message: `TriggerBinding ${id} not found` },
            })
        }
        return binding
    },

    /**
     * Unscoped lookup by primary key, for the public event-ingress path only.
     *
     * `POST /v1/trigger-bindings/:id/run` is a webhook-style ingress
     * (`securityAccess.public()`), so there is no principal to scope the read by —
     * the 21-char `apId()` in the URL is the capability. Every tenant value used
     * downstream is then read off the returned row, never off the request, so an
     * ingress caller cannot direct the execution at another project.
     */
    async getByIdForIngressOrThrow({ id }: { id: string }): Promise<TriggerBinding> {
        const binding = await triggerBindingRepo().findOneBy({ id })
        if (isNil(binding)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { message: `TriggerBinding ${id} not found` },
            })
        }
        return binding
    },

    async list({ projectId, platformId }: ListParams): Promise<SeekPage<TriggerBinding>> {
        const bindings = await triggerBindingRepo().findBy({ projectId, platformId })
        return {
            data: bindings,
            next: null,
            previous: null,
        }
    },

    async update({ id, projectId, platformId, request }: UpdateParams): Promise<TriggerBinding> {
        const existing = await triggerBindingService.getOneOrThrow({ id, projectId, platformId })
        const oldStatus = existing.status

        const updatedBinding: TriggerBinding = {
            ...existing,
            ...(request.pieceName !== undefined ? { pieceName: request.pieceName } : {}),
            ...(request.pieceVersion !== undefined ? { pieceVersion: request.pieceVersion } : {}),
            ...(request.triggerName !== undefined ? { triggerName: request.triggerName } : {}),
            ...(request.connectionId !== undefined ? { connectionId: request.connectionId } : {}),
            ...(request.promptTemplate !== undefined ? { promptTemplate: request.promptTemplate } : {}),
            ...(request.settings !== undefined ? { settings: request.settings } : {}),
            ...(request.propertySettings !== undefined ? { propertySettings: request.propertySettings } : {}),
            ...(request.status !== undefined ? { status: request.status } : {}),
            updated: new Date().toISOString(),
        }

        const saved = await triggerBindingRepo().save(updatedBinding)

        if (oldStatus === TriggerBindingStatus.DISABLED && saved.status === TriggerBindingStatus.ENABLED) {
            await executeEngineHook({ binding: saved, hookType: TriggerHookType.ON_ENABLE })
            await syncTriggerSchedule(saved)
        }
        else if (oldStatus === TriggerBindingStatus.ENABLED && saved.status === TriggerBindingStatus.DISABLED) {
            await executeEngineHook({ binding: saved, hookType: TriggerHookType.ON_DISABLE })
            await unsyncTriggerSchedule(saved.id)
        }
        else if (oldStatus === TriggerBindingStatus.ENABLED && saved.status === TriggerBindingStatus.ENABLED && touchesSchedule(request)) {
            // An update that keeps the binding enabled but changes WHEN it fires must
            // re-register the in-memory jobs: the scheduler closures captured the cron
            // expression at registration time, so without this a changed cron keeps
            // firing on the old schedule, and a removed cron/renewCron keeps firing
            // forever, until the next process restart. Validate before unsyncing so an
            // invalid expression/timezone rejects the request with the previous schedule intact.
            validateBindingSchedule(saved)
            await unsyncTriggerSchedule(saved.id)
            await syncTriggerSchedule(saved)
        }

        return saved
    },

    async enable({ id, projectId, platformId }: GetOneParams): Promise<TriggerBinding> {
        const binding = await triggerBindingService.getOneOrThrow({ id, projectId, platformId })
        return triggerBindingService.update({
            id,
            projectId: binding.projectId,
            platformId: binding.platformId,
            request: { status: TriggerBindingStatus.ENABLED },
        })
    },

    async disable({ id, projectId, platformId }: GetOneParams): Promise<TriggerBinding> {
        const binding = await triggerBindingService.getOneOrThrow({ id, projectId, platformId })
        return triggerBindingService.update({
            id,
            projectId: binding.projectId,
            platformId: binding.platformId,
            request: { status: TriggerBindingStatus.DISABLED },
        })
    },

    async renew({ id, projectId, platformId }: GetOneParams): Promise<ExecuteTriggerResponse<TriggerHookType.RENEW>> {
        const binding = await triggerBindingService.getOneOrThrow({ id, projectId, platformId })
        return executeEngineHook<TriggerHookType.RENEW>({
            binding,
            hookType: TriggerHookType.RENEW,
        })
    },

    /**
     * Event ingress. Deliberately takes no tenant parameters: the only trusted
     * source of `projectId`/`platformId` here is the binding row, because the sole
     * HTTP caller is the unauthenticated `/:id/run` route. Accepting a tenant
     * argument would reintroduce a channel for a caller to redirect the execution.
     */
    async executeRun({ id, triggerPayload }: ExecuteRunParams): Promise<Execution[]> {
        const binding = await triggerBindingService.getByIdForIngressOrThrow({ id })

        if (binding.status !== TriggerBindingStatus.ENABLED) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: `TriggerBinding ${id} is currently disabled` },
            })
        }

        const runResult = await executeEngineHook<TriggerHookType.RUN>({
            binding,
            hookType: TriggerHookType.RUN,
            triggerPayload,
        })

        const items = Array.isArray(runResult.output) ? runResult.output : (runResult.output ? [runResult.output] : [])
        const createdExecutions: Execution[] = []

        for (const item of items) {
            const execution = await executionService.create({
                prompt: binding.promptTemplate,
                metadata: {
                    triggerBindingId: binding.id,
                    pieceName: binding.pieceName,
                    triggerName: binding.triggerName,
                    item: typeof item === 'object' && item !== null ? item : { value: item },
                },
                projectId: binding.projectId,
                platformId: binding.platformId,
            })
            createdExecutions.push(execution)
        }

        return createdExecutions
    },

    async delete({ id, projectId, platformId }: GetOneParams): Promise<void> {
        const binding = await triggerBindingService.getOneOrThrow({ id, projectId, platformId })
        await unsyncTriggerSchedule(id)

        if (binding.status === TriggerBindingStatus.ENABLED) {
            try {
                await executeEngineHook({ binding, hookType: TriggerHookType.ON_DISABLE })
            }
            catch (e) {
                // Best-effort cleanup on delete
            }
        }

        await triggerBindingRepo().delete({ id, projectId, platformId })
    },

    async reRegisterEnabledSchedules({ log }: { log: FastifyBaseLogger }): Promise<{ registered: number, skipped: number, total: number }> {
        // Reachability probe before registering anything: it matches no row (the
        // sentinel id cannot exist) and only fails when the database itself does.
        // It preserves the single-query failure envelope of the unbatched version
        // — a DB that is down at scan start logs the same error once and
        // registers nothing — which a batched scan that dies mid-loop could no
        // longer guarantee on its own.
        try {
            await triggerBindingRepo().findBy({ status: TriggerBindingStatus.ENABLED, id: DB_AVAILABILITY_PROBE_ID })
        }
        catch (error) {
            log.error({ error }, '[triggerBindingService#reRegisterEnabledSchedules] Failed to query enabled trigger bindings from database')
            return { registered: 0, skipped: 0, total: 0 }
        }

        // Semantics preserved from the unbatched version: every enabled binding
        // still registers, a per-binding registration failure skips only that
        // binding (same warn log), and a query failure logs the same error once
        // and yields the counts so far — {0, 0, 0} when the very first batch
        // fails, exactly like the single-query version. The keyset cursor is
        // `id`, which registration never rewrites, so batching cannot skip or
        // repeat a row.
        let registered = 0
        let skipped = 0
        let total = 0
        let cursor: string | null = null
        try {
            while (true) {
                const bindings: TriggerBindingSchema[] = await triggerBindingRepo().find({
                    where: {
                        status: TriggerBindingStatus.ENABLED,
                        ...(isNil(cursor) ? {} : { id: MoreThan(cursor) }),
                    },
                    order: { id: 'ASC' },
                    take: RE_REGISTER_BATCH_SIZE,
                })
                for (const binding of bindings) {
                    try {
                        await syncTriggerSchedule(binding)
                        registered += 1
                    }
                    catch (error) {
                        log.warn({ error, binding: { id: binding.id } }, '[triggerBindingService#reRegisterEnabledSchedules] Skipping schedule that failed to register')
                        skipped += 1
                    }
                }
                total += bindings.length
                if (bindings.length < RE_REGISTER_BATCH_SIZE) {
                    break
                }
                cursor = bindings[bindings.length - 1].id
            }
        }
        catch (error) {
            log.error({ error }, '[triggerBindingService#reRegisterEnabledSchedules] Failed to query enabled trigger bindings from database')
        }
        return { registered, skipped, total }
    },
}

async function claimTriggerTick(bindingId: string, cronType: 'run' | 'renew', cronExpression: string, timezone?: string): Promise<boolean> {
    const key = getTriggerBindingTickLockKey(bindingId, cronType)
    let ttlSeconds = 55
    try {
        const next = cronParser.computeNextTick({ cronExpression, timezone: timezone ?? 'UTC' })
        const diffSeconds = Math.floor((next.getTime() - Date.now()) / 1000)
        ttlSeconds = Math.max(1, Math.min(55, diffSeconds - 1))
    }
    catch {
        ttlSeconds = 55
    }
    const result = await tryCatch(() => distributedStore.putIfAbsent(key, 1, ttlSeconds))
    if (result.error === null) {
        return result.data
    }
    // If Redis is temporarily down or unreachable, fail-open (return true) so
    // scheduled executions are not dropped entirely. While this may cause redundant
    // executions across replicas during a Redis outage, it guarantees execution liveness.
    return true
}

// The scheduler closures registered by syncTriggerSchedule capture these values at
// registration time; every other binding field is re-read from the database on each
// fire, so only these require a schedule re-registration when the row changes.
function getScheduleSettings(binding: TriggerBinding): { cronExpr: string | null, renewCron: string | null, timezone: string } {
    const cronExpr = typeof binding.settings?.cronExpression === 'string' ? binding.settings.cronExpression : null
    const renewCron = typeof binding.settings?.renewCronExpression === 'string' ? binding.settings.renewCronExpression : null
    const timezone = typeof binding.settings?.timezone === 'string' ? binding.settings.timezone : 'UTC'
    return { cronExpr, renewCron, timezone }
}

function touchesSchedule(request: UpdateTriggerBindingRequest): boolean {
    return request.settings !== undefined
        || request.pieceName !== undefined
        || request.pieceVersion !== undefined
}

function isValidTimezone(timezone: string): boolean {
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: timezone })
        return true
    }
    catch {
        return false
    }
}

function validateBindingSchedule(binding: TriggerBinding): void {
    const { cronExpr, renewCron, timezone } = getScheduleSettings(binding)
    // node-cron builds an Intl.DateTimeFormat for the timezone, which throws a raw
    // RangeError for an invalid one — surfacing as a 500 on create/update and as a
    // silently unregistered binding on boot. Reject it with a clean VALIDATION error
    // instead (mirrors scheduledTaskService.isValidTimezone).
    if ((cronExpr !== null || renewCron !== null) && !isValidTimezone(timezone)) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: { message: `Invalid timezone: ${timezone}` },
        })
    }
    for (const [field, expression] of [['cronExpression', cronExpr], ['renewCronExpression', renewCron]] as const) {
        if (expression !== null && !cronParser.validateCronExpression(expression)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: `Invalid ${field} cron expression: ${expression}` },
            })
        }
    }
}

async function syncTriggerSchedule(binding: TriggerBinding): Promise<void> {
    const { cronExpr, renewCron, timezone } = getScheduleSettings(binding)
    validateBindingSchedule(binding)
    if (cronExpr) {
        if (!cronParser.validateCronExpression(cronExpr)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: `Invalid cron expression: ${cronExpr}` },
            })
        }
        await scheduler.cron({
            name: `trigger-cron-${binding.id}`,
            cronExpression: cronExpr,
            timezone,
            fn: async () => {
                const current = await triggerBindingRepo().findOneBy({ id: binding.id })
                if (!current || current.status !== TriggerBindingStatus.ENABLED) {
                    await unsyncTriggerSchedule(binding.id)
                    return
                }
                const isLeader = await claimTriggerTick(binding.id, 'run', cronExpr, timezone)
                if (!isLeader) {
                    return
                }
                await triggerBindingService.executeRun({ id: binding.id })
            },
        })
    }

    if (renewCron) {
        if (!cronParser.validateCronExpression(renewCron)) {
            await scheduler.cancel(`trigger-cron-${binding.id}`)
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: `Invalid renew cron expression: ${renewCron}` },
            })
        }
        try {
            await scheduler.cron({
                name: `trigger-renew-${binding.id}`,
                cronExpression: renewCron,
                timezone,
                fn: async () => {
                    const current = await triggerBindingRepo().findOneBy({ id: binding.id })
                    if (!current || current.status !== TriggerBindingStatus.ENABLED) {
                        await unsyncTriggerSchedule(binding.id)
                        return
                    }
                    const isLeader = await claimTriggerTick(binding.id, 'renew', renewCron, timezone)
                    if (!isLeader) {
                        return
                    }
                    await triggerBindingService.renew({ id: binding.id, projectId: binding.projectId, platformId: binding.platformId })
                },
            })
        }
        catch (error) {
            await scheduler.cancel(`trigger-cron-${binding.id}`)
            throw error
        }
    }
}

async function unsyncTriggerSchedule(id: string): Promise<void> {
    await scheduler.cancel(`trigger-cron-${id}`)
    await scheduler.cancel(`trigger-renew-${id}`)
}

const engineHookLog = apLogger.create({ bindings: {} })

export async function executeEngineHook<HT extends TriggerHookType>({ binding, hookType, triggerPayload }: ExecuteEngineHookParams<HT>): Promise<ExecuteTriggerResponse<HT>> {
    const piece: PiecePackage = {
        pieceName: binding.pieceName,
        pieceVersion: binding.pieceVersion,
        packageType: PackageType.REGISTRY,
        pieceType: PieceType.OFFICIAL,
    }
    const jobData = {
        jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
        platformId: binding.platformId,
        projectId: binding.projectId,
        schemaVersion: 1,
        triggerBindingId: binding.id,
        test: false,
        hookType,
        triggerBinding: {
            id: binding.id,
            projectId: binding.projectId,
            platformId: binding.platformId,
            pieceName: binding.pieceName,
            pieceVersion: binding.pieceVersion,
            triggerName: binding.triggerName,
            connectionId: binding.connectionId,
            promptTemplate: binding.promptTemplate,
            settings: binding.settings,
            propertySettings: binding.propertySettings,
            status: binding.status,
        },
        webhookUrl: await domainHelper.getPublicApiUrl({
            path: `v1/trigger-bindings/${binding.id}/run`,
        }),
        triggerPayload,
        piece,
        requestId: apId(),
        webserverId: 'inline',
    }

    // Only the RUN hook (an actual flow-trigger execution, fired from a webhook
    // burst, a cron schedule, or a manual run) is metered here — ON_ENABLE/
    // ON_DISABLE/RENEW are low-frequency lifecycle events, not the noisy,
    // burst-prone path the per-project concurrency cap exists to bound.
    if (hookType !== TriggerHookType.RUN) {
        return userInteractionWatcher.submitAndWaitForResponse<ExecuteTriggerResponse<HT>>(jobData, engineHookLog)
    }

    const slot = await projectExecutionConcurrencyGuard.acquire({ projectId: binding.projectId, log: engineHookLog })
    try {
        return await userInteractionWatcher.submitAndWaitForResponse<ExecuteTriggerResponse<HT>>(jobData, engineHookLog)
    }
    finally {
        await slot.release()
    }
}

type CreateParams = {
    request: CreateTriggerBindingRequest
    projectId: ProjectId
    platformId: PlatformId
}

type GetOneParams = {
    id: string
    projectId: ProjectId
    platformId: PlatformId
}

type ListParams = {
    projectId: ProjectId
    platformId: PlatformId
}

type UpdateParams = {
    id: string
    projectId: ProjectId
    platformId: PlatformId
    request: UpdateTriggerBindingRequest
}

type ExecuteRunParams = {
    id: string
    triggerPayload?: unknown
}

export type ExecuteEngineHookParams<HT extends TriggerHookType> = {
    binding: TriggerBinding
    hookType: HT
    triggerPayload?: unknown
}
