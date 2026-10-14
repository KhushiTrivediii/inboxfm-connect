import { apId, isNil, PlatformId } from '@inboxfm-connect/core-utils'
import { AnalyticsFlowReportItem, AnalyticsRunsUsageItem, AnalyticsTimePeriod, PlatformAnalyticsReport, UserWithMetaInformation } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../core/db/repo-factory'
import { distributedLock } from '../database/redis-connections'
import { userRepo } from '../user/user-service'
import { PlatformAnalyticsReportEntity } from './platform-analytics-report.entity'

export const platformAnalyticsReportRepo = repoFactory(PlatformAnalyticsReportEntity)

export const platformAnalyticsReportService = (log: FastifyBaseLogger) => ({
    refreshReport: async (platformId: PlatformId) => {
        return distributedLock(log).runExclusive({
            key: `platform-analytics-report-${platformId}`,
            timeoutInSeconds: 400,
            fn: async () => {
                const currentReport = await platformAnalyticsReportRepo().findOneBy({ platformId })
                const cachedAt = dayjs().toISOString()
                const users = await listUsers(platformId)
                const flows = await listFlows(platformId, log)
                const runs = await listRuns(flows.map((flow) => flow.projectId), currentReport?.cachedAt ?? null, cachedAt)

                return platformAnalyticsReportRepo().save({
                    id: currentReport?.id ?? apId(),
                    platformId,
                    cachedAt,
                    runs: mergeRuns(currentReport?.runs ?? [], runs),
                    flows,
                    users,
                    created: cachedAt,
                    outdated: false,
                    updated: cachedAt,
                })
            },
        })
    },
    markAsOutdated: async (platformId: PlatformId) => {
        return platformAnalyticsReportRepo().update({ platformId }, { outdated: true })
    },
    getOrGenerateReport: async (platformId: PlatformId, timePeriod?: AnalyticsTimePeriod): Promise<PlatformAnalyticsReport> => {
        let report = await platformAnalyticsReportRepo().findOneBy({ platformId })
        if (isNil(report) || report.outdated || dayjs().diff(dayjs(report.cachedAt), 'minute') >= 5) {
            report = await platformAnalyticsReportService(log).refreshReport(platformId)
        }
        return filterReportByTimePeriod(report, timePeriod)
    },
})



async function listRuns(_projectIds: string[], _afterDate: string | null, _currentDate: string): Promise<AnalyticsRunsUsageItem[]> {
    return []
}

export function mergeRuns(existing: AnalyticsRunsUsageItem[], incoming: AnalyticsRunsUsageItem[]): AnalyticsRunsUsageItem[] {
    const map = new Map(existing.map(run => [`${run.flowId}-${run.day}`, { ...run }]))
    for (const run of incoming) {
        const key = `${run.flowId}-${run.day}`
        if (map.has(key)) {
            map.get(key)!.runs += run.runs
        }
        else {
            map.set(key, { ...run })
        }
    }
    return Array.from(map.values())
}
async function listFlows(_platformId: PlatformId, _log: FastifyBaseLogger): Promise<AnalyticsFlowReportItem[]> {
    return []
}

async function listUsers(platformId: PlatformId): Promise<UserWithMetaInformation[]> {
    const users = await userRepo().find({
        where: {
            platformId,
        },
        relations: {
            identity: true,
        },
        // Whole-platform refresh (result cached ~5 min): fetch only the columns
        // the report maps instead of every user and identity column - identity
        // rows carry password hashes, tokenVersion, imageUrl and other unmapped
        // data that dominated the transfer on a large platform. Same query
        // shape, same mapped output.
        select: {
            id: true,
            status: true,
            platformRole: true,
            lastActiveDate: true,
            created: true,
            updated: true,
            identity: {
                email: true,
                firstName: true,
                lastName: true,
            },
        },
    })
    return users.map((user) => {
        return {
            id: user.id,
            email: user.identity.email,
            firstName: user.identity.firstName,
            lastName: user.identity.lastName,
            status: user.status,
            lastActiveDate: user.lastActiveDate,
            platformRole: user.platformRole,
            created: user.created,
            updated: user.updated,
        }
    })
}

export function filterReportByTimePeriod(
    report: PlatformAnalyticsReport, 
    timePeriod?: AnalyticsTimePeriod, 
): PlatformAnalyticsReport {
    if (!timePeriod) {
        return report
    }
    
    const dateRange = getDateRange(timePeriod)
    const runs = report.runs.filter((run) => dayjs(run.day).isAfter(dayjs(dateRange)))
    
    return {
        ...report,
        runs,
    }
}

export function getDateRange(timePeriod: AnalyticsTimePeriod): string {
    const date = dayjs()
    switch (timePeriod) {
        case AnalyticsTimePeriod.LAST_WEEK:
            return date.subtract(1, 'week').startOf('day').toISOString()
        case AnalyticsTimePeriod.LAST_MONTH:
            return date.subtract(1, 'month').startOf('day').toISOString()
        case AnalyticsTimePeriod.LAST_THREE_MONTHS:
            return date.subtract(3, 'month').startOf('day').toISOString()
        case AnalyticsTimePeriod.LAST_SIX_MONTHS:
            return date.subtract(6, 'month').startOf('day').toISOString()
        case AnalyticsTimePeriod.LAST_YEAR:
            return date.subtract(1, 'year').startOf('day').toISOString()
        default:
            throw new Error(`Invalid time period: ${timePeriod}`)
    }
}

export const platformAnalyticsTesting = {
    mergeRuns,
    filterReportByTimePeriod,
    getDateRange,
}
