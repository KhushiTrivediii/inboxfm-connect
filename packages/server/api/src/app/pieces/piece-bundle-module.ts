import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { pieceBundle } from './piece-bundle'
import { pieceBundleController } from './piece-bundle-controller'

export const pieceBundleModule: FastifyPluginAsyncZod = async (app) => {
    // The lazy S3-caching job for resolved bundles was equally dropped in the migration — its
    // registration belongs with the only route that enqueues it.
    pieceBundle(app.log).registerJobHandler()
    await app.register(pieceBundleController, { prefix: '/v1/engine/pieces' })
}
