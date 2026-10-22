import { ApEdition, ApSubscriptionStatus, PlanName, STANDARD_CLOUD_PLAN } from '@inboxfm-connect/shared'
import fastify, { FastifyInstance } from 'fastify'
import { fastifyRawBody } from 'fastify-raw-body'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeBillingController } from '../../../../../src/app/ee/platform/platform-plan/stripe-billing.controller'

const {
    mockDistributedStore,
    mockPlatformPlanUpdate,
    mockAiCreditsPaymentSucceeded,
    mockHandleAutoTopUpCheckoutSessionCompleted,
    mockRetrieveSubscription,
    mockRetrievePaymentIntent,
    mockRetrieveSetupIntent,
    mockConstructEvent,
    mockStripe,
} = vi.hoisted(() => {
    const mockDistributedStore = {
        store: new Map<string, unknown>(),
        async putIfAbsent(key: string, value: unknown): Promise<boolean> {
            if (this.store.has(key)) {
                return false
            }
            this.store.set(key, value)
            return true
        },
        async delete(keys: string | string[]): Promise<void> {
            const keysArr = Array.isArray(keys) ? keys : [keys]
            for (const k of keysArr) {
                this.store.delete(k)
            }
        },
        clear() {
            this.store.clear()
        },
    }

    const mockPlatformPlanUpdate = vi.fn().mockResolvedValue({})
    const mockAiCreditsPaymentSucceeded = vi.fn().mockResolvedValue({})
    const mockHandleAutoTopUpCheckoutSessionCompleted = vi.fn().mockResolvedValue({})

    const mockRetrieveSubscription = vi.fn()
    const mockRetrievePaymentIntent = vi.fn()
    const mockRetrieveSetupIntent = vi.fn()
    const mockConstructEvent = vi.fn()

    const mockStripe = {
        subscriptions: {
            retrieve: mockRetrieveSubscription,
        },
        paymentIntents: {
            retrieve: mockRetrievePaymentIntent,
        },
        setupIntents: {
            retrieve: mockRetrieveSetupIntent,
        },
        webhooks: {
            constructEvent: mockConstructEvent,
        },
    }

    return {
        mockDistributedStore,
        mockPlatformPlanUpdate,
        mockAiCreditsPaymentSucceeded,
        mockHandleAutoTopUpCheckoutSessionCompleted,
        mockRetrieveSubscription,
        mockRetrievePaymentIntent,
        mockRetrieveSetupIntent,
        mockConstructEvent,
        mockStripe,
    }
})

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedStore: mockDistributedStore,
}))

vi.mock('../../../../../src/app/ee/platform/platform-plan/platform-plan.service', () => ({
    ACTIVE_FLOW_PRICE_ID: 'price_active_flows_test',
    platformPlanService: () => ({
        update: mockPlatformPlanUpdate,
        getOrCreateForPlatform: vi.fn().mockResolvedValue({
            platformId: 'plat_123',
            stripeCustomerId: 'cus_123',
        }),
    }),
}))

vi.mock('../../../../../src/app/ee/platform/platform-plan/platform-ai-credits.service', () => ({
    platformAiCreditsService: () => ({
        aiCreditsPaymentSucceeded: mockAiCreditsPaymentSucceeded,
        handleAutoTopUpCheckoutSessionCompleted: mockHandleAutoTopUpCheckoutSessionCompleted,
    }),
}))

vi.mock('../../../../../src/app/ee/platform/platform-plan/stripe-helper', () => ({
    StripeCheckoutType: {
        AI_CREDIT_PAYMENT: 'AI_CREDIT_PAYMENT',
        AI_CREDIT_AUTO_TOP_UP: 'AI_CREDIT_AUTO_TOP_UP',
    },
    stripeHelper: () => ({
        getStripe: () => mockStripe,
        getSubscriptionCycleDates: vi.fn().mockResolvedValue({
            startDate: 1000,
            endDate: 2000,
            cancelDate: undefined,
        }),
    }),
    stripeWebhookSecret: 'whsec_test',
}))

