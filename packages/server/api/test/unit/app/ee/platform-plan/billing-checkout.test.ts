import { beforeEach, describe, expect, it, vi } from 'vitest'
import fastify from 'fastify'
import { billingCheckoutService } from '../../../../../src/app/ee/platform/platform-plan/billing-checkout.service'

const logger = fastify({ logger: false }).log

const mocks = vi.hoisted(() => {
    const plan: { plan: string, platformId: string, stripeCustomerId: string | undefined, stripeSubscriptionId: string | undefined } = {
        plan: 'standard', platformId: 'platform-a', stripeCustomerId: undefined, stripeSubscriptionId: undefined,
    }
    let pending = Promise.resolve()
    return {
        plan,
        getStripe: vi.fn(() => ({})),
        createCustomer: vi.fn(async () => 'customer-a'),
        createSession: vi.fn(async () => 'https://checkout.stripe.com/test'),
        lock: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => {
            const result = pending.then(fn)
            pending = result.then(() => undefined, () => undefined)
            return result
        }),
        update: vi.fn(async ({ stripeCustomerId }: { stripeCustomerId: string }) => {
            plan.stripeCustomerId = stripeCustomerId
        }),
    }
})

vi.mock('../../../../../src/app/database/redis-connections', () => ({ distributedLock: () => ({ runExclusive: mocks.lock }) }))
vi.mock('../../../../../src/app/ee/platform/platform-plan/platform-plan.service', () => ({
    platformPlanService: () => ({ getOrCreateForPlatform: async () => mocks.plan, update: mocks.update }),
}))
vi.mock('../../../../../src/app/ee/platform/platform-plan/stripe-helper', () => ({
    stripeHelper: () => ({ getStripe: mocks.getStripe, createCustomer: mocks.createCustomer, createNewSubscriptionCheckoutSession: mocks.createSession }),
}))
vi.mock('../../../../../src/app/platform/platform.service', () => ({ platformService: () => ({ getOneOrThrow: async () => ({ ownerId: 'owner-a' }) }) }))
vi.mock('../../../../../src/app/user/user-service', () => ({ userService: () => ({ getMetaInformation: async () => ({ id: 'owner-a' }) }) }))

describe('Billing checkout orchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.plan.stripeCustomerId = undefined
        mocks.plan.stripeSubscriptionId = undefined
        mocks.plan.plan = 'standard'
    })

    it('serializes same-platform requests and creates only one customer', async () => {
        const requests = await Promise.all([
            billingCheckoutService.create({ platformId: 'platform-a', newActiveFlowsLimit: 25, log: logger }),
            billingCheckoutService.create({ platformId: 'platform-a', newActiveFlowsLimit: 25, log: logger }),
        ])
        expect(mocks.createCustomer).toHaveBeenCalledTimes(1)
        expect(mocks.update).toHaveBeenCalledWith({ platformId: 'platform-a', stripeCustomerId: 'customer-a' })
        expect(mocks.lock).toHaveBeenCalledWith(expect.objectContaining({ key: 'platform-billing-checkout:platform-a' }))
        expect(requests[0]).toEqual(requests[1])
    })

    it('rejects an existing subscription before creating a customer or checkout', async () => {
        mocks.plan.stripeSubscriptionId = 'subscription-a'
        await expect(billingCheckoutService.create({ platformId: 'platform-a', newActiveFlowsLimit: 25, log: logger })).rejects.toThrow()
        expect(mocks.createCustomer).not.toHaveBeenCalled()
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it('rejects a free-plan quantity before any remote side effects', async () => {
        await expect(billingCheckoutService.create({ platformId: 'platform-a', newActiveFlowsLimit: 0, log: logger })).rejects.toThrow()
        expect(mocks.createCustomer).not.toHaveBeenCalled()
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it('does not replace a managed enterprise plan with a self-service subscription', async () => {
        mocks.plan.plan = 'enterprise'
        await expect(billingCheckoutService.create({ platformId: 'platform-a', newActiveFlowsLimit: 25, log: logger })).rejects.toThrow()
        expect(mocks.createCustomer).not.toHaveBeenCalled()
        expect(mocks.createSession).not.toHaveBeenCalled()
    })
})
