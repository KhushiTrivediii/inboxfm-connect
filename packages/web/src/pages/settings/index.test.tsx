import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from './index'
import { apiClient } from '@/lib/api/client'
import { User } from '@/lib/api/types'
import { AuthProvider } from '@/lib/auth/auth-context'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { stubApi } from '@/test/api-stub'
import { testProject, testUser } from '@/test/fixtures/api-keys'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

const PROJECT = testProject()

function signIn({ user = testUser() }: { user?: User } = {}): void {
  apiClient.setToken('test-token')
  apiClient.setProjectId(PROJECT.id)
  sessionStorage.setItem('ap-user', JSON.stringify(user))
}

function renderSettingsPage(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

const PROJECTS_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/projects' && method === 'GET'
const BILLING_INFO_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/platform-billing/info' && method === 'GET'
const BILLING_PORTAL_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/platform-billing/portal' && method === 'POST'
const BILLING_CHECKOUT_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/platform-billing/create-checkout-session' && method === 'POST'

describe('Settings page', () => {
  let assignSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    signIn()
    vi.restoreAllMocks()
    assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        assign: assignSpy,
      },
      writable: true,
      configurable: true,
    })
  })

  it('does not offer checkout when billing state fails to load', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ status: 500, body: { message: 'Unavailable' } }) },
    ])
    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Billing status could not be loaded') === true)
    expect(container.textContent).not.toContain('Upgrade to Paid Tier')
    expect(container.textContent).not.toContain('Community Plan')
  })

  it.each(['ce', 'ee'])('does not offer Stripe checkout on %s', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: { stripeBillingEnabled: false, plan: { plan: 'self-hosted' }, usage: {} } }) },
    ])
    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Stripe billing is unavailable') === true)
    expect(container.textContent).not.toContain('Upgrade to Paid Tier')
    expect(container.textContent).not.toContain('Manage in Stripe')
  })

  it('does not offer a self-service upgrade for Cloud Enterprise', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: { stripeBillingEnabled: true, plan: { plan: 'enterprise' }, usage: {} } }) },
    ])
    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Enterprise billing is managed') === true)
    expect(container.textContent).not.toContain('Upgrade to Paid Tier')
  })

  it('renders settings page with project information, appearance, and community billing details', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      {
        match: BILLING_INFO_MATCH,
        respond: () => ({
          body: {
            stripeBillingEnabled: true,
            plan: {
              plan: 'community',
              activeFlowsLimit: null,
              includedAiCredits: 0,
            },
            usage: {
              activeFlows: 2,
            },
          },
        }),
      },
    ])

    const container = renderSettingsPage()

    await waitFor(() => container.textContent?.includes('Settings') === true)
    await waitFor(() => container.textContent?.includes('Subscription & Billing') === true)
    await waitFor(() => container.textContent?.includes('Community Plan') === true)
    await waitFor(() => container.textContent?.includes('Upgrade to Paid Tier') === true)
    await waitFor(() => container.textContent?.includes('Project Information') === true)
    await waitFor(() => container.textContent?.includes('Developer Identity') === true)
  })

  it('renders active subscription badge and manage in stripe button for paid plans', async () => {
    let portalCalled = false
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      {
        match: BILLING_INFO_MATCH,
        respond: () => ({
          body: {
            stripeBillingEnabled: true,
            plan: {
              plan: 'standard',
              stripeSubscriptionId: 'sub_12345',
              stripeSubscriptionStatus: 'active',
              activeFlowsLimit: 25,
              includedAiCredits: 500,
            },
            usage: {
              activeFlows: 5,
            },
          },
        }),
      },
      {
        match: BILLING_PORTAL_MATCH,
        respond: () => {
          portalCalled = true
          return { body: { url: 'https://billing.stripe.com/session/test_session' } }
        },
      },
    ])

    const container = renderSettingsPage()

    await waitFor(() => container.textContent?.includes('Active Subscription') === true)
    await waitFor(() => container.textContent?.includes('Manage in Stripe') === true)
    await waitFor(() => container.textContent?.includes('25') === true)

    const manageBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Manage in Stripe')
    )
    expect(manageBtn).toBeDefined()

    await act(async () => {
      manageBtn?.click()
    })

    await waitFor(() => portalCalled === true)
    expect(assignSpy).toHaveBeenCalledWith('https://billing.stripe.com/session/test_session')
  })

  it('renders past due warning banner when payment has failed', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      {
        match: BILLING_INFO_MATCH,
        respond: () => ({
          body: {
            stripeBillingEnabled: true,
            plan: {
              plan: 'standard',
              stripeSubscriptionId: 'sub_failed',
              stripeSubscriptionStatus: 'past_due',
              activeFlowsLimit: 10,
              includedAiCredits: 200,
            },
            usage: {},
          },
        }),
      },
    ])

    const container = renderSettingsPage()

    await waitFor(() => container.textContent?.includes('Payment Past Due') === true)
    await waitFor(() => container.textContent?.includes('Your recent subscription payment failed') === true)
    await waitFor(() => container.textContent?.includes('Please update your payment method in Stripe') === true)
  })

  it('initiates Stripe checkout when upgrading to paid tier', async () => {
    let checkoutCalled = false
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      {
        match: BILLING_INFO_MATCH,
        respond: () => ({
          body: {
            stripeBillingEnabled: true,
            plan: {
              plan: 'community',
            },
            usage: {},
          },
        }),
      },
      {
        match: BILLING_CHECKOUT_MATCH,
        respond: () => {
          checkoutCalled = true
          return {
            body: {
              stripeCheckoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
              url: 'https://checkout.stripe.com/c/pay/cs_test_123',
            },
          }
        },
      },
    ])

    const container = renderSettingsPage()

    await waitFor(() => container.textContent?.includes('Upgrade to Paid Tier') === true)

    const upgradeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Upgrade to Paid Tier')
    )
    expect(upgradeBtn).toBeDefined()

    await act(async () => {
      upgradeBtn?.click()
    })

    await waitFor(() => checkoutCalled === true)
    expect(assignSpy).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_123')
  })

  it('renders trialing and unpaid badges appropriately', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      {
        match: BILLING_INFO_MATCH,
        respond: () => ({
          body: {
            stripeBillingEnabled: true,
            plan: {
              plan: 'standard',
              stripeSubscriptionId: 'sub_trial',
              stripeSubscriptionStatus: 'trialing',
            },
            usage: {},
          },
        }),
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Trialing') === true)
  })

  it('renders incomplete badge for incomplete status', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      {
        match: BILLING_INFO_MATCH,
        respond: () => ({
          body: {
            stripeBillingEnabled: true,
            plan: {
              plan: 'standard',
              stripeSubscriptionId: 'sub_inc',
              stripeSubscriptionStatus: 'incomplete',
            },
            usage: {},
          },
        }),
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Incomplete') === true)
  })

  it('does not expose upgrade or manage buttons while billing state is loading', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      {
        match: BILLING_INFO_MATCH,
        respond: () => ({
          stream: new ReadableStream<Uint8Array>({ start() {} }),
        }),
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Loading billing status...') === true)
    expect(container.textContent?.includes('Upgrade to Paid Tier')).toBe(false)
    expect(container.textContent?.includes('Manage in Stripe')).toBe(false)
  })

  it('renders neutral placeholders and dash fallbacks when project and user role are missing (#174)', async () => {
    localStorage.clear()
    sessionStorage.clear()
    apiClient.setToken('test-token')
    apiClient.setProjectId('')
    sessionStorage.setItem('ap-user', JSON.stringify({ id: 'u_1', firstName: 'Dev' }))

    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: { stripeBillingEnabled: false } }) },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Developer Identity') === true)

    // Should never fabricate 'InboxFM Main Project', 'proj_default', 'developer@inboxfm.local', or 'ADMIN'
    expect(container.textContent).not.toContain('InboxFM Main Project')
    expect(container.textContent).not.toContain('proj_default')
    expect(container.textContent).not.toContain('developer@inboxfm.local')
    expect(container.textContent).not.toContain('ADMIN')

    const inputs = Array.from(container.querySelectorAll('input'))
    const values = inputs.map((i) => i.value)
    expect(values).not.toContain('InboxFM Main Project')
    expect(values).not.toContain('proj_default')
    expect(values).not.toContain('developer@inboxfm.local')
    expect(values).not.toContain('ADMIN')
    expect(values).toContain('—') // Role and project ID fallback

    // Validate honest placeholders when fields are empty
    expect(container.querySelector('input[placeholder="No project selected"]')).not.toBeNull()
    expect(container.querySelector('input[placeholder="Not signed in"]')).not.toBeNull()
  })

  it('displays concrete tenant isolation policies without placebo action button (#174)', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: { stripeBillingEnabled: false } }) },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Security & Isolation') === true)

    expect(container.textContent).toContain('isolated-vm sandbox')
    expect(container.textContent).toContain('SafeHttp allowlist')
    expect(container.textContent).not.toContain('Inspect Security Policies')
  })
})
