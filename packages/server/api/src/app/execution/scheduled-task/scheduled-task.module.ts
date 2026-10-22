import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { scheduledTaskController } from './scheduled-task.controller'
import { scheduledTaskService } from './scheduled-task.service'

export const scheduledTaskModule: FastifyPluginAsyncZod = async (app) => {
    try {
        const { registered, skipped, total } = await scheduledTaskService.reRegisterEnabledSchedules({ log: app.log })
        app.log.info({ registered, skipped, total }, '[scheduledTaskModule] Re-registered enabled scheduled tasks on boot')
    }
    catch (error) {
        app.log.error({ error }, '[scheduledTaskModule] Failed to re-register scheduled tasks on boot')
    }
    await app.register(scheduledTaskController, { prefix: '/v1/scheduled-tasks' })
}
