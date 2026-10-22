import { EmbedSubdomainStatus } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Race regression (issue F43): the embed-subdomain upsert performed a
// read-check-write sequence around a SLOW external Cloudflare call with no
// serialization. Two concurrent upserts of the same hostname (double-click,
// retry, or two platforms fighting over one hostname) both passed the
// existence checks, both called createCustomHostname (the loser leaks a
// paid Cloudflare custom-hostname resource forever — hostnameExists then
// reports the hostname as permanently taken), and then collided on the
// unique hostname index: the loser surfaced a raw TypeORM QueryFailedError
// (HTTP 500). Same-platform same-hostname double-fire also raced the
// platformId-unique insert.
//
// The fix serializes the whole check -> CF create -> save sequence behind
// the distributed lock (RedLock runExclusive, same mutex the
// concurrency-pool and app-connection services use), keyed on the
// hostname so cross-platform hostname fights serialize too. The in-lock
// re-checks still arbitrate (unique indexes remain the final guard), and
// a save that still loses (e.g. lock fail-open) no longer leaks: the
// just-created Cloudflare resource is deleted best-effort before
// rethrowing a 409 VALIDATION error.

const mockFindOneBy = vi.fn()
const mockSave = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOneBy: mockFindOneBy,
        save: mockSave,
    }),
}))

const mockRunExclusive = vi.fn()

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({
        runExclusive: mockRunExclusive,
    }),
}))

const mockHostnameExists = vi.fn()
const mockCreateCustomHostname = vi.fn()
const mockDeleteCustomHostname = vi.fn()

vi.mock('../../../../../src/app/ee/embed-subdomain/cloudflare.service', () => ({
    cloudflareService: () => ({
        hostnameExists: mockHostnameExists,
        createCustomHostname: mockCreateCustomHostname,
        deleteCustomHostname: mockDeleteCustomHostname,
    }),
}))

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

type EmbedSubdomainService = ReturnType<typeof import('../../../../../src/app/ee/embed-subdomain/embed-subdomain.service').embedSubdomainService>

async function loadService(): Promise<EmbedSubdomainService> {
    const mod = await import('../../../../../src/app/ee/embed-subdomain/embed-subdomain.service')
    return mod.embedSubdomainService(mockLog)
}

// RedLock semantics: run the caller's fn under the lock, then release.
async function realRunExclusive<T>({ fn }: { fn: () => Promise<T> }): Promise<T> {
    return fn()
}

// Serializing RedLock semantics for the concurrency tests: each locked fn
// only starts after the previous one fully settled (what runExclusive
// guarantees with a real Redis behind it).
let lockChain: Promise<unknown> = Promise.resolve()
async function serializingRunExclusive<T>({ fn }: { fn: () => Promise<T> }): Promise<T> {
    const run = lockChain.then(() => fn())
    lockChain = run.then(() => undefined, () => undefined)
    return run
}

const activeCfResult = {
    cloudflareId: 'cf-new',
    hostname: 'app.customer.com',
    verificationRecords: [{ type: 'CNAME', name: 'app.customer.com', value: 'cloud.activepieces.com', purpose: 'HOSTNAME' }],
    status: 'pending',
    sslStatus: 'pending_validation',
}

const savedRow = {
    id: 'sub_1',
    platformId: 'platform-1',
    hostname: 'app.customer.com',
    status: EmbedSubdomainStatus.PENDING_VERIFICATION,
    cloudflareId: 'cf-new',
    verificationRecords: activeCfResult.verificationRecords,
}

