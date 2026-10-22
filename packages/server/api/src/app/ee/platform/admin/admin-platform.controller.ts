import { timingSafeEqual } from 'node:crypto'
import { isNil } from '@inboxfm-connect/core-utils'
import { AiMetadata, Audience, ErrorHandlingOptionsParam, type OutputSchema, PieceMetadata, PieceMetadataModel, WebhookRenewConfiguration } from '@inboxfm-connect/pieces-framework'
import { ApplyLicenseKeyByEmailRequestBody, ExactVersionType, IncreaseAICreditsForPlatformRequestBody, PackageType, PieceCategory, PieceType, TriggerStrategy, TriggerTestStrategy, WebhookHandshakeConfiguration } from '@inboxfm-connect/shared'
import { FastifyReply, FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { pieceMetadataService } from '../../../pieces/metadata/piece-metadata-service'

import { workerGroupService } from '../platform-plan/worker-group.service'
import { adminPlatformService } from './admin-platform.service'

const API_KEY_HEADER = 'api-key'
const API_KEY = system.get(AppSystemProp.API_KEY)

// Constant-time key comparison: a plain `!==` returns at the first differing
// byte and leaks a prefix-based timing signal to unauthenticated probes
// (see issue #369). timingSafeEqual is flat for equal-length buffers; the
// length check first avoids its throw — the length itself is not secret
// material. Mirrors the sandbox WS handshake pattern in sandbox.ts.
async function checkCertainKeyPreHandler(
    req: FastifyRequest,
    res: FastifyReply,
): Promise<void> {

    const key = req.headers[API_KEY_HEADER] as string | undefined
    if (isNil(key) || isNil(API_KEY)) {
        await res.status(StatusCodes.FORBIDDEN).send({ message: 'Forbidden' })
        throw new Error('Forbidden')
    }
    const a = Buffer.from(key)
    const b = Buffer.from(API_KEY)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        await res.status(StatusCodes.FORBIDDEN).send({ message: 'Forbidden' })
        throw new Error('Forbidden')
    }
}

export const adminPlatformModule: FastifyPluginAsyncZod = async (app) => {
    app.addHook('preHandler', checkCertainKeyPreHandler)
    await app.register(adminPlatformController, { prefix: '/v1/admin/' })
}

const adminPlatformController: FastifyPluginAsyncZod = async (
    app,
) => {

    app.post('/pieces', CreatePieceRequest, async (req): Promise<PieceMetadataModel> => {
        return pieceMetadataService(req.log).create({
            pieceMetadata: req.body as PieceMetadata,
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
        })
    },
    )


    app.post('/platforms/apply-license-key', ApplyLicenseKeyByEmailRequest, async (req, res) => {
        await adminPlatformService(req.log).applyLicenseKeyByEmail(req.body)
        return res.status(StatusCodes.OK).send()
    })

    app.post('/platforms/increase-ai-credits', IncreaseAICreditsForPlatformRequest, async (req, res) => {
        await adminPlatformService(req.log).increaseAiCredits(req.body)
        return res.status(StatusCodes.OK).send()
    })

    app.post('/platforms/worker-group', UpdateWorkerGroupRequest, async (req, res) => {
        const { platformId, workerGroupId } = req.body
        await workerGroupService(req.log).moveJobsToTargetQueue({ platformId, workerGroupId })
        await workerGroupService(req.log).updateWorkerGroup({ platformId, workerGroupId })
        return res.status(StatusCodes.OK).send()
    })

}


const UpdateWorkerGroupRequest = {
    schema: {
        body: z.object({
            platformId: z.string(),
            workerGroupId: z.string().nullable(),
        }),
    },
    config: {
        security: securityAccess.public(),
    },
}

const ApplyLicenseKeyByEmailRequest = {
    schema: {
        body: ApplyLicenseKeyByEmailRequestBody,
    },
    config: {
        security: securityAccess.public(),
    },
}

const IncreaseAICreditsForPlatformRequest = {
    schema: {
        body: IncreaseAICreditsForPlatformRequestBody,
    },
    config: {
        security: securityAccess.public(),
    },
}


const Action = z.object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    requireAuth: z.boolean(),
    props: z.unknown(),
    errorHandlingOptions: z.optional(ErrorHandlingOptionsParam),
    outputSchema: z.optional(z.custom<OutputSchema>()),
    aiMetadata: z.optional(AiMetadata),
    audience: z.optional(Audience),
})

const Trigger = Action.omit({ audience: true }).extend({
    renewConfiguration: z.optional(WebhookRenewConfiguration),
    handshakeConfiguration: WebhookHandshakeConfiguration,
    sampleData: z.unknown().optional(),
    type: z.nativeEnum(TriggerStrategy),
    testStrategy: z.nativeEnum(TriggerTestStrategy),
})

const CreatePieceRequest = {
    schema: {
        body: z.object({
            name: z.string(),
            displayName: z.string(),
            logoUrl: z.string(),
            description: z.string().optional(),
            version: ExactVersionType,
            auth: z.unknown().optional(),
            authors: z.array(z.string()),
            categories: z.array(z.nativeEnum(PieceCategory)).optional(),
            minimumSupportedRelease: ExactVersionType,
            maximumSupportedRelease: ExactVersionType,
            actions: z.record(z.string(), Action),
            triggers: z.record(z.string(), Trigger),
            i18n: z.record(z.string(), z.record(z.string(), z.string())).optional(),
        }),
    },
    config: {
        security: securityAccess.public(),
    },
}


