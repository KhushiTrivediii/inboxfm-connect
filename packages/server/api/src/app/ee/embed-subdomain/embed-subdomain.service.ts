import { ActivepiecesError, apId, ErrorCode, isNil, tryCatch } from '@inboxfm-connect/core-utils'
import { EmbedSubdomain, EmbedSubdomainStatus } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../core/db/repo-factory'
import { distributedLock } from '../../database/redis-connections'
import { cloudflareService } from './cloudflare.service'
import { EmbedSubdomainEntity } from './embed-subdomain.entity'

const repo = repoFactory<EmbedSubdomain>(EmbedSubdomainEntity)

// Upsert race guard (issue F43): the embed-subdomain upsert performs a
// read-check-write sequence around a SLOW external Cloudflare call with no
// serialization. Two overlapping upserts of the same hostname (double-click,
// retry, or two platforms claiming one hostname) both passed the existence
// checks, both called createCustomHostname - leaking an orphaned paid
// Cloudflare custom-hostname resource that permanently poisons
// hostnameExists for that hostname - and then collided on the unique
// hostname/platformId indexes, surfacing a raw TypeORM QueryFailedError
// (HTTP 500) to the loser. Serialize the whole check -> Cloudflare create
// -> save sequence behind the distributed lock (RedLock runExclusive, the
// same mutex the concurrency-pool and app-connection services use), keyed
// on the hostname so cross-platform hostname fights serialize too. The
// in-lock re-checks still arbitrate first, and the unique indexes remain
// the final guard: if the save still loses after the Cloudflare resource
// was created (lock fail-open window), the just-created resource is
// deleted best-effort before rethrowing a 409 VALIDATION error instead of
// leaking it. Fail-open on lock unavailability so a Redis outage never
// blocks subdomain setup.
const LOCK_TIMEOUT_SECONDS = 60

function buildUpsertLockKey({ hostname }: { hostname: string }): string {
    return ['embed-subdomain', 'upsert', hostname].join(':')
}

async function runUpsertExclusiveOrWithoutLock<T>({ hostname, fn, log }: {
    hostname: string
    fn: () => Promise<T>
    log: FastifyBaseLogger
}): Promise<T> {
    const key = buildUpsertLockKey({ hostname })
    let fnSettled = false
    try {
        return await distributedLock(log).runExclusive({
            key,
            timeoutInSeconds: LOCK_TIMEOUT_SECONDS,
            fn: async () => {
                try {
                    return await fn()
                }
                finally {
                    // Mark settled on EVERY exit path (throw AND success):
                    // a lock-infra error surfacing after a successful fn must
                    // not take the fail-open branch and run fn twice.
                    fnSettled = true
                }
            },
        })
    }
    catch (error) {
        if (fnSettled) {
            throw error
        }
        log.warn({ error, lockKey: key }, 'Embed subdomain upsert lock unavailable - failing open')
        return fn()
    }
}

export const embedSubdomainService = (log: FastifyBaseLogger) => ({
    async upsert({ platformId, hostname }: { platformId: string, hostname: string }): Promise<EmbedSubdomain> {
        return runUpsertExclusiveOrWithoutLock({
            hostname,
            log,
            fn: () => upsertLocked({ platformId, hostname, log }),
        })
    },

    async getByPlatformId({ platformId }: { platformId: string }): Promise<EmbedSubdomain | null> {
        return repo().findOneBy({ platformId })
    },

    async checkAndUpdateStatus({ platformId }: { platformId: string }): Promise<EmbedSubdomain | null> {
        const record = await repo().findOneBy({ platformId })
        if (isNil(record) || record.status === EmbedSubdomainStatus.ACTIVE) {
            return record
        }

        const statusResult = await tryCatch(() => cloudflareService(log).getCustomHostname({ cloudflareId: record.cloudflareId }))
        if (statusResult.error) {
            log.warn({ platform: { id: platformId }, cloudflareId: record.cloudflareId, error: statusResult.error }, 'Failed to refresh hostname status from Cloudflare; returning cached record')
            return record
        }
        const cloudflareStatus = statusResult.data
        const newStatus = mapCloudflareStatus({ status: cloudflareStatus.status, sslStatus: cloudflareStatus.sslStatus })


        const recordsChanged = JSON.stringify(record.verificationRecords) !== JSON.stringify(cloudflareStatus.verificationRecords)
        if (newStatus !== record.status || recordsChanged) {
            log.info({ platform: { id: platformId }, oldStatus: record.status, newStatus, cloudflareStatus: cloudflareStatus.status, sslStatus: cloudflareStatus.sslStatus }, 'Embed hostname status refreshed')
            return repo().save({
                ...record,
                status: newStatus,
                verificationRecords: cloudflareStatus.verificationRecords,
            })
        }

        return record
    },

    async getActiveSubdomainUrl({ platformId }: { platformId: string }): Promise<string | null> {
        const record = await repo().findOneBy({ platformId })
        if (isNil(record) || record.status !== EmbedSubdomainStatus.ACTIVE) {
            return null
        }
        return `https://${record.hostname}`
    },

    async getByHostname({ hostname }: { hostname: string }): Promise<EmbedSubdomain | null> {
        return repo().findOneBy({ hostname })
    },
})

