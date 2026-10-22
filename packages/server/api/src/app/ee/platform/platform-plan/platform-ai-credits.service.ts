import { AIProviderName, apId, assertNotNullOrUndefined, isNil, tryCatch } from '@inboxfm-connect/core-utils'
import { ActivePiecesProviderAuthConfig, AiCreditsAutoTopUpState, CreateAICreditCheckoutSessionParamsSchema, PlatformPlan, UpdateAICreditsAutoTopUpParamsSchema } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderEntity, AIProviderSchema } from '../../../ai/ai-provider-entity'
import { aiProviderService } from '../../../ai/ai-provider-service'
import { repoFactory } from '../../../core/db/repo-factory'
import { distributedLock, distributedStore } from '../../../database/redis-connections'
import { flagService } from '../../../flags/flag.service'
import { encryptUtils } from '../../../helper/encryption'
import { exceptionHandler } from '../../../helper/exception-handler'
import { rejectedPromiseHandler } from '../../../helper/promise-handler'
import { sleep } from '../../../helper/sleep'
import { SystemJobName } from '../../../helper/system-jobs/common'
import { systemJobHandlers } from '../../../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../../../helper/system-jobs/system-job'
import { openRouterApi, OpenRouterApikey } from './openrouter/openrouter-api'
import { platformPlanService } from './platform-plan.service'
import { StripeCheckoutType, stripeHelper } from './stripe-helper'

const CREDIT_PER_DOLLAR = 1000
const USAGE_CACHE_TTL_SECONDS = 180
const aiProviderRepo = repoFactory<AIProviderSchema>(AIProviderEntity)

