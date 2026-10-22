import { AnalyticsRunsUsageItem, AnalyticsTimePeriod, PlatformAnalyticsReport } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import {
    filterReportByTimePeriod,
    getDateRange,
    mergeRuns,
    platformAnalyticsReportRepo,
    platformAnalyticsReportService,
} from '../../../../src/app/analytics/platform-analytics-report.service'

describe('Platform Analytics Report Service - Unit', () => {
    describe('mergeRuns', () => {
        it('merges runs by flowId and day, summing run counts', () => {
            const existing: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow1', day: '2026-01-01', runs: 5 },
                { flowId: 'flow2', day: '2026-01-01', runs: 3 },
            ]
            const incoming: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow1', day: '2026-01-01', runs: 2 },
                { flowId: 'flow1', day: '2026-01-02', runs: 1 },
            ]

            const result = mergeRuns(existing, incoming)

            expect(result).toHaveLength(3)
            const flow1Day1 = result.find(r => r.flowId === 'flow1' && r.day === '2026-01-01')
            expect(flow1Day1?.runs).toBe(7)
        })

        it('handles empty existing array', () => {
            const incoming: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow1', day: '2026-01-01', runs: 5 },
            ]
            const result = mergeRuns([], incoming)
            expect(result).toEqual(incoming)
        })

        it('handles empty incoming array', () => {
            const existing: AnalyticsRunsUsageItem[] = [
                { flowId: 'flow1', day: '2026-01-01', runs: 5 },
            ]
            const result = mergeRuns(existing, [])
            expect(result).toEqual(existing)
        })
    })

    describe('getDateRange', () => {
        it('returns correct date for LAST_WEEK', () => {
            const result = getDateRange(AnalyticsTimePeriod.LAST_WEEK)
            const expected = dayjs().subtract(1, 'week').startOf('day').toISOString()
            expect(dayjs(result).isSame(dayjs(expected), 'day')).toBe(true)
        })

        it('returns correct date for LAST_MONTH', () => {
            const result = getDateRange(AnalyticsTimePeriod.LAST_MONTH)
            const expected = dayjs().subtract(1, 'month').startOf('day').toISOString()
            expect(dayjs(result).isSame(dayjs(expected), 'day')).toBe(true)
        })

        it('returns correct date for LAST_THREE_MONTHS', () => {
            const result = getDateRange(AnalyticsTimePeriod.LAST_THREE_MONTHS)
            const expected = dayjs().subtract(3, 'month').startOf('day').toISOString()
            expect(dayjs(result).isSame(dayjs(expected), 'day')).toBe(true)
        })

        it('returns correct date for LAST_SIX_MONTHS', () => {
            const result = getDateRange(AnalyticsTimePeriod.LAST_SIX_MONTHS)
            const expected = dayjs().subtract(6, 'month').startOf('day').toISOString()
            expect(dayjs(result).isSame(dayjs(expected), 'day')).toBe(true)
        })

        it('returns correct date for LAST_YEAR', () => {
            const result = getDateRange(AnalyticsTimePeriod.LAST_YEAR)
            const expected = dayjs().subtract(1, 'year').startOf('day').toISOString()
            expect(dayjs(result).isSame(dayjs(expected), 'day')).toBe(true)
        })

        it('throws on invalid time period', () => {
            // @ts-expect-error testing invalid time period runtime error
            expect(() => getDateRange('invalid')).toThrow('Invalid time period')
        })
    })

    describe('filterReportByTimePeriod', () => {
        const platformId = 'plat_test123'
        const recentRun: AnalyticsRunsUsageItem = {
            flowId: 'flow-recent',
            day: dayjs().subtract(2, 'day').format('YYYY-MM-DD'),
            runs: 10,
        }
        const oldRun: AnalyticsRunsUsageItem = {
            flowId: 'flow-old',
            day: dayjs().subtract(20, 'day').format('YYYY-MM-DD'),
            runs: 5,
        }
        const veryOldRun: AnalyticsRunsUsageItem = {
            flowId: 'flow-very-old',
            day: dayjs().subtract(400, 'day').format('YYYY-MM-DD'),
            runs: 2,
        }

        const baseReport: PlatformAnalyticsReport = {
            id: 'report1',
            platformId,
            cachedAt: dayjs().toISOString(),
            created: dayjs().toISOString(),
            updated: dayjs().toISOString(),
            outdated: false,
            runs: [recentRun, oldRun, veryOldRun],
            flows: [],
            users: [],
        }

        it('returns unfiltered report when no timePeriod provided', () => {
            const result = filterReportByTimePeriod(baseReport)
            expect(result.runs).toHaveLength(3)
        })

        it('filters runs by LAST_WEEK keeping only recent runs', () => {
            const result = filterReportByTimePeriod(baseReport, AnalyticsTimePeriod.LAST_WEEK)
            expect(result.runs).toHaveLength(1)
            expect(result.runs[0]?.flowId).toBe('flow-recent')
        })

        it('filters runs by LAST_MONTH keeping runs within 1 month', () => {
            const result = filterReportByTimePeriod(baseReport, AnalyticsTimePeriod.LAST_MONTH)
            expect(result.runs).toHaveLength(2)
            expect(result.runs.map(r => r.flowId)).toEqual(['flow-recent', 'flow-old'])
        })

        it('returns empty runs when all are before date range', () => {
            const ancientReport: PlatformAnalyticsReport = {
                ...baseReport,
                runs: [veryOldRun],
            }
            const result = filterReportByTimePeriod(ancientReport, AnalyticsTimePeriod.LAST_WEEK)
            expect(result.runs).toHaveLength(0)
        })
    })

    describe('exports', () => {
        it('exports service functions and pure helpers', () => {
            expect(typeof platformAnalyticsReportService).toBe('function')
            expect(typeof platformAnalyticsReportRepo).toBe('function')
            expect(typeof mergeRuns).toBe('function')
            expect(typeof filterReportByTimePeriod).toBe('function')
            expect(typeof getDateRange).toBe('function')
        })
    })
})
