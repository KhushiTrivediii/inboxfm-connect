import { ApEdition } from '@inboxfm-connect/shared'
import fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeHelper } from '../../../../../src/app/ee/platform/platform-plan/stripe-helper'

const mocks = vi.hoisted(() => ({
    subscriptions: new Array<{ status: string }>(),
    sessions: new Array<{ id: string, mode: string, url: string | null }>(),
    create: vi.fn(async () => ({ url: 'https://checkout.stripe.com/new' })),
    expire: vi.fn(async () => ({})),
    items: vi.fn(async () => ({ data: [{ price: { id: 'price-flow' }, quantity: 25 }] })),
}))

vi.mock('stripe', () => ({
    default: class {
        subscriptions = { list: async function* () { yield* mocks.subscriptions } }
        checkout = { sessions: {
            list: async function* () { yield* mocks.sessions },
            create: mocks.create, expire: mocks.expire, listLineItems: mocks.items,
        } }
    },
}))
vi.mock('../../../../../src/app/helper/system/system', () => ({
    system: { getEdition: () => ApEdition.CLOUD, get: () => 'test-secret', getOrThrow: () => 'https://example.test' },
}))
vi.mock('../../../../../src/app/ee/platform/platform-plan/platform-plan.service', () => ({ ACTIVE_FLOW_PRICE_ID: 'price-flow' }))

describe('Subscription checkout uses live Stripe state', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.subscriptions = []
        mocks.sessions = []
    })

    it('creates checkout when the customer has no subscription or open session', async () => {
        const url = await stripeHelper(fastify({ logger: false }).log).createNewSubscriptionCheckoutSession({ platformId: 'platform-a', customerId: 'customer-a', extraActiveFlows: 25 })
        expect(url).toBe('https://checkout.stripe.com/new')
        expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'customer-a', mode: 'subscription' }))
    })

    it('rejects an active subscription before the webhook updates the local plan', async () => {
        mocks.subscriptions = [{ status: 'active' }]
        await expect(stripeHelper(fastify({ logger: false }).log).createNewSubscriptionCheckoutSession({ platformId: 'platform-a', customerId: 'customer-a', extraActiveFlows: 25 })).rejects.toThrow()
        expect(mocks.create).not.toHaveBeenCalled()
    })

    it('reuses an open checkout for the same quantity', async () => {
        mocks.sessions = [{ id: 'session-a', mode: 'subscription', url: 'https://checkout.stripe.com/existing' }]
        const url = await stripeHelper(fastify({ logger: false }).log).createNewSubscriptionCheckoutSession({ platformId: 'platform-a', customerId: 'customer-a', extraActiveFlows: 25 })
        expect(url).toBe('https://checkout.stripe.com/existing')
        expect(mocks.create).not.toHaveBeenCalled()
        expect(mocks.expire).not.toHaveBeenCalled()
    })

    it('expires an open checkout before changing its quantity', async () => {
        mocks.sessions = [{ id: 'session-a', mode: 'subscription', url: 'https://checkout.stripe.com/existing' }]
        await stripeHelper(fastify({ logger: false }).log).createNewSubscriptionCheckoutSession({ platformId: 'platform-a', customerId: 'customer-a', extraActiveFlows: 30 })
        expect(mocks.expire).toHaveBeenCalledWith('session-a')
        expect(mocks.create).toHaveBeenCalledTimes(1)
        expect(mocks.expire.mock.invocationCallOrder[0]).toBeLessThan(mocks.create.mock.invocationCallOrder[0] ?? 0)
    })
})
