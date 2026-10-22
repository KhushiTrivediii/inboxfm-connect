import { isNil } from '@inboxfm-connect/core-utils'
import { ApSubscriptionStatus, PlanName, STANDARD_CLOUD_PLAN } from '@inboxfm-connect/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import Stripe from 'stripe'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { distributedStore } from '../../../database/redis-connections'
import { exceptionHandler } from '../../../helper/exception-handler'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { platformAiCreditsService } from './platform-ai-credits.service'
import { ACTIVE_FLOW_PRICE_ID, platformPlanService } from './platform-plan.service'
import { StripeCheckoutType, stripeHelper } from './stripe-helper'

export const stripeBillingController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post(
        '/stripe/webhook',
        WebhookRequest,
        async (request: FastifyRequest, reply) => {
            try {
                const payload = request.rawBody as string
                const signature = request.headers['stripe-signature'] as string

                const stripe = stripeHelper(request.log).getStripe()
                if (isNil(stripe)) { 
                    return await reply.status(StatusCodes.OK).send({ received: true })
                }

                const webhookSecret = system.getOrThrow(AppSystemProp.STRIPE_WEBHOOK_SECRET)
                const webhook = stripe.webhooks.constructEvent(
                    payload,
                    signature,
                    webhookSecret,
                )

                switch (webhook.type) {
                    case 'checkout.session.completed': {
                        const session = webhook.data.object
                        if (isNil(session.metadata)) {
                            break
                        } 

                        if (session.metadata.type === StripeCheckoutType.AI_CREDIT_PAYMENT) {
                            const sessionId = session.id
                            const creditKey = `stripe_credit_processed_${sessionId}`
                            const notYetProcessed = await distributedStore.putIfAbsent(creditKey, 1, 86400 * 30)
                            if (notYetProcessed) {
                                try {
                                    const platformId = session.metadata.platformId as string
                                    const intent = await stripe.paymentIntents.retrieve(
                                        session.payment_intent as string,
                                    )
                                    const amountInCents = intent.amount
                                    const amountInUsd = amountInCents / 100

                                    await platformAiCreditsService(request.log).aiCreditsPaymentSucceeded(platformId, amountInUsd, StripeCheckoutType.AI_CREDIT_PAYMENT)
                                }
                                catch (err) {
                                    await distributedStore.delete(creditKey)
                                    throw err
                                }
                            }
                            else {
                                request.log.info({ sessionId }, 'Duplicate AI credit checkout session completed, skipping credit grant')
                            }
                        }
                        if (session.metadata.type === StripeCheckoutType.AI_CREDIT_AUTO_TOP_UP) {
                            const setupIntent = await stripe.setupIntents.retrieve(
                                session.setup_intent as string,
                            )

                            const paymentMethodId = setupIntent.payment_method as string
                            const platformId = session.metadata.platformId as string
                            await platformAiCreditsService(request.log).handleAutoTopUpCheckoutSessionCompleted(platformId, paymentMethodId)
                        }
                        break
                    }
                    case 'invoice.paid': {
                        const invoice = webhook.data.object as Stripe.Invoice
                        const subscriptionId = extractSubscriptionIdFromInvoice(invoice)

                        if (!isNil(subscriptionId)) {
                            const stripe = stripeHelper(request.log).getStripe()
                            if (!isNil(stripe)) {
                                const subscription = await stripe.subscriptions.retrieve(subscriptionId)
                                const platformId = subscription.metadata?.platformId
                                if (typeof platformId === 'string' && subscription.status === 'active') {
                                    await platformPlanService(request.log).update({
                                        platformId,
                                        stripeSubscriptionStatus: ApSubscriptionStatus.ACTIVE,
                                    })
                                }
                            }
                        }

                        if (!isNil(invoice.metadata) && invoice.metadata.type === StripeCheckoutType.AI_CREDIT_AUTO_TOP_UP) {
                            const invoiceId = invoice.id
                            const creditKey = `stripe_credit_processed_${invoiceId}`
                            const notYetProcessed = await distributedStore.putIfAbsent(creditKey, 1, 86400 * 30)
                            if (notYetProcessed) {
                                try {
                                    const platformId = invoice.metadata.platformId as string
                                    const amountInCents = invoice.amount_paid
                                    const amountInUsd = amountInCents / 100
                                    await platformAiCreditsService(request.log).aiCreditsPaymentSucceeded(platformId, amountInUsd, StripeCheckoutType.AI_CREDIT_AUTO_TOP_UP)
                                }
                                catch (err) {
                                    await distributedStore.delete(creditKey)
                                    throw err
                                }
                            }
                            else {
                                request.log.info({ invoiceId }, 'Duplicate invoice.paid AI credit top-up ignored')
                            }
                        }
                        break
                    }
                    case 'invoice.payment_failed': {
                        const invoice = webhook.data.object as Stripe.Invoice
                        const subscriptionId = extractSubscriptionIdFromInvoice(invoice)

                        if (!isNil(subscriptionId)) {
                            const stripe = stripeHelper(request.log).getStripe()
                            if (!isNil(stripe)) {
                                const subscription = await stripe.subscriptions.retrieve(subscriptionId)
                                const platformId = subscription.metadata?.platformId
                                if (typeof platformId === 'string') {
                                    // Resilient to out-of-order events: verify live status from Stripe
                                    if (subscription.status === 'past_due') {
                                        request.log.warn({ platformId, subscriptionId }, 'Stripe subscription invoice payment failed, entering past_due state')
                                        await platformPlanService(request.log).update({
                                            platformId,
                                            stripeSubscriptionStatus: ApSubscriptionStatus.PAST_DUE,
                                        })
                                    }
                                    else if (subscription.status === 'unpaid') {
                                        request.log.warn({ platformId, subscriptionId }, 'Stripe subscription invoice payment failed, entering unpaid state')
                                        await platformPlanService(request.log).update({
                                            platformId,
                                            stripeSubscriptionStatus: ApSubscriptionStatus.UNPAID,
                                        })
                                    }
                                    else if (subscription.status === 'active') {
                                        request.log.info({ platformId, subscriptionId, liveStatus: subscription.status }, 'Stale invoice.payment_failed event ignored because subscription is currently active in Stripe')
                                    }
                                }
                            }
                        }
                        break
                    }
                    case 'customer.subscription.deleted': 
                    case 'customer.subscription.created':
                    case 'customer.subscription.updated': {
                        const subscription = webhook.data.object as Stripe.Subscription
                        const platformId = subscription.metadata?.platformId
                        if (isNil(platformId)) {
                            request.log.warn({ subscriptionId: subscription.id }, 'Stripe subscription missing platformId metadata, skipping update')
                            break
                        }

                        const { startDate, endDate, cancelDate } = await stripeHelper(request.log).getSubscriptionCycleDates(subscription)

                        const extraActiveFlows = subscription.items.data.find(item => ACTIVE_FLOW_PRICE_ID === item.price.id)?.quantity ?? 0
                        const newLimits = { ...STANDARD_CLOUD_PLAN }

                        const subscriptionEnded = webhook.type === 'customer.subscription.deleted'
                        if (subscriptionEnded) {
                            await platformPlanService(request.log).update({ 
                                ...newLimits,
                                platformId,
                                plan: PlanName.STANDARD,
                                stripeSubscriptionStatus: ApSubscriptionStatus.CANCELED,
                                stripeSubscriptionId: undefined,
                                stripeSubscriptionStartDate: undefined,
                                stripeSubscriptionEndDate: undefined,
                                stripeSubscriptionCancelDate: undefined,
                            })
                            break
                        }

                        if (extraActiveFlows > 0) {
                            newLimits.activeFlowsLimit = (newLimits.activeFlowsLimit ?? 0) + extraActiveFlows
                        }

                        let stripeSubscriptionStatus: ApSubscriptionStatus
                        switch (subscription.status) {
                            case 'active':
                                stripeSubscriptionStatus = ApSubscriptionStatus.ACTIVE
                                break
                            case 'past_due':
                                stripeSubscriptionStatus = ApSubscriptionStatus.PAST_DUE
                                break
                            case 'unpaid':
                                stripeSubscriptionStatus = ApSubscriptionStatus.UNPAID
                                break
                            case 'incomplete':
                                stripeSubscriptionStatus = ApSubscriptionStatus.INCOMPLETE
                                break
                            case 'incomplete_expired':
                                stripeSubscriptionStatus = ApSubscriptionStatus.INCOMPLETE_EXPIRED
                                break
                            case 'trialing':
                                stripeSubscriptionStatus = ApSubscriptionStatus.TRIALING
                                break
                            case 'paused':
                                stripeSubscriptionStatus = ApSubscriptionStatus.PAUSED
                                break
                            default:
                                stripeSubscriptionStatus = ApSubscriptionStatus.CANCELED
                                break
                        }

                        await platformPlanService(request.log).update({ 
                            ...newLimits,
                            platformId,
                            plan: PlanName.STANDARD,
                            stripeSubscriptionId: subscription.id,
                            stripeSubscriptionStatus,
                            stripeSubscriptionStartDate: startDate,
                            stripeSubscriptionEndDate: endDate,
                            stripeSubscriptionCancelDate: cancelDate,
                        })
                        break
                    }
                    default:
                        request.log.info({ webhookType: webhook.type }, 'Unhandled webhook event type')
                        break
                }
                return await reply.status(StatusCodes.OK).send({ received: true })
            }
            catch (err) {
                request.log.error({ error: err }, 'Stripe webhook processing failed')
                exceptionHandler.handle(err, request.log)
                return reply
                    .status(StatusCodes.BAD_REQUEST)
                    .send('Invalid webhook signature')
            }
        },
    )
}

function extractSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | undefined {
    const parentSubscription = invoice.parent?.subscription_details?.subscription
    if (typeof parentSubscription === 'string') {
        return parentSubscription
    }
    if (!isNil(parentSubscription) && typeof parentSubscription === 'object' && 'id' in parentSubscription && typeof parentSubscription.id === 'string') {
        return parentSubscription.id
    }

    if (invoice.lines?.data) {
        for (const line of invoice.lines.data) {
            const lineSubscription = line.subscription
            if (typeof lineSubscription === 'string') {
                return lineSubscription
            }
            if (!isNil(lineSubscription) && typeof lineSubscription === 'object' && 'id' in lineSubscription && typeof lineSubscription.id === 'string') {
                return lineSubscription.id
            }
        }
    }

    return undefined
}

const WebhookRequest = {
    config: {
        security: securityAccess.public(),
        rawBody: true,
    },
}

