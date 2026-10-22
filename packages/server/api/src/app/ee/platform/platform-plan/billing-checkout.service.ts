import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { PlanName, STANDARD_CLOUD_PLAN } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { distributedLock } from '../../../database/redis-connections'
import { platformService } from '../../../platform/platform.service'
import { userService } from '../../../user/user-service'
import { platformPlanService } from './platform-plan.service'
import { stripeHelper } from './stripe-helper'

async function create({ platformId, newActiveFlowsLimit, log }: CreateCheckoutParams): Promise<{ stripeCheckoutUrl: string, url: string }> {
    const helper = stripeHelper(log)
    const stripe = helper.getStripe()
    if (isNil(stripe)) {
        throw validationError('Stripe billing is not configured on this instance')
    }
    const extraActiveFlows = newActiveFlowsLimit - (STANDARD_CLOUD_PLAN.activeFlowsLimit ?? 0)
    if (extraActiveFlows <= 0) {
        throw validationError('The requested limit must exceed the included active flows limit')
    }

    return distributedLock(log).runExclusive({
        key: `platform-billing-checkout:${platformId}`,
        timeoutInSeconds: 60,
        fn: async () => {
            const plan = await platformPlanService(log).getOrCreateForPlatform(platformId)
            if (plan.plan !== PlanName.STANDARD) {
                throw validationError('This plan does not support self-service subscription checkout')
            }
            if (!isNil(plan.stripeSubscriptionId)) {
                throw validationError('Manage the existing subscription in the billing portal')
            }

            let customerId = plan.stripeCustomerId
            if (isNil(customerId)) {
                const platform = await platformService(log).getOneOrThrow(platformId)
                const owner = await userService(log).getMetaInformation({ id: platform.ownerId })
                customerId = await helper.createCustomer(owner, platformId)
                await platformPlanService(log).update({ platformId, stripeCustomerId: customerId })
            }

            const stripeCheckoutUrl = await helper.createNewSubscriptionCheckoutSession({ platformId, customerId, extraActiveFlows })
            return { stripeCheckoutUrl, url: stripeCheckoutUrl }
        },
    })
}

function validationError(message: string): ActivepiecesError {
    return new ActivepiecesError({ code: ErrorCode.VALIDATION, params: { message } })
}

export const billingCheckoutService = { create }

type CreateCheckoutParams = {
    platformId: string
    newActiveFlowsLimit: number
    log: FastifyBaseLogger
}
