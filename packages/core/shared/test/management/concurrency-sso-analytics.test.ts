import { describe, it, expect } from 'vitest'
import { apId } from '@inboxfm-connect/core-utils'
import { FlowStatus } from '@inboxfm-connect/core-execution'
import { ConcurrencyPool } from '../../src/lib/management/platform/concurrency-pool'
import {
    SsoDomainVerification,
    SsoDomainVerificationRecordType,
    SsoDomainVerificationStatus,
} from '../../src/lib/management/platform/sso-domain-verification'
import {
    AnalyticsTimePeriod,
    AnalyticsRunsUsageItem,
    AnalyticsFlowReportItem,
    AnalyticsReportRequest,
} from '../../src/lib/management/analytics'

describe('Concurrency Pool, SSO Domain, and Analytics Contracts', () => {
    const validId = apId()
    const validPlatformId = apId()

    describe('ConcurrencyPool contract', () => {
        it('should validate a complete ConcurrencyPool entity', () => {
            const valid = {
                id: validId,
                created: '2026-10-01T00:00:00.000Z',
                updated: '2026-10-01T00:00:00.000Z',
                platformId: validPlatformId,
                key: 'pool_enterprise_workers',
                maxConcurrentJobs: 16,
            }
            const parsed = ConcurrencyPool.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.maxConcurrentJobs).toBe(16)
                expect(parsed.data.key).toBe('pool_enterprise_workers')
            }
        })

        it('should reject non-positive or fractional maxConcurrentJobs', () => {
            const zeroJobs = {
                id: validId,
                created: '2026-10-01T00:00:00.000Z',
                updated: '2026-10-01T00:00:00.000Z',
                platformId: validPlatformId,
                key: 'pool_test',
                maxConcurrentJobs: 0,
            }
            expect(ConcurrencyPool.safeParse(zeroJobs).success).toBe(false)

            const fractionalJobs = {
                ...zeroJobs,
                maxConcurrentJobs: 2.5,
            }
            expect(ConcurrencyPool.safeParse(fractionalJobs).success).toBe(false)
        })
    })

    describe('SSO Domain Verification contracts', () => {
        it('should export correct enum constants for status and record type', () => {
            expect(SsoDomainVerificationStatus.PENDING_VERIFICATION).toBe('PENDING_VERIFICATION')
            expect(SsoDomainVerificationStatus.VERIFIED).toBe('VERIFIED')
            expect(SsoDomainVerificationRecordType.TXT).toBe('TXT')
        })

        it('should validate valid SsoDomainVerification record', () => {
            const valid = {
                status: SsoDomainVerificationStatus.PENDING_VERIFICATION,
                record: {
                    type: SsoDomainVerificationRecordType.TXT,
                    name: '_activepieces-challenge.example.com',
                    value: 'challenge_token_12345',
                },
                createdAt: '2026-10-01T00:00:00.000Z',
            }
            const parsed = SsoDomainVerification.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.record.type).toBe('TXT')
            }
        })

        it('should reject invalid verification status or record types', () => {
            const invalid = {
                status: 'REJECTED_INVALID',
                record: {
                    type: 'CNAME',
                    name: 'name',
                    value: 'val',
                },
                createdAt: '2026-10-01T00:00:00.000Z',
            }
            expect(SsoDomainVerification.safeParse(invalid).success).toBe(false)
        })
    })

    describe('Analytics contracts', () => {
        it('should export all AnalyticsTimePeriod enum options', () => {
            expect(AnalyticsTimePeriod.LAST_WEEK).toBe('last-week')
            expect(AnalyticsTimePeriod.LAST_MONTH).toBe('last-month')
            expect(AnalyticsTimePeriod.LAST_THREE_MONTHS).toBe('last-three-months')
            expect(AnalyticsTimePeriod.LAST_SIX_MONTHS).toBe('last-six-months')
            expect(AnalyticsTimePeriod.LAST_YEAR).toBe('last-year')
        })

        it('should validate AnalyticsRunsUsageItem', () => {
            const valid = {
                day: '2026-10-01',
                flowId: 'flow_123',
                runs: 350,
            }
            expect(AnalyticsRunsUsageItem.safeParse(valid).success).toBe(true)
        })

        it('should validate AnalyticsFlowReportItem with nullable fields', () => {
            const valid = {
                flowId: 'flow_123',
                flowName: 'Sync Stripe Invoices',
                projectId: 'proj_456',
                projectName: 'Finance Automations',
                status: FlowStatus.ENABLED,
                timeSavedPerRun: 15,
                ownerId: 'usr_owner_1',
            }
            expect(AnalyticsFlowReportItem.safeParse(valid).success).toBe(true)

            const nullableValid = {
                ...valid,
                timeSavedPerRun: null,
                ownerId: null,
            }
            expect(AnalyticsFlowReportItem.safeParse(nullableValid).success).toBe(true)
        })

        it('should validate AnalyticsReportRequest with optional time periods', () => {
            expect(AnalyticsReportRequest.safeParse({}).success).toBe(true)
            expect(AnalyticsReportRequest.safeParse({ timePeriod: AnalyticsTimePeriod.LAST_MONTH }).success).toBe(true)
            expect(AnalyticsReportRequest.safeParse({ timePeriod: 'invalid_period' }).success).toBe(false)
        })
    })
})
