import dayjs from 'dayjs'
import { AnalyticsTimePeriod } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    platformAnalyticsReportRepo,
    platformAnalyticsReportService,
} from '../../../../src/app/analytics/platform-analytics-report.service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
    await databaseConnection().getRepository('platform_analytics_report').delete({ platformId: ctx.platform.id })
})

afterEach(async () => {
    vi.restoreAllMocks()
    await databaseConnection().getRepository('platform_analytics_report').delete({ platformId: ctx.platform.id })
})

describe('Platform Analytics Report lifecycle', () => {
    it('creates a new report on first refresh', async () => {
        const report = await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
        
        expect(report).toBeDefined()
        expect(report.platformId).toBe(ctx.platform.id)
        expect(report.outdated).toBe(false)
        expect(report.cachedAt).toBeDefined()
        expect(Array.isArray(report.runs)).toBe(true)
        expect(Array.isArray(report.flows)).toBe(true)
        expect(Array.isArray(report.users)).toBe(true)
    })

    it('updates existing report on subsequent refresh', async () => {
        const firstReport = await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
        const firstId = firstReport.id
        
        await databaseConnection().getRepository('platform_analytics_report').update(
            { platformId: ctx.platform.id },
            { cachedAt: dayjs().subtract(1, 'second').toISOString() }
        )
        
        const secondReport = await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
        
        expect(secondReport.id).toBe(firstId)
        expect(secondReport.cachedAt).not.toBe(firstReport.cachedAt)
    })

    it('marks report as outdated', async () => {
        await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
        await platformAnalyticsReportService(ctx.log).markAsOutdated(ctx.platform.id)
        
        const report = await platformAnalyticsReportRepo().findOneBy({ platformId: ctx.platform.id })
        expect(report?.outdated).toBe(true)
    })

    it('regenerates report when outdated', async () => {
        const firstReport = await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
        await platformAnalyticsReportService(ctx.log).markAsOutdated(ctx.platform.id)
        
        const regeneratedReport = await platformAnalyticsReportService(ctx.log).getOrGenerateReport(ctx.platform.id)
        
        expect(regeneratedReport.outdated).toBe(false)
        expect(regeneratedReport.cachedAt).not.toBe(firstReport.cachedAt)
    })

    it('regenerates report when cachedAt is older than 5 minutes', async () => {
        const firstReport = await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
        
        await databaseConnection().getRepository('platform_analytics_report').update(
            { platformId: ctx.platform.id },
            { cachedAt: dayjs().subtract(10, 'minute').toISOString() }
        )
        
        const regeneratedReport = await platformAnalyticsReportService(ctx.log).getOrGenerateReport(ctx.platform.id)
        
        expect(regeneratedReport.cachedAt).not.toBe(firstReport.cachedAt)
    })

    it('returns cached report when fresh and not outdated', async () => {
        const firstReport = await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
        const secondReport = await platformAnalyticsReportService(ctx.log).getOrGenerateReport(ctx.platform.id)
        
        expect(secondReport.id).toBe(firstReport.id)
        expect(dayjs(secondReport.cachedAt).toISOString()).toBe(dayjs(firstReport.cachedAt).toISOString())
    })

    it('filters report by time period', async () => {
        const recentDay = dayjs().subtract(2, 'day').format('YYYY-MM-DD')
        const oldDay = dayjs().subtract(20, 'day').format('YYYY-MM-DD')

        await platformAnalyticsReportRepo().save({
            id: 'report-filter-test',
            platformId: ctx.platform.id,
            cachedAt: dayjs().toISOString(),
            runs: [
                { flowId: 'flow-recent', day: recentDay, runs: 10 },
                { flowId: 'flow-old', day: oldDay, runs: 5 },
            ],
            flows: [],
            users: [],
            created: dayjs().toISOString(),
            outdated: false,
            updated: dayjs().toISOString(),
        })

        const fullReport = await platformAnalyticsReportService(ctx.log).getOrGenerateReport(ctx.platform.id)
        expect(fullReport.runs).toHaveLength(2)

        const filteredReport = await platformAnalyticsReportService(ctx.log).getOrGenerateReport(
            ctx.platform.id, 
            AnalyticsTimePeriod.LAST_WEEK
        )
        expect(filteredReport.runs).toHaveLength(1)
        expect(filteredReport.runs[0]?.flowId).toBe('flow-recent')
    })

    it('enforces project scoping - reports isolated by platform', async () => {
        const ctx2 = await createTestContext(app!)
        try {
            const report1 = await platformAnalyticsReportService(ctx.log).refreshReport(ctx.platform.id)
            const report2 = await platformAnalyticsReportService(ctx.log).refreshReport(ctx2.platform.id)
            
            expect(report1.platformId).toBe(ctx.platform.id)
            expect(report2.platformId).toBe(ctx2.platform.id)
            expect(report1.id).not.toBe(report2.id)
        } finally {
            await databaseConnection().getRepository('platform_analytics_report').delete({ platformId: ctx2.platform.id })
        }
    })
})
