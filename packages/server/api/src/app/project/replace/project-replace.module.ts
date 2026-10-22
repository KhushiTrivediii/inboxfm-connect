import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { projectReplaceController } from './project-replace.controller'

export const projectReplaceModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(projectReplaceController, { prefix: '/v1/projects/:projectId/replace' })
}