export const platformAiCreditsService = (log: FastifyBaseLogger) => ({
    async init(): Promise<void> {
        systemJobHandlers.registerJobHandler(SystemJobName.AI_CREDIT_UPDATE_CHECK, async ({ apiKeyHash, platformId }) => {
            log.info('(platformAiCreditsService) AI credit update check')
            try {
                await distributedLock(log).runExclusive({
                    key: `ai_credits_update_${platformId}`,
                    timeoutInSeconds: 100,
                    fn: async () => {
                        const plan = await platformPlanService(log).getOrCreateForPlatform(platformId)

                        await tryResetPlanIncludedCredits(plan, apiKeyHash, log)
                        const autoToppedUp = await tryAutoTopUpPlan(plan, apiKeyHash, log)

                        if (autoToppedUp) {
                            await sleep(30000) // 30 seconds to wait for stripe to complete
                        }
                    },
                })
            }
            catch (e) {
                log.error(e, '(platformAiCreditsService) AI credit update check failed')
                throw e
            }
        })
    },

    isEnabled(): boolean {
        return flagService(log).aiCreditsEnabled()
    },

    async getUsage(platformId: string): Promise<APIKeyUsage> {
        if (!this.isEnabled()) {
            return {
                usage: 0,
                limit: 0,
                usageMonthly: 0,
                usageRemaining: 0,
            }
        }

        const auth = await aiProviderService(log).getActivepiecesProviderIfEnriched(platformId)
        if (isNil(auth)) {
            const platformPlan = await platformPlanService(log).getOrCreateForPlatform(platformId)

            return {
                usage: 0,
                limit: platformPlan.includedAiCredits,
                usageMonthly: 0,
                usageRemaining: platformPlan.includedAiCredits,
            }
        }

        assertNotNullOrUndefined(auth.apiKeyHash, 'apiKeyHash is required')

        const usage = await getOpenRouterUsageCached(auth.apiKeyHash, log)

        return {
            usageMonthly: usage.usage_monthly * CREDIT_PER_DOLLAR,
            usageRemaining: usage.limit_remaining! * CREDIT_PER_DOLLAR,
            usage: usage.usage * CREDIT_PER_DOLLAR,
            limit: usage.limit! * CREDIT_PER_DOLLAR,
        }
    },

    async updateAutoTopUp(platformId: string, request: UpdateAICreditsAutoTopUpParamsSchema): Promise<{ stripeCheckoutUrl?: string }> {
        const plan = await platformPlanService(log).getOrCreateForPlatform(platformId)

        if (request.state === AiCreditsAutoTopUpState.DISABLED) {
            await platformPlanService(log).update({
                platformId,
                aiCreditsAutoTopUpState: AiCreditsAutoTopUpState.DISABLED,
            })
            return {}
        }

        await platformPlanService(log).update({
            platformId,
            aiCreditsAutoTopUpCreditsToAdd: request.creditsToAdd,
            aiCreditsAutoTopUpThreshold: request.minThreshold,
            maxAutoTopUpCreditsMonthly: request.maxMonthlyLimit,
        })

        assertNotNullOrUndefined(plan.stripeCustomerId, 'Stripe customer id is not set')
        const paymentMethod = await stripeHelper(log).getPaymentMethod(plan.stripeCustomerId)
        if (!isNil(paymentMethod)) {
            await platformPlanService(log).update({
                platformId,
                aiCreditsAutoTopUpState: AiCreditsAutoTopUpState.ENABLED,
            })

            return {}
        }

        const stripeCheckoutUrl = await stripeHelper(log).createNewAICreditAutoTopUpCheckoutSession({
            platformId,
            customerId: plan.stripeCustomerId,
        })

        await platformPlanService(log).update({
            platformId,
            aiCreditsAutoTopUpState: AiCreditsAutoTopUpState.DISABLED,
        })

        return { stripeCheckoutUrl }
    },

    async handleAutoTopUpCheckoutSessionCompleted(platformId: string, paymentMethodId: string): Promise<void> {
        await platformPlanService(log).update({
            platformId,
            aiCreditsAutoTopUpState: AiCreditsAutoTopUpState.ENABLED,
        })

        const plan = await platformPlanService(log).getOrCreateForPlatform(platformId)
        assertNotNullOrUndefined(plan.stripeCustomerId, 'Stripe customer id is not set')

        await stripeHelper(log).attachPaymentMethodToCustomer(paymentMethodId, plan.stripeCustomerId)
    },

    async initializeStripeAiCreditsPayment(platformId: string, { aiCredits }: CreateAICreditCheckoutSessionParamsSchema): Promise<{ stripeCheckoutUrl: string }> {
        const { stripeCustomerId: customerId } = await platformPlanService(log).getOrCreateForPlatform(platformId)
        assertNotNullOrUndefined(customerId, 'Stripe customer id is not set')

        const amountInUsd = aiCredits / CREDIT_PER_DOLLAR

        const stripeCheckoutUrl = await stripeHelper(log).createNewAICreditPaymentCheckoutSession({
            amountInUsd,
            platformId,
            customerId,
        })
        return { stripeCheckoutUrl }
    },

    async aiCreditsPaymentSucceeded(platformId: string, amount: number, _paymentType: StripeCheckoutType): Promise<void> {
        const { apiKeyHash } = await this.getOrCreateActivePiecesProviderAuthConfig({ platformId })
        const { data: key } = await openRouterApi.getKey({ hash: apiKeyHash })

        await openRouterApi.updateKey({
            hash: apiKeyHash,
            limit: key.limit! + amount,
        })
    },

    // Tops up the platform's managed AI key by a fixed USD amount (used for the one-time
    // free-chat-credit grant). Resolving the auth config creates the OpenRouter key if needed,
    // so the worker later reuses the same key instead of minting a second one.
    async grantFreeChatCredits({ platformId, amountUsd }: { platformId: string, amountUsd: number }): Promise<void> {
        const { apiKeyHash } = await this.getOrCreateActivePiecesProviderAuthConfig({ platformId })
        const { data: key } = await openRouterApi.getKey({ hash: apiKeyHash })

        await openRouterApi.updateKey({
            hash: apiKeyHash,
            limit: (key.limit ?? 0) + amountUsd,
        })

        // Invalidate the cached usage so the credit check that runs immediately after this grant
        // (in the same request) sees the topped-up balance instead of a stale within-TTL zero.
        await distributedStore.delete(openRouterUsageCacheKey(apiKeyHash))
    },

    // Ensures the platform's managed ACTIVEPIECES provider exists, mints an OpenRouter
    // key when it has none, and schedules the AI credit renewal check. This used to live
    // in the CE ai-provider-service, which dragged ee imports into CE code.
    async getOrCreateActivePiecesProviderAuthConfig({ platformId }: { platformId: string }): Promise<ActivePiecesProviderAuthConfig> {
        const aiProvider = await ensureActivepiecesProvider({ platformId })

        const storedAuth = await encryptUtils.decryptObject<ActivePiecesProviderAuthConfig>(aiProvider.auth)
        const auth = !isNil(storedAuth) && !isNil(storedAuth.apiKey) && storedAuth.apiKey !== ''
            ? storedAuth
            : await provisionActivepiecesKey({ aiProvider, log })

        rejectedPromiseHandler(systemJobsSchedule(log).upsertJob({
            job: {
                name: SystemJobName.AI_CREDIT_UPDATE_CHECK,
                data: { apiKeyHash: auth.apiKeyHash, platformId },
                jobId: `ai-credit-update-check-${platformId}`,
            },
            schedule: {
                type: 'one-time',
                date: dayjs(),
            },
        }), log)
        return auth
    },
})