async function upsertLocked({ platformId, hostname, log }: { platformId: string, hostname: string, log: FastifyBaseLogger }): Promise<EmbedSubdomain> {
    const existing = await repo().findOneBy({ platformId })
    if (!isNil(existing) && existing.hostname === hostname) {
        return existing
    }

    const collidingDb = await repo().findOneBy({ hostname })
    if (!isNil(collidingDb) && collidingDb.platformId !== platformId) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: 'This hostname is already in use',
            },
        })
    }

    const existsInCloudflare = await cloudflareService(log).hostnameExists({ hostname })
    if (existsInCloudflare) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: 'This hostname is already registered with Cloudflare',
            },
        })
    }

    const newCloudflare = await cloudflareService(log).createCustomHostname({ hostname })

    try {
        if (isNil(existing)) {
            const subdomain: Omit<EmbedSubdomain, 'created' | 'updated'> = {
                id: apId(),
                platformId,
                hostname,
                status: mapCloudflareStatus({ status: newCloudflare.status, sslStatus: newCloudflare.sslStatus }),
                cloudflareId: newCloudflare.cloudflareId,
                verificationRecords: newCloudflare.verificationRecords,
            }
            return await repo().save(subdomain)
        }

        const oldCloudflareId = existing.cloudflareId
        const updated = await repo().save({
            ...existing,
            hostname,
            cloudflareId: newCloudflare.cloudflareId,
            verificationRecords: newCloudflare.verificationRecords,
            status: mapCloudflareStatus({ status: newCloudflare.status, sslStatus: newCloudflare.sslStatus }),
        })

        const deleteResult = await tryCatch(() => cloudflareService(log).deleteCustomHostname({ cloudflareId: oldCloudflareId }))
        if (deleteResult.error) {
            log.warn({ platform: { id: platformId }, oldCloudflareId, error: deleteResult.error }, 'Failed to delete previous Cloudflare custom hostname; manual cleanup may be required')
        }

        return updated
    }
    catch (error) {
        // The unique indexes on hostname and platformId remain the final
        // guard. ONLY a save that lost a unique-index race may take this
        // branch: there the just-created Cloudflare custom hostname would
        // be orphaned forever (hostnameExists then reports this hostname
        // as permanently taken, and it keeps billing), so it is deleted
        // best-effort before rethrowing a 409 VALIDATION instead of the
        // raw TypeORM QueryFailedError (HTTP 500). Any OTHER save failure
        // (DB outage, constraint shape change) must propagate untouched:
        // the Cloudflare resource stays (the row may still be committed
        // by a retry) and the caller sees the real error, never a
        // misleading "hostname already in use" 409. (codeant #460)
        if (!isUniqueViolationError(error)) {
            throw error
        }
        const cleanup = await tryCatch(() => cloudflareService(log).deleteCustomHostname({ cloudflareId: newCloudflare.cloudflareId }))
        if (cleanup.error) {
            log.error({ platform: { id: platformId }, cloudflareId: newCloudflare.cloudflareId, cleanupError: cleanup.error, saveError: error }, 'Failed to clean up Cloudflare custom hostname after a lost upsert race; manual cleanup required')
        }
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: 'This hostname is already in use',
            },
        })
    }
}

// TypeORM wraps Postgres unique-index violations in a QueryFailedError whose
// driver-level code is 23505. Matching on the driver code (not the message)
// keeps this branch tied to the race-losing case only.
function isUniqueViolationError(error: unknown): boolean {
    const candidate = error as { code?: string, driverError?: { code?: string } }
    return candidate?.code === '23505' || candidate?.driverError?.code === '23505'
}

function mapCloudflareStatus({ status, sslStatus }: { status: string | undefined, sslStatus: string | undefined }): EmbedSubdomainStatus {
    if (status === 'active' && sslStatus === 'active') {
        return EmbedSubdomainStatus.ACTIVE
    }
    if (!isNil(status) && FAILED_STATUSES.has(status)) {
        return EmbedSubdomainStatus.FAILED
    }
    return EmbedSubdomainStatus.PENDING_VERIFICATION
}

const FAILED_STATUSES = new Set([
    'blocked',
    'pending_blocked',
    'test_blocked',
    'test_failed',
    'pending_deletion',
])
