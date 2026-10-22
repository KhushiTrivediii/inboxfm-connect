import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectPage from './index'
import { PieceMetadata } from '@/lib/api/types'
import { stubApi, StubRequestRecord } from '@/test/api-stub'
import { mount, waitFor } from '@/test/test-utils'

/**
 * Regression coverage for the public OAuth connect flow dropping `piece.auth.props`.
 * Some OAuth pieces template their provider authUrl with auth props (e.g. a tenant
 * domain). The server builds the authorization URL via resolveValueFromProps, the
 * console flow collects and submits the props, and both connect-session endpoints
 * accept `props` — so the public flow must send them too. Before the fix, the
 * authorization URL was built from the raw `{domain}` template and the stored
 * connection value lost the props entirely.
 */

const SESSION_TOKEN = 'tok_public_connect'
const PIECE_NAME = '@test/tenant-oauth'

function tenantOAuthMetadata(): PieceMetadata {
  return {
    name: PIECE_NAME,
    displayName: 'Tenant OAuth',
    logoUrl: '',
    description: 'OAuth piece with a prop-templated auth URL.',
    version: '0.1.0',
    auth: {
      type: 'OAUTH2',
      description: 'Authorize Tenant OAuth for your workspace.',
      props: {
        domain: {
          displayName: 'Workspace domain',
          type: 'SHORT_TEXT',
          required: true,
        },
      },
      scope: ['read'],
    },
    actions: {},
    triggers: {},
  }
}

function stubRoutes() {
  return stubApi([
    {
      match: (url) => url.pathname === `/api/v1/connect-sessions/${SESSION_TOKEN}`,
      respond: () => ({
        status: 200,
        body: {
          projectId: 'proj_connect',
          externalUserId: 'user_42',
          allowedPieceNames: [PIECE_NAME],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    },
    {
      match: (url) => url.pathname === `/api/v1/integrations/${encodeURIComponent(PIECE_NAME)}`,
      respond: () => ({ status: 200, body: tenantOAuthMetadata() }),
    },
    {
      match: (url, method) =>
        url.pathname === `/api/v1/connect-sessions/${SESSION_TOKEN}/oauth2/authorization-url` &&
        method === 'POST',
      respond: () => ({
        status: 200,
        body: { authorizationUrl: 'https://provider.example/oauth/authorize', codeVerifier: 'verifier_123' },
      }),
    },
  ])
}

function renderConnectPage(): HTMLElement {
  return mount(
    <MemoryRouter initialEntries={[`/connect/${SESSION_TOKEN}`]}>
      <Routes>
        <Route path="/connect/:token" element={<ConnectPage />} />
      </Routes>
    </MemoryRouter>
  )
}

async function setInputValue(container: HTMLElement, selector: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement>(selector)
  expect(element).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(element, value)
    element?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function authorizationUrlRequests(requests: StubRequestRecord[]): StubRequestRecord[] {
  return requests.filter((request) =>
    request.url.endsWith(`/connect-sessions/${SESSION_TOKEN}/oauth2/authorization-url`)
  )
}

const SECRET_SESSION = {
  projectId: 'proj_connect',
  externalUserId: 'user_42',
  allowedPieceNames: ['slack'],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

/**
 * `POST /v1/connect-sessions/:token/connections` validates its body against
 * `UpsertAppConnectionRequestBody`, which requires `projectId` and `externalId`
 * in every union branch even though the server replaces both with the session
 * row's values. These tests pin that the redemption body carries the session's
 * own identity — without those keys every public connect redemption 400s at
 * validation, before the handler ever runs.
 */
function secretRedemptionRoutes() {
  return stubApi([
    {
      match: (url) => url.pathname === `/api/v1/connect-sessions/${SESSION_TOKEN}`,
      respond: () => ({ status: 200, body: SECRET_SESSION }),
    },
    {
      match: (url) => url.pathname === '/api/v1/integrations/slack',
      respond: () => ({
        status: 200,
        body: {
          name: 'slack',
          displayName: 'Slack',
          logoUrl: '',
          description: 'Team communication and messaging.',
          version: '0.2.1',
          auth: { type: 'SECRET_TEXT', description: 'Create a Slack bot user token.' },
          actions: {},
          triggers: {},
        },
      }),
    },
    {
      match: (url, method) =>
        url.pathname === `/api/v1/connect-sessions/${SESSION_TOKEN}/connections` && method === 'POST',
      respond: () => ({
        status: 201,
        body: {
          id: 'conn_1',
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          displayName: 'Slack connection',
          pieceName: 'slack',
          pieceVersion: '0.2.1',
          type: 'SECRET_TEXT',
          status: 'ACTIVE',
          externalId: SECRET_SESSION.externalUserId,
          projectIds: [SECRET_SESSION.projectId],
        },
      }),
    },
  ])
}

function redemptionRequests(requests: StubRequestRecord[]): StubRequestRecord[] {
  return requests.filter(
    (request) =>
      request.url.endsWith(`/connect-sessions/${SESSION_TOKEN}/connections`) && request.method === 'POST',
  )
}

async function submitSecretForm(container: HTMLElement): Promise<void> {
  await waitFor(() => container.querySelector<HTMLInputElement>('#connect-secret-value') !== null)
  await setInputValue(container, '#connect-secret-value', 'xoxb-live-secret')

  const submit = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Connect'),
  )
  expect(submit).toBeTruthy()
  await act(async () => {
    submit?.click()
  })
}

describe('public connect page', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    // jsdom cannot open windows; a null popup makes openAuthorizationWindow settle
    // through onCancelled after the authorization-url request has been sent.
    vi.spyOn(window, 'open').mockReturnValue(null)
  })

  it('collects OAuth auth props and sends them in the authorization-url request', async () => {
    const { requests } = stubRoutes()
    const container = renderConnectPage()

    await waitFor(() => container.querySelector<HTMLInputElement>('#connect-oauth-display-name') !== null)
    await waitFor(() => container.querySelector<HTMLInputElement>('#auth-prop-domain') !== null)

    await setInputValue(container, '#auth-prop-domain', 'https://acme.example')

    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Continue to Tenant OAuth')
    )
    expect(submit).toBeTruthy()
    await act(async () => {
      submit?.click()
    })

    await waitFor(() => authorizationUrlRequests(requests).length === 1)
    expect(authorizationUrlRequests(requests)[0]?.body).toMatchObject({
      pieceName: PIECE_NAME,
      props: { domain: 'https://acme.example' },
    })
  }, 15000)

  it('sends the session projectId and externalUserId in the redemption body', async () => {
    const { requests } = secretRedemptionRoutes()
    const container = renderConnectPage()

    await submitSecretForm(container)
    await waitFor(() => redemptionRequests(requests).length === 1)

    expect(redemptionRequests(requests)[0]?.body).toMatchObject({
      projectId: SECRET_SESSION.projectId,
      externalId: SECRET_SESSION.externalUserId,
      type: 'SECRET_TEXT',
      pieceName: 'slack',
      pieceVersion: '0.2.1',
      value: { type: 'SECRET_TEXT', secret_text: 'xoxb-live-secret' },
    })
  }, 15000)

  it('shows the success screen once the redemption is accepted', async () => {
    const { requests } = secretRedemptionRoutes()
    const container = renderConnectPage()

    await submitSecretForm(container)
    await waitFor(() => redemptionRequests(requests).length === 1)

    await waitFor(() => container.textContent?.includes('Slack connection connected') === true)
    expect(redemptionRequests(requests).length).toBe(1)
  }, 15000)
})