function openRouterUsageCacheKey(apiKeyHash: string): string {
    return `openrouter_usage_${apiKeyHash}`
}

async function ensureActivepiecesProvider({ platformId }: { platformId: string }): Promise<AIProviderSchema> {
    const existingProvider = await aiProviderRepo().findOneBy({
        platformId,
        provider: AIProviderName.ACTIVEPIECES,
    })
    if (!isNil(existingProvider)) {
        return existingProvider
    }

    const hasChatProvider = await aiProviderRepo().existsBy({ platformId, enabledForChat: true })
    return aiProviderRepo().save({
        id: apId(),
        auth: await encryptUtils.encryptObject({}),
        config: {},
        provider: AIProviderName.ACTIVEPIECES,
        displayName: 'Inboxfm Connect',
        platformId,
        enabledForChat: !hasChatProvider,
    })
}

async function provisionActivepiecesKey({ aiProvider, log }: { aiProvider: AIProviderSchema, log: FastifyBaseLogger }): Promise<ActivePiecesProviderAuthConfig> {
    const platformPlan = await platformPlanService(log).getOrCreateForPlatform(aiProvider.platformId)
    const { key, data } = await openRouterApi.createKey({
        name: `Platform ${aiProvider.platformId}`,
        limit: platformPlan.includedAiCredits / CREDIT_PER_DOLLAR,
    })
    const auth: ActivePiecesProviderAuthConfig = { apiKey: key, apiKeyHash: data.hash }
    await aiProviderRepo().save({
        ...aiProvider,
        auth: await encryptUtils.encryptObject(auth),
    })
    await platformPlanService(log).update({
        platformId: aiProvider.platformId,
        lastFreeAiCreditsRenewalDate: new Date().toISOString(),
    })
    return auth
}

async function getOpenRouterUsageCached(apiKeyHash: string, log: FastifyBaseLogger): Promise<Pick<OpenRouterApikey, 'usage' | 'limit' | 'limit_remaining' | 'usage_monthly'>> {
    const cacheKey = openRouterUsageCacheKey(apiKeyHash)

    const cachedUsage = await distributedStore.get<OpenRouterApikey>(cacheKey)
    if (!isNil(cachedUsage)) {
        return cachedUsage
    }

    const { error, data: usage } = await tryCatch(async () => openRouterApi.getKey({ hash: apiKeyHash }))
    if (!isNil(error) || isNil(usage)) {
        exceptionHandler.handle(error, log)
        return {
            limit: 0,
            limit_remaining: 0,
            usage: 0,
            usage_monthly: 0,
        }
    }
    const value = {
        limit: usage.data.limit ?? 0,
        limit_remaining: usage.data.limit_remaining ?? 0,
        usage: usage.data.usage ?? 0,
        usage_monthly: usage.data.usage_monthly ?? 0,
    }
    await distributedStore.put(cacheKey, value, USAGE_CACHE_TTL_SECONDS)
    return value
}

