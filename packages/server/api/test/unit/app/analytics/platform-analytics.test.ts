import { AnalyticsRunsUsageItem, AnalyticsTimePeriod, PlatformAnalyticsReport, PlatformRole, UserStatus } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { piecesAnalyticsService } from '../../../../src/app/analytics/pieces-analytics.service'
import { platformAnalyticsTesting } from '../../../../src/app/analytics/platform-analytics-report.service'

const { mergeRuns, filterReportByTimePeriod, getDateRange } = platformAnalyticsTesting

describe('platform-analytics unit tests (Issue #137)', () => {
    describe('mergeRuns', () => {
        it('returns empty array when both existing and incoming runs are empty', () => {
            const merged = mergeRuns([], [])
            expect(merged).toEqual([])
        })

        it('returns incoming runs when existing runs array is empty', () => {
            const incoming: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow-1', day: '2026-03-01', runs: 5 },
                { flowId: 'flow-2', day: '2026-03-01', runs: 12 },
            ]
            const merged = mergeRuns([], incoming)
            expect(merged).toHaveLength(2)
            expect(merged).toEqual(incoming)
        })

        it('accumulates run counts when flowId and day match', () => {
            const existing: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow-1', day: '2026-03-01', runs: 10 },
                { flowId: 'flow-2', day: '2026-03-01', runs: 5 },
            ]
            const incoming: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow-1', day: '2026-03-01', runs: 15 },
                { flowId: 'flow-3', day: '2026-03-01', runs: 7 },
            ]

            const merged = mergeRuns(existing, incoming)
            expect(merged).toHaveLength(3)

            const flow1 = merged.find((r) => r.flowId === 'flow-1')
            expect(flow1?.runs).toBe(25)

            const flow2 = merged.find((r) => r.flowId === 'flow-2')
            expect(flow2?.runs).toBe(5)

            const flow3 = merged.find((r) => r.flowId === 'flow-3')
            expect(flow3?.runs).toBe(7)
        })

        it('maintains separate entries when same flowId runs across different days', () => {
            const existing: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow-1', day: '2026-03-01', runs: 10 },
            ]
            const incoming: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow-1', day: '2026-03-02', runs: 8 },
            ]

            const merged = mergeRuns(existing, incoming)
            expect(merged).toHaveLength(2)
            expect(merged.find((r) => r.day === '2026-03-01')?.runs).toBe(10)
            expect(merged.find((r) => r.day === '2026-03-02')?.runs).toBe(8)
        })
    })

    describe('getDateRange', () => {
        it('calculates expected startOf day date strings for standard time periods', () => {
            const now = dayjs()
            const weekDate = getDateRange(AnalyticsTimePeriod.LAST_WEEK)
            expect(dayjs(weekDate).isValid()).toBe(true)
            expect(dayjs(weekDate).isBefore(now)).toBe(true)

            const monthDate = getDateRange(AnalyticsTimePeriod.LAST_MONTH)
            expect(dayjs(monthDate).isBefore(dayjs(weekDate))).toBe(true)

            const threeMonths = getDateRange(AnalyticsTimePeriod.LAST_THREE_MONTHS)
            expect(dayjs(threeMonths).isBefore(dayjs(monthDate))).toBe(true)

            const sixMonths = getDateRange(AnalyticsTimePeriod.LAST_SIX_MONTHS)
            expect(dayjs(sixMonths).isBefore(dayjs(threeMonths))).toBe(true)

            const yearDate = getDateRange(AnalyticsTimePeriod.LAST_YEAR)
            expect(dayjs(yearDate).isBefore(dayjs(sixMonths))).toBe(true)
        })

        it('throws descriptive error on invalid time period string', () => {
            expect(() => getDateRange('INVALID_PERIOD' as AnalyticsTimePeriod)).toThrow('Invalid time period: INVALID_PERIOD')
        })
    })

    describe('filterReportByTimePeriod', () => {
        const createMockReport = (): PlatformAnalyticsReport => ({
            id: 'report-1',
            platformId: 'plat-1',
            cachedAt: dayjs().toISOString(),
            outdated: false,
            created: dayjs().toISOString(),
            updated: dayjs().toISOString(),
            users: [
                {
                    id: 'u1',
                    email: 'test@example.com',
                    firstName: 'Test',
                    lastName: 'User',
                    status: UserStatus.ACTIVE,
                    lastActiveDate: dayjs().toISOString(),
                    platformRole: PlatformRole.ADMIN,
                    created: dayjs().toISOString(),
                    updated: dayjs().toISOString(),
                },
            ],
            flows: [],
            runs: [
                { flowId: 'f1', day: dayjs().subtract(2, 'day').format('YYYY-MM-DD'), runs: 10 },
                { flowId: 'f1', day: dayjs().subtract(2, 'week').format('YYYY-MM-DD'), runs: 20 },
                { flowId: 'f1', day: dayjs().subtract(2, 'month').format('YYYY-MM-DD'), runs: 30 },
                { flowId: 'f1', day: dayjs().subtract(5, 'month').format('YYYY-MM-DD'), runs: 40 },
                { flowId: 'f1', day: dayjs().subtract(8, 'month').format('YYYY-MM-DD'), runs: 50 },
                { flowId: 'f1', day: dayjs().subtract(2, 'year').format('YYYY-MM-DD'), runs: 60 },
            ],
        })

        it('returns report unchanged if timePeriod is undefined', () => {
            const report = createMockReport()
            const filtered = filterReportByTimePeriod(report)
            expect(filtered).toEqual(report)
        })

        it('filters runs within LAST_WEEK window', () => {
            const report = createMockReport()
            const filtered = filterReportByTimePeriod(report, AnalyticsTimePeriod.LAST_WEEK)
            expect(filtered.runs).toHaveLength(1)
            expect(filtered.runs[0].runs).toBe(10)
        })

        it('filters runs within LAST_MONTH window', () => {
            const report = createMockReport()
            const filtered = filterReportByTimePeriod(report, AnalyticsTimePeriod.LAST_MONTH)
            expect(filtered.runs).toHaveLength(2)
        })

        it('filters runs within LAST_THREE_MONTHS window', () => {
            const report = createMockReport()
            const filtered = filterReportByTimePeriod(report, AnalyticsTimePeriod.LAST_THREE_MONTHS)
            expect(filtered.runs).toHaveLength(3)
        })

        it('filters runs within LAST_SIX_MONTHS window', () => {
            const report = createMockReport()
            const filtered = filterReportByTimePeriod(report, AnalyticsTimePeriod.LAST_SIX_MONTHS)
            expect(filtered.runs).toHaveLength(4)
        })

        it('filters runs within LAST_YEAR window', () => {
            const report = createMockReport()
            const filtered = filterReportByTimePeriod(report, AnalyticsTimePeriod.LAST_YEAR)
            expect(filtered.runs).toHaveLength(5)
        })
    })

    describe('piecesAnalyticsService', () => {
        it('initializes service without throwing', async () => {
            const mockLog = {
                info: () => {},
                error: () => {},
                warn: () => {},
                debug: () => {},
                trace: () => {},
                fatal: () => {},
                child: () => mockLog,
            } as unknown as import('fastify').FastifyBaseLogger

            await expect(piecesAnalyticsService(mockLog).init()).resolves.toBeUndefined()
        })
    })
})
