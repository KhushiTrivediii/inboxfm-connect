import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { connectMcpHttpController } from '../mcp/oauth/mcp-oauth.controller'
import { connectMcpController } from './connect-mcp.controller'

export const connectMcpModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(connectMcpController, { prefix: '/v1/connect-mcp' })
    await app.register(connectMcpHttpController, { prefix: '/v1/connect-mcp' })
}