async function tryResetPlanIncludedCredits(plan: PlatformPlan, apiKeyHash: string, log: FastifyBaseLogger): Promise<void> {
    if (dayjs().diff(plan.lastFreeAiCreditsRenewalDate, 'month') < 1) {
        return
    }

    const { data: key } = await openRouterApi.getKey({ hash: apiKeyHash })

    const amount = plan.includedAiCredits / CREDIT_PER_DOLLAR

    await openRouterApi.updateKey({
        hash: apiKeyHash,
        limit: key.limit! + amount,
    })

    await platformPlanService(log).update({
        platformId: plan.platformId,
        lastFreeAiCreditsRenewalDate: new Date().toISOString(),
    })
}

async function tryAutoTopUpPlan(plan: PlatformPlan, apiKeyHash: string, log: FastifyBaseLogger): Promise<boolean> {
    if (plan.aiCreditsAutoTopUpState !== AiCreditsAutoTopUpState.ENABLED) {
        return false
    }

    assertNotNullOrUndefined(plan.stripeCustomerId, 'Stripe customer id is not set')
    assertNotNullOrUndefined(plan.aiCreditsAutoTopUpCreditsToAdd, 'Auto Topup Credits To add is not set')
    assertNotNullOrUndefined(plan.aiCreditsAutoTopUpThreshold, 'Auto Topup Threashold is not set')

    const { data: key } = await openRouterApi.getKey({ hash: apiKeyHash })

    const creditsRemaining = key.limit_remaining! * CREDIT_PER_DOLLAR
    if (creditsRemaining > plan.aiCreditsAutoTopUpThreshold) {
        return false
    }


    if (!isNil(plan.maxAutoTopUpCreditsMonthly) && plan.maxAutoTopUpCreditsMonthly > 0) {
        const totalAmountThisMonth = await stripeHelper(log).getAutoTopUpInvoicesTotalThisMonth(plan.stripeCustomerId, plan.platformId)
        const totalCreditsThisMonth = totalAmountThisMonth * CREDIT_PER_DOLLAR

        const autoTopUpCreditsThisMonthAfterThisTopUp = totalCreditsThisMonth + plan.aiCreditsAutoTopUpCreditsToAdd

        if (autoTopUpCreditsThisMonthAfterThisTopUp > plan.maxAutoTopUpCreditsMonthly) {
            log.info({
                platform: { id: plan.platformId },
                totalCreditsThisMonth,
                creditsToAdd: plan.aiCreditsAutoTopUpCreditsToAdd,
                maxMonthlyLimit: plan.maxAutoTopUpCreditsMonthly,
            }, '(tryAutoTopUpPlan) AI credit auto top-up limit reached this month')
            return false
        }
    }

    const paymentMethod = await stripeHelper(log).getPaymentMethod(plan.stripeCustomerId)

    assertNotNullOrUndefined(paymentMethod, 'Auto Topup Stripe payment method is not set')

    const amountInUsd = plan.aiCreditsAutoTopUpCreditsToAdd / CREDIT_PER_DOLLAR

    await stripeHelper(log).createNewAICreditAutoTopUpInvoice({
        amountInUsd,
        customerId: plan.stripeCustomerId,
        paymentMethod,
        platformId: plan.platformId,
    })

    return true
}

type APIKeyUsage = {
    limit: number
    usage: number
    usageMonthly: number
    usageRemaining: number
}