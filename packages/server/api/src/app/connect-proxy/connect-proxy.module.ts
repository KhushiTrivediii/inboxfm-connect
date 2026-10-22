import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { connectProxyController } from './connect-proxy.controller'

export const connectProxyModule: FastifyPluginAsyncTypebox = async (app) => {
    await app.register(connectProxyController, { prefix: '/v1/connect-proxy' })
}
