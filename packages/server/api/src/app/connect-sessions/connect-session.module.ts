import { apDayjs } from '@inboxfm-connect/server-utils'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { SystemJobName } from '../helper/system-jobs/common'
import { systemJobHandlers } from '../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../helper/system-jobs/system-job'
import { connectSessionAuthenticatedController, connectSessionPublicController } from './connect-session.controller'
import { connectSessionService } from './connect-session.service'

// Original, from-scratch implementation — no dependency on packages/server/api/src/app/ee/.
// Available on every edition; this is core to the Connect platform, not a paid add-on.
//
// Connect sessions are single-use and short-lived, but nothing ever removed them: every
// created session left a permanent row behind. This hourly job deletes sessions whose
// expiry passed more than a day ago — dead rows whose token no longer authorizes
// anything — in bounded batches, so the table stays flat on high-volume deployments.
const CONNECT_SESSION_CLEANUP_CRON = '15 */1 * * *'
const CONNECT_SESSION_CLEANUP_RETENTION_DAYS = 1

export const connectSessionModule: FastifyPluginAsyncZod = async (app) => {
    systemJobHandlers.registerJobHandler(SystemJobName.CONNECT_SESSION_CLEANUP, async () => {
        const cleanupBoundary = apDayjs().subtract(CONNECT_SESSION_CLEANUP_RETENTION_DAYS, 'day').toISOString()
        const deleted = await connectSessionService.deleteExpiredBefore({ boundaryIso: cleanupBoundary })
        if (deleted > 0) {
            app.log.info({ deleted }, '[connectSessionCleanup] Removed expired connect sessions')
        }
    })
    await systemJobsSchedule(app.log).upsertJob({
        job: {
            name: SystemJobName.CONNECT_SESSION_CLEANUP,
            data: {},
            jobId: SystemJobName.CONNECT_SESSION_CLEANUP,
        },
        schedule: {
            type: 'repeated',
            cron: CONNECT_SESSION_CLEANUP_CRON,
        },
    })
    await app.register(connectSessionAuthenticatedController, { prefix: '/v1/connect-sessions' })
    await app.register(connectSessionPublicController, { prefix: '/v1/connect-sessions' })
}