describe('embedSubdomainService.upsert race (issue F43)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
        mockRunExclusive.mockImplementation(realRunExclusive)
    })

    it('serializes the check -> Cloudflare create -> save sequence behind the distributed lock', async () => {
        mockFindOneBy.mockResolvedValue(null)
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockResolvedValue(activeCfResult)
        mockSave.mockResolvedValue(savedRow)

        const service = await loadService()
        await service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' })

        expect(mockRunExclusive).toHaveBeenCalledTimes(1)
        const lockArgs = mockRunExclusive.mock.calls[0][0]
        expect(lockArgs.key).toContain('app.customer.com')
        expect(mockCreateCustomHostname).toHaveBeenCalledTimes(1)
        expect(mockSave).toHaveBeenCalledTimes(1)
        // The lookup and the CF create must run INSIDE the locked fn.
        const sequence: string[] = []
        mockFindOneBy.mockImplementationOnce(async () => {
            sequence.push('findOneBy')
            return null
        })
        mockCreateCustomHostname.mockImplementationOnce(async () => {
            sequence.push('createCustomHostname')
            return activeCfResult
        })
        mockRunExclusive.mock.calls.length = 0
        await service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' })
        expect(sequence).toEqual(['findOneBy', 'createCustomHostname'])
    })

    it('two overlapping first-writes for one hostname: loser runs strictly after the winner commits and creates exactly one Cloudflare resource', async () => {
        // With runExclusive the loser's locked fn only starts after the
        // winner's fn (and its save commit) fully settled, so the loser's
        // re-check sees the winner's row and reuses it.
        mockRunExclusive.mockImplementation(serializingRunExclusive)
        const winnerRow = { ...savedRow }
        let winnerDone = false
        // The winner's INSERT generates its own apId; the loser must reuse
        // whatever the winner actually committed, so track the saved row.
        let committedRow: Record<string, unknown> | null = null

        mockFindOneBy.mockImplementation(async ({ platformId }: { platformId?: string }) => {
            if (winnerDone) {
                return committedRow === null ? winnerRow : { ...committedRow as Record<string, unknown>, platformId: platformId ?? (committedRow as Record<string, unknown>).platformId }
            }
            return null
        })
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockImplementation(async () => {
            winnerDone = true
            return activeCfResult
        })
        mockSave.mockImplementation(async (row: Record<string, unknown>) => {
            committedRow = { ...savedRow, ...row }
            return committedRow
        })

        const service = await loadService()
        const [first, second] = await Promise.all([
            service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' }),
            service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' }),
        ])

        // Exactly one Cloudflare custom hostname is ever created.
        expect(mockCreateCustomHostname).toHaveBeenCalledTimes(1)
        // Both requests resolve (no raw QueryFailedError 500).
        expect(first.hostname).toBe('app.customer.com')
        expect(second.hostname).toBe('app.customer.com')
        // The loser reuses the winner's committed row instead of inserting.
        expect(mockSave).toHaveBeenCalledTimes(1)
        expect(first.id).toBe(second.id)
    })

    it('cross-platform hostname fight: second platform gets VALIDATION error, never a raw unique-violation 500, and no second CF resource is created', async () => {
        // Platform-1 wins the hostname under the lock. Platform-2's locked fn
        // then sees the colliding row and exits with the domain-taken
        // VALIDATION error before ever calling Cloudflare.
        const winnerRow = { ...savedRow, platformId: 'platform-1' }
        let winnerCommitted = false

        mockFindOneBy.mockImplementation(async (criteria: { platformId?: string, hostname?: string }) => {
            if (criteria?.platformId === 'platform-1' && !winnerCommitted) {
                return null
            }
            if (criteria?.platformId === 'platform-1') {
                return winnerRow
            }
            // hostname lookup for platform-2
            if (criteria?.hostname === 'app.customer.com') {
                return winnerCommitted ? winnerRow : null
            }
            return null
        })
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockImplementation(async () => {
            winnerCommitted = true
            return activeCfResult
        })
        mockSave.mockImplementation(async (row: Record<string, unknown>) => ({ ...savedRow, ...row }))

        const service = await loadService()
        const first = await service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' })
        expect(first.platformId).toBe('platform-1')

        await expect(service.upsert({ platformId: 'platform-2', hostname: 'app.customer.com' }))
            .rejects
            .toMatchObject({ error: { code: 'VALIDATION' } })

        // Exactly one CF resource for the hostname across both platforms.
        expect(mockCreateCustomHostname).toHaveBeenCalledTimes(1)
        expect(mockSave).toHaveBeenCalledTimes(1)
    })

    it('when the save still loses after the CF create (lock fail-open window), the just-created Cloudflare resource is deleted best-effort and a VALIDATION error is thrown', async () => {
        // Simulates the residual fail-open interleaving: the re-check passed,
        // CF create succeeded, but the insert hits the unique index anyway.
        mockFindOneBy.mockResolvedValue(null)
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockResolvedValue(activeCfResult)
        const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint "idx_embed_subdomain_hostname"'), { code: '23505' })
        mockSave.mockRejectedValueOnce(uniqueViolation)

        const service = await loadService()
        await expect(service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' }))
            .rejects
            .toMatchObject({ error: { code: 'VALIDATION' } })

        // The orphaned paid resource is cleaned up best-effort.
        expect(mockDeleteCustomHostname).toHaveBeenCalledTimes(1)
        expect(mockDeleteCustomHostname.mock.calls[0][0]).toMatchObject({ cloudflareId: 'cf-new' })
    })

    it('a non-unique save error (e.g. DB outage) propagates untouched and never deletes the Cloudflare resource', async () => {
        // codeant #460: only a save that lost a UNIQUE-INDEX race may take
        // the conflict branch. Anything else (connection drop, constraint
        // change) must surface the real error - the row may still commit
        // on a retry, so the Cloudflare resource must stay.
        mockFindOneBy.mockResolvedValue(null)
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockResolvedValue(activeCfResult)
        const dbOutage = new Error('Connection terminated due to connection timeout')
        mockSave.mockRejectedValueOnce(dbOutage)

        const service = await loadService()
        await expect(service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' }))
            .rejects
            .toBe(dbOutage)

        // The Cloudflare resource is NOT deleted and no misleading 409 is thrown.
        expect(mockDeleteCustomHostname).not.toHaveBeenCalled()
    })

    it('a Cloudflare cleanup failure after a lost save still rethrows the VALIDATION error (never masks it)', async () => {
        mockFindOneBy.mockResolvedValue(null)
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockResolvedValue(activeCfResult)
        mockSave.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }))
        mockDeleteCustomHostname.mockRejectedValueOnce(new Error('cloudflare down'))

        const service = await loadService()
        await expect(service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' }))
            .rejects
            .toMatchObject({ error: { code: 'VALIDATION' } })
        expect(mockDeleteCustomHostname).toHaveBeenCalledTimes(1)
    })

    it('same-hostname idempotent upsert short-circuits before any Cloudflare call (existing behavior preserved)', async () => {
        mockFindOneBy.mockResolvedValue(savedRow)
        const service = await loadService()

        const result = await service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' })

        expect(result).toBe(savedRow)
        expect(mockCreateCustomHostname).not.toHaveBeenCalled()
        expect(mockSave).not.toHaveBeenCalled()
    })

    it('lock acquisition failure fails open: the upsert still runs and succeeds without the lock', async () => {
        // Doctrine (same as #410): a Redis outage must never block
        // subdomain setup - the lock is an optimization, not a dependency.
        // Here the save wins the race, so fail-open resolves normally.
        mockFindOneBy.mockResolvedValue(null)
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockResolvedValue(activeCfResult)
        mockSave.mockResolvedValue(savedRow)
        mockRunExclusive.mockImplementation(async ({ fn: _fn }: { fn: () => Promise<unknown> }) => {
            throw new Error('redlock unavailable')
        })

        const service = await loadService()
        const result = await service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' })
        expect(result.hostname).toBe('app.customer.com')
        expect(mockSave).toHaveBeenCalledTimes(1)
    })

    it('lock acquisition failure fails open and a losing save still cleans up the Cloudflare resource', async () => {
        // Fail-open + residual race: the re-checks passed, CF create
        // succeeded, but the insert hit the unique index anyway. The
        // VALIDATION error + best-effort cleanup must still fire.
        mockFindOneBy.mockResolvedValue(null)
        mockHostnameExists.mockResolvedValue(false)
        mockCreateCustomHostname.mockResolvedValue(activeCfResult)
        mockSave.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }))
        mockRunExclusive.mockImplementation(async ({ fn: _fn }: { fn: () => Promise<unknown> }) => {
            throw new Error('redlock unavailable')
        })

        const service = await loadService()
        await expect(service.upsert({ platformId: 'platform-1', hostname: 'app.customer.com' }))
            .rejects
            .toMatchObject({ error: { code: 'VALIDATION' } })
        expect(mockDeleteCustomHostname).toHaveBeenCalledTimes(1)
    })
})
