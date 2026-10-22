import { apiClient } from './client'
import { PlatformBillingInformation } from './types'

async function getInfo(): Promise<PlatformBillingInformation> {
  return apiClient.get<PlatformBillingInformation>('/platform-billing/info')
}

async function createPortalSession(): Promise<{ url: string }> {
  return apiClient.post<{ url: string }>('/platform-billing/portal', {})
}

async function createCheckoutSession({ newActiveFlowsLimit }: { newActiveFlowsLimit: number }): Promise<{ stripeCheckoutUrl: string, url: string }> {
  return apiClient.post<{ stripeCheckoutUrl: string, url: string }>('/platform-billing/create-checkout-session', { newActiveFlowsLimit })
}

const billingApi = {
  getInfo,
  createPortalSession,
  createCheckoutSession,
}

export { billingApi }