describe('Stripe Billing Webhook Controller & Resilience', () => {
    let app: FastifyInstance

    beforeAll(async () => {
        process.env.AP_STRIPE_WEBHOOK_SECRET = 'whsec_test'
        process.env.AP_FRONTEND_URL = 'https://app.inboxfm.com'

        app = fastify({ logger: false })
        await app.register(fastifyRawBody, {
            field: 'rawBody',
            global: false,
            encoding: 'utf8',
            runFirst: true,
        })
        await app.register(stripeBillingController)
        await app.ready()
    })

    afterAll(async () => {
        await app.close()
    })

    beforeEach(() => {
        vi.clearAllMocks()
        mockDistributedStore.clear()
    })

    describe('Webhook Signature Verification (Route Level)', () => {
        it('returns 400 Bad Request when stripe-signature header is missing or verification fails', async () => {
            mockConstructEvent.mockImplementationOnce(() => {
                throw new Error('No signatures found matching the expected signature for payload')
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({ id: 'evt_test' }),
            })

            expect(response.statusCode).toBe(400)
            expect(response.payload).toBe('Invalid webhook signature')
        })

        it('returns 400 Bad Request when signature is tampered or invalid', async () => {
            mockConstructEvent.mockImplementationOnce(() => {
                throw new Error('Signature verification failed')
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 't=123,v1=tampered_signature',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({ id: 'evt_test' }),
            })

            expect(response.statusCode).toBe(400)
            expect(response.payload).toBe('Invalid webhook signature')
        })

        it('returns 200 OK when signature verification passes', async () => {
            mockConstructEvent.mockReturnValueOnce({
                type: 'unknown.event',
                data: { object: {} },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 't=123,v1=valid_signature',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({ id: 'evt_test' }),
            })

            expect(response.statusCode).toBe(200)
            expect(JSON.parse(response.payload)).toEqual({ received: true })
        })
    })

    describe('Credit grant idempotency and failure rollback', () => {
        it('grants credits on initial checkout.session.completed and skips duplicate deliveries', async () => {
            mockRetrievePaymentIntent.mockResolvedValueOnce({ amount: 5000 })
            mockConstructEvent.mockReturnValue({
                type: 'checkout.session.completed',
                data: {
                    object: {
                        id: 'cs_test_dedup_1',
                        payment_intent: 'pi_123',
                        metadata: {
                            type: 'AI_CREDIT_PAYMENT',
                            platformId: 'plat_123',
                        },
                    },
                },
            })

            // First delivery
            const res1 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })
            expect(res1.statusCode).toBe(200)
            expect(mockAiCreditsPaymentSucceeded).toHaveBeenCalledTimes(1)
            expect(mockAiCreditsPaymentSucceeded).toHaveBeenCalledWith('plat_123', 50, 'AI_CREDIT_PAYMENT')

            // Second delivery (duplicate retry)
            const res2 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })
            expect(res2.statusCode).toBe(200)
            expect(mockAiCreditsPaymentSucceeded).toHaveBeenCalledTimes(1)
        })

        it('deletes idempotency key when checkout.session.completed credit grant fails, allowing retry', async () => {
            mockRetrievePaymentIntent.mockResolvedValue({ amount: 2000 })
            mockConstructEvent.mockReturnValue({
                type: 'checkout.session.completed',
                data: {
                    object: {
                        id: 'cs_test_retry_fail',
                        payment_intent: 'pi_retry',
                        metadata: {
                            type: 'AI_CREDIT_PAYMENT',
                            platformId: 'plat_123',
                        },
                    },
                },
            })

            // First attempt fails during credit grant
            mockAiCreditsPaymentSucceeded.mockRejectedValueOnce(new Error('Database lock timeout'))

            const res1 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })
            expect(res1.statusCode).toBe(400)
            expect(mockDistributedStore.store.has('stripe_credit_processed_cs_test_retry_fail')).toBe(false)

            // Webhook retry arrives after transient issue resolves
            mockAiCreditsPaymentSucceeded.mockResolvedValueOnce({})

            const res2 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })
            expect(res2.statusCode).toBe(200)
            expect(mockAiCreditsPaymentSucceeded).toHaveBeenCalledTimes(2)
            expect(mockDistributedStore.store.has('stripe_credit_processed_cs_test_retry_fail')).toBe(true)
        })

        it('grants credits on initial invoice.paid auto top-up and ignores duplicate retries', async () => {
            mockConstructEvent.mockReturnValue({
                type: 'invoice.paid',
                data: {
                    object: {
                        id: 'in_auto_123',
                        amount_paid: 10000,
                        metadata: {
                            type: 'AI_CREDIT_AUTO_TOP_UP',
                            platformId: 'plat_123',
                        },
                    },
                },
            })

            const res1 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })
            expect(res1.statusCode).toBe(200)
            expect(mockAiCreditsPaymentSucceeded).toHaveBeenCalledWith('plat_123', 100, 'AI_CREDIT_AUTO_TOP_UP')

            const res2 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })
            expect(res2.statusCode).toBe(200)
            expect(mockAiCreditsPaymentSucceeded).toHaveBeenCalledTimes(1)
        })

        it('deletes idempotency key when invoice.paid auto top-up credit grant fails', async () => {
            mockConstructEvent.mockReturnValue({
                type: 'invoice.paid',
                data: {
                    object: {
                        id: 'in_auto_fail_1',
                        amount_paid: 5000,
                        metadata: {
                            type: 'AI_CREDIT_AUTO_TOP_UP',
                            platformId: 'plat_123',
                        },
                    },
                },
            })

            mockAiCreditsPaymentSucceeded.mockRejectedValueOnce(new Error('Connection failure'))

            const res1 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })
            expect(res1.statusCode).toBe(400)
            expect(mockDistributedStore.store.has('stripe_credit_processed_in_auto_fail_1')).toBe(false)
        })
    })

    describe('Out-of-order invoice.payment_failed resilience', () => {
        it('updates status to PAST_DUE when live subscription from Stripe is past_due', async () => {
            mockRetrieveSubscription.mockResolvedValueOnce({
                id: 'sub_123',
                status: 'past_due',
                metadata: { platformId: 'plat_123' },
            })
            mockConstructEvent.mockReturnValueOnce({
                type: 'invoice.payment_failed',
                data: {
                    object: {
                        id: 'in_fail_1',
                        parent: {
                            subscription_details: {
                                subscription: 'sub_123',
                            },
                        },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith({
                platformId: 'plat_123',
                stripeSubscriptionStatus: ApSubscriptionStatus.PAST_DUE,
            })
        })

        it('updates status to UNPAID when live subscription from Stripe is unpaid', async () => {
            mockRetrieveSubscription.mockResolvedValueOnce({
                id: 'sub_123',
                status: 'unpaid',
                metadata: { platformId: 'plat_123' },
            })
            mockConstructEvent.mockReturnValueOnce({
                type: 'invoice.payment_failed',
                data: {
                    object: {
                        id: 'in_fail_2',
                        parent: {
                            subscription_details: {
                                subscription: 'sub_123',
                            },
                        },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith({
                platformId: 'plat_123',
                stripeSubscriptionStatus: ApSubscriptionStatus.UNPAID,
            })
        })

        it('ignores stale invoice.payment_failed when live subscription from Stripe is active', async () => {
            mockRetrieveSubscription.mockResolvedValueOnce({
                id: 'sub_123',
                status: 'active',
                metadata: { platformId: 'plat_123' },
            })
            mockConstructEvent.mockReturnValueOnce({
                type: 'invoice.payment_failed',
                data: {
                    object: {
                        id: 'in_stale',
                        parent: {
                            subscription_details: {
                                subscription: 'sub_123',
                            },
                        },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).not.toHaveBeenCalled()
        })
    })

    describe('Subscription Lifecycle & Status Mapping', () => {
        it('handles paused status in customer.subscription.updated without falling back to CANCELED', async () => {
            mockConstructEvent.mockReturnValueOnce({
                type: 'customer.subscription.updated',
                data: {
                    object: {
                        id: 'sub_paused_1',
                        status: 'paused',
                        items: { data: [] },
                        metadata: { platformId: 'plat_paused_1' },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    platformId: 'plat_paused_1',
                    stripeSubscriptionStatus: ApSubscriptionStatus.PAUSED,
                }),
            )
        })

        it('handles customer.subscription.deleted by clearing subscription details and setting CANCELED', async () => {
            mockConstructEvent.mockReturnValueOnce({
                type: 'customer.subscription.deleted',
                data: {
                    object: {
                        id: 'sub_del_1',
                        status: 'canceled',
                        items: { data: [] },
                        metadata: { platformId: 'plat_123' },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith({
                ...STANDARD_CLOUD_PLAN,
                platformId: 'plat_123',
                plan: PlanName.STANDARD,
                stripeSubscriptionStatus: ApSubscriptionStatus.CANCELED,
                stripeSubscriptionId: undefined,
                stripeSubscriptionStartDate: undefined,
                stripeSubscriptionEndDate: undefined,
                stripeSubscriptionCancelDate: undefined,
            })
        })

        it('gracefully skips subscription event when platformId metadata is missing', async () => {
            mockConstructEvent.mockReturnValueOnce({
                type: 'customer.subscription.updated',
                data: {
                    object: {
                        id: 'sub_no_meta',
                        status: 'active',
                        items: { data: [] },
                        metadata: null,
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).not.toHaveBeenCalled()
        })
    })

    describe('Invoice subscription ID extraction across Stripe models', () => {
        it('extracts subscription ID from later line item in invoice.lines.data', async () => {
            mockRetrieveSubscription.mockResolvedValueOnce({
                id: 'sub_from_line_2',
                status: 'past_due',
                metadata: { platformId: 'plat_multi_line' },
            })
            mockConstructEvent.mockReturnValueOnce({
                type: 'invoice.payment_failed',
                data: {
                    object: {
                        id: 'in_multi_line',
                        lines: {
                            data: [
                                { subscription: null },
                                { subscription: 'sub_from_line_2' },
                            ],
                        },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: {
                    'stripe-signature': 'valid_sig',
                    'content-type': 'application/json',
                },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_from_line_2')
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith({
                platformId: 'plat_multi_line',
                stripeSubscriptionStatus: ApSubscriptionStatus.PAST_DUE,
            })
        })
    })

    describe('Subscription status enum coverage', () => {
        it('covers all valid Stripe subscription statuses in ApSubscriptionStatus', () => {
            const validStripeStatuses = [
                'active',
                'canceled',
                'past_due',
                'unpaid',
                'incomplete',
                'incomplete_expired',
                'trialing',
                'paused',
            ]

            const enumValues = Object.values(ApSubscriptionStatus)
            for (const status of validStripeStatuses) {
                expect(enumValues).toContain(status)
            }
        })
    })

    describe('Dunning Retry Ladder & Recovery Simulation (Issue #131)', () => {
        it('simulates full dunning ladder: active -> invoice.payment_failed (past_due) -> retry payment_failed (unpaid) -> invoice.paid (active)', async () => {
            // Step 1: First failed charge enters past_due
            mockRetrieveSubscription.mockResolvedValueOnce({
                id: 'sub_ladder_1',
                status: 'past_due',
                metadata: { platformId: 'plat_ladder_1' },
            })
            mockConstructEvent.mockReturnValueOnce({
                type: 'invoice.payment_failed',
                data: {
                    object: {
                        id: 'in_ladder_attempt_1',
                        parent: {
                            subscription_details: {
                                subscription: 'sub_ladder_1',
                            },
                        },
                    },
                },
            })

            const res1 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
                payload: JSON.stringify({}),
            })
            expect(res1.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenLastCalledWith({
                platformId: 'plat_ladder_1',
                stripeSubscriptionStatus: ApSubscriptionStatus.PAST_DUE,
            })

            // Step 2: Next retry in dunning ladder fails; Stripe marks subscription unpaid
            mockRetrieveSubscription.mockResolvedValueOnce({
                id: 'sub_ladder_1',
                status: 'unpaid',
                metadata: { platformId: 'plat_ladder_1' },
            })
            mockConstructEvent.mockReturnValueOnce({
                type: 'invoice.payment_failed',
                data: {
                    object: {
                        id: 'in_ladder_attempt_2',
                        parent: {
                            subscription_details: {
                                subscription: 'sub_ladder_1',
                            },
                        },
                    },
                },
            })

            const res2 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
                payload: JSON.stringify({}),
            })
            expect(res2.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenLastCalledWith({
                platformId: 'plat_ladder_1',
                stripeSubscriptionStatus: ApSubscriptionStatus.UNPAID,
            })

            // Step 3: Customer updates payment method; invoice.paid event restores ACTIVE status
            mockRetrieveSubscription.mockResolvedValueOnce({
                id: 'sub_ladder_1',
                status: 'active',
                metadata: { platformId: 'plat_ladder_1' },
            })
            mockConstructEvent.mockReturnValueOnce({
                type: 'invoice.paid',
                data: {
                    object: {
                        id: 'in_ladder_success',
                        parent: {
                            subscription_details: {
                                subscription: 'sub_ladder_1',
                            },
                        },
                    },
                },
            })

            const res3 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
                payload: JSON.stringify({}),
            })
            expect(res3.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenLastCalledWith({
                platformId: 'plat_ladder_1',
                stripeSubscriptionStatus: ApSubscriptionStatus.ACTIVE,
            })
        })
    })

    describe('Clock fixtures for trial and period boundaries (Issue #131)', () => {
        it('correctly maps trialing subscription with trial period boundaries', async () => {
            const trialStart = 1710000000
            const trialEnd = 1711209600

            mockConstructEvent.mockReturnValueOnce({
                type: 'customer.subscription.created',
                data: {
                    object: {
                        id: 'sub_trial_1',
                        status: 'trialing',
                        items: { data: [] },
                        metadata: { platformId: 'plat_trial_1' },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    platformId: 'plat_trial_1',
                    stripeSubscriptionStatus: ApSubscriptionStatus.TRIALING,
                    plan: PlanName.STANDARD,
                }),
            )
        })

        it('maps incomplete and incomplete_expired subscription states correctly', async () => {
            mockConstructEvent.mockReturnValueOnce({
                type: 'customer.subscription.updated',
                data: {
                    object: {
                        id: 'sub_inc_1',
                        status: 'incomplete',
                        items: { data: [] },
                        metadata: { platformId: 'plat_inc_1' },
                    },
                },
            })

            const res1 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
                payload: JSON.stringify({}),
            })
            expect(res1.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    platformId: 'plat_inc_1',
                    stripeSubscriptionStatus: ApSubscriptionStatus.INCOMPLETE,
                }),
            )

            mockConstructEvent.mockReturnValueOnce({
                type: 'customer.subscription.updated',
                data: {
                    object: {
                        id: 'sub_inc_exp',
                        status: 'incomplete_expired',
                        items: { data: [] },
                        metadata: { platformId: 'plat_inc_1' },
                    },
                },
            })

            const res2 = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
                payload: JSON.stringify({}),
            })
            expect(res2.statusCode).toBe(200)
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    platformId: 'plat_inc_1',
                    stripeSubscriptionStatus: ApSubscriptionStatus.INCOMPLETE_EXPIRED,
                }),
            )
        })
    })

    describe('Plan limits gating and active flows calculation (Issue #131)', () => {
        it('calculates active flows add-on limit correctly based on price item quantity', async () => {
            mockConstructEvent.mockReturnValueOnce({
                type: 'customer.subscription.updated',
                data: {
                    object: {
                        id: 'sub_addon_1',
                        status: 'active',
                        items: {
                            data: [
                                {
                                    price: { id: 'price_active_flows_test' },
                                    quantity: 15,
                                },
                            ],
                        },
                        metadata: { platformId: 'plat_addon_1' },
                    },
                },
            })

            const response = await app.inject({
                method: 'POST',
                url: '/stripe/webhook',
                headers: { 'stripe-signature': 'valid_sig', 'content-type': 'application/json' },
                payload: JSON.stringify({}),
            })

            expect(response.statusCode).toBe(200)
            const expectedActiveFlows = (STANDARD_CLOUD_PLAN.activeFlowsLimit ?? 0) + 15
            expect(mockPlatformPlanUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    platformId: 'plat_addon_1',
                    activeFlowsLimit: expectedActiveFlows,
                    stripeSubscriptionStatus: ApSubscriptionStatus.ACTIVE,
                }),
            )
        })
    })
})
