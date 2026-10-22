import { act } from 'react'
import { Location as RouterLocation, MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NewConnectionPage from './new'
import { StubRoute } from '@/test/api-stub'
import {
  basicAuthMetadata,
  customAuthMetadata,
  githubConnection,
  githubMetadata,
  secretAuthMetadata,
} from '@/test/fixtures/integrations'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

let lastLocation: RouterLocation | null = null

function LocationProbe() {
  lastLocation = useLocation()
  return null
}

/** Layout that keeps the location probe mounted across navigations. */
function ProbeLayout() {
  return (
    <>
      <LocationProbe />
      <Outlet />
    </>
  )
}

interface RenderOptions {
  route: string
}

function renderNew({ route }: RenderOptions): HTMLElement {
  lastLocation = null
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route element={<ProbeLayout />}>
            <Route path="/connections/new" element={<NewConnectionPage />} />
            <Route path="/integrations/:name" element={<div>integration</div>} />
            <Route path="*" element={<div>other</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function integrationRoutes(): StubRoute[] {
  return [
    {
      match: (url) => /^\/api\/v1\/integrations\/[^/]+$/.test(url.pathname),
      respond: (url) => {
        const name = url.pathname.split('/').pop() ?? ''
        if (name === 'github') return { status: 200, body: githubMetadata() }
        if (name === 'slack') return { status: 200, body: secretAuthMetadata() }
        if (name === 'jira') return { status: 200, body: basicAuthMetadata() }
        if (name === 'veeva') return { status: 200, body: customAuthMetadata() }
        return { status: 404, body: { message: `Piece ${name} not found` } }
      },
    },
  ]
}

async function setInput(container: HTMLElement, id: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submitForm(container: HTMLElement): Promise<void> {
  const form = container.querySelector('form')
  expect(form).not.toBeNull()
  await act(async () => {
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

interface RecordedRequest {
  method: string
  path: string
  body?: Record<string, unknown>
}

function stubRecordingApi(
  extraHandlers: Array<(req: RecordedRequest) => Response | undefined> = []
): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = String(input)
    const url = new URL(raw, 'http://localhost')
    let body: Record<string, unknown> | undefined
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = undefined
      }
    }
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body,
    }
    requests.push(request)

    for (const handler of extraHandlers) {
      const response = handler(request)
      if (response) return response
    }

    for (const route of integrationRoutes()) {
      if (route.match(url)) {
        const result = route.respond(url)
        return new Response(JSON.stringify(result.body), {
          status: result.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response(JSON.stringify({ message: `Unhandled request: ${raw}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  })
  return requests
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('New connection page', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    // The client reads ap-token from sessionStorage since #383.
    window.sessionStorage.setItem('ap-token', 'test-token')
  })

  it('shows guidance when no pieceName is provided', async () => {
    stubRecordingApi()
    const container = renderNew({ route: '/connections/new' })

    await waitFor(() => container.textContent?.includes('No integration selected') === true)
    expect(container.textContent).toContain('Browse Integrations')
  }, 15000)

  it('loads integration metadata derived by pieceName', async () => {
    const requests = stubRecordingApi()
    const container = renderNew({ route: '/connections/new?pieceName=github' })

    await waitFor(() => container.textContent?.includes('Connect GitHub') === true)

    expect(requests.some((req) => req.path.includes('/integrations/github'))).toBe(true)
    expect(container.textContent).toContain('OAuth 2.0')
  }, 15000)

  it('shows the not-found state for an unknown pieceName', async () => {
    stubRecordingApi()
    const container = renderNew({ route: '/connections/new?pieceName=ghost' })

    await waitFor(() => container.textContent?.includes('Integration not found') === true, 4000)
  }, 15000)

  it('renders the secret text form with a password input and creates the connection', async () => {
    const requests = stubRecordingApi([
      (req) =>
        req.method === 'POST' && req.path === '/api/v1/connections'
          ? jsonResponse(githubConnection('conn_new', 'Production Slack'), 201)
          : undefined,
    ])
    const container = renderNew({ route: '/connections/new?pieceName=slack' })

    await waitFor(() => container.textContent?.includes('Connect Slack') === true)

    const passwordInput = container.querySelector<HTMLInputElement>('#secret-text-value')
    expect(passwordInput?.getAttribute('type')).toBe('password')
    expect(passwordInput?.getAttribute('autocomplete')).toBe('new-password')

    await setInput(container, 'secret-display-name', 'Production Slack')
    await setInput(container, 'secret-text-value', 'xoxb-super-secret')

    // No credential values ever leak into the URL.
    expect(window.location.search).not.toContain('xoxb')
    expect(lastLocation?.search).not.toContain('xoxb')

    await submitForm(container)

    const createRequest = requests.find(
      (req) => req.method === 'POST' && req.path === '/api/v1/connections'
    )
    expect(createRequest).toBeDefined()
    expect(createRequest?.body).toMatchObject({
      displayName: 'Production Slack',
      pieceName: 'slack',
      type: 'SECRET_TEXT',
      externalId: expect.any(String),
    })
    expect(createRequest?.body?.value).toEqual({
      type: 'SECRET_TEXT',
      secret_text: 'xoxb-super-secret',
    })

    // Secret must not appear anywhere in the recorded URLs.
    expect(requests.every((req) => !JSON.stringify(req.path).includes('xoxb'))).toBe(true)

    await waitFor(() => lastLocation?.pathname === '/integrations/slack')
    expect(lastLocation?.search).toContain('tab=connections')
  }, 15000)

  it('validates required fields before submitting the secret text form', async () => {
    const requests = stubRecordingApi([
      (req) =>
        req.method === 'POST' && req.path === '/api/v1/connections'
          ? jsonResponse(githubConnection('conn_x', 'should not happen'), 201)
          : undefined,
    ])
    const container = renderNew({ route: '/connections/new?pieceName=slack' })

    await waitFor(() => container.textContent?.includes('Connect Slack') === true)

    await submitForm(container)

    await waitFor(
      () => container.querySelectorAll('[role="alert"]').length > 0
    )
    expect(container.textContent).toContain('Secret is required')
    expect(
      requests.some((req) => req.method === 'POST' && req.path === '/api/v1/connections')
    ).toBe(false)
  }, 15000)

  it('shows an API error when connection creation fails', async () => {
    stubRecordingApi([
      (req) =>
        req.method === 'POST' && req.path === '/api/v1/connections'
          ? jsonResponse({ message: 'Invalid token provided by provider.' }, 400)
          : undefined,
    ])
    const container = renderNew({ route: '/connections/new?pieceName=slack' })

    await waitFor(() => container.textContent?.includes('Connect Slack') === true)

    await setInput(container, 'secret-display-name', 'Bad Slack')
    await setInput(container, 'secret-text-value', 'wrong-token')
    await submitForm(container)

    await waitFor(() =>
      document.body.textContent?.includes('Invalid token provided by provider.') === true ||
      container.textContent?.includes('Invalid token provided by provider.') === true
    )
    // The failed secret is not echoed back into the UI.
    expect((document.body.textContent || '').includes('wrong-token')).toBe(false)
  }, 15000)

  it('renders the basic auth form and submits username/password values', async () => {
    const requests = stubRecordingApi([
      (req) =>
        req.method === 'POST' && req.path === '/api/v1/connections'
          ? jsonResponse(githubConnection('conn_basic', 'Jira Cloud'), 201)
          : undefined,
    ])
    const container = renderNew({ route: '/connections/new?pieceName=jira' })

    await waitFor(() => container.textContent?.includes('Connect Jira') === true)
    expect(container.querySelector('#basic-username')).not.toBeNull()

    const passwordInput = container.querySelector<HTMLInputElement>('#basic-password')
    expect(passwordInput?.getAttribute('type')).toBe('password')

    await setInput(container, 'basic-display-name', 'Jira Cloud')
    await setInput(container, 'basic-username', 'ops-user')
    await setInput(container, 'basic-password', 'hunter2')
    await submitForm(container)

    const createRequest = requests.find(
      (req) => req.method === 'POST' && req.path === '/api/v1/connections'
    )
    expect(createRequest?.body).toMatchObject({
      displayName: 'Jira Cloud',
      pieceName: 'jira',
      type: 'BASIC_AUTH',
    })
    expect(createRequest?.body?.value).toEqual({
      type: 'BASIC_AUTH',
      username: 'ops-user',
      password: 'hunter2',
    })
  }, 15000)

  it('generates the custom auth form from the integration auth schema', async () => {
    const container = renderNew({ route: '/connections/new?pieceName=veeva' })

    await waitFor(() => container.textContent?.includes('Connect Veeva Vault') === true)

    const labels = Array.from(container.querySelectorAll('label')).map((label) =>
      label.textContent?.trim()
    )
    expect(labels).toContain('Username *')
    expect(labels.join('\n')).toContain('Password')
    expect(labels.join('\n')).toContain('Vault count')
    expect(labels.join('\n')).toContain('SSO enabled')
    expect(labels.join('\n')).toContain('Region')

    // SECRET_TEXT auth prop renders masked; dropdown renders real options.
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull()
    const select = container.querySelector<HTMLSelectElement>('select')
    expect(select).not.toBeNull()
    expect(select?.textContent).toContain('EU')
    expect(select?.textContent).toContain('US')
  }, 15000)

  it('submits CUSTOM_AUTH props collected from the schema-driven form', async () => {
    const requests = stubRecordingApi([
      (req) =>
        req.method === 'POST' && req.path === '/api/v1/connections'
          ? jsonResponse({ ...githubConnection('conn_custom', 'Veeva Prod'), type: 'CUSTOM_AUTH' }, 201)
          : undefined,
    ])
    const container = renderNew({ route: '/connections/new?pieceName=veeva' })

    await waitFor(() => container.textContent?.includes('Connect Veeva Vault') === true)

    await setInput(container, 'custom-display-name', 'Veeva Prod')
    await setInput(container, 'auth-prop-username', 'vault-admin')
    await setInput(container, 'auth-prop-password', 'vaul7-pass')
    await setInput(container, 'auth-prop-vaultCount', '3')

    const checkbox = container.querySelector<HTMLInputElement>('#auth-prop-ssoEnabled')
    await act(async () => {
      checkbox?.click()
    })

    const select = container.querySelector<HTMLSelectElement>('select')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      const euOption = select?.querySelector<HTMLOptionElement>('option:nth-child(2)')
      setter?.call(select, euOption?.value ?? '')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await submitForm(container)

    const createRequest = requests.find(
      (req) => req.method === 'POST' && req.path === '/api/v1/connections'
    )
    expect(createRequest?.body?.type).toBe('CUSTOM_AUTH')
    expect(createRequest?.body?.value).toEqual({
      type: 'CUSTOM_AUTH',
      props: {
        username: 'vault-admin',
        password: 'vaul7-pass',
        vaultCount: 3,
        ssoEnabled: true,
        region: 'eu',
      },
    })
  }, 15000)

  describe('OAuth2 flow', () => {
    function stubPopup(authorizationUrl: string): { popup: { closed: boolean; close(): void } } {
      const popup = { closed: false, close: () => undefined }
      vi.spyOn(window, 'open').mockImplementation(((url: string | URL) => {
        expect(String(url)).toBe(authorizationUrl)
        return popup as unknown as Window
      }) as typeof window.open)
      return { popup }
    }

    async function completeOAuth(
      container: HTMLElement,
      requests: RecordedRequest[],
      popup: { closed: boolean; close(): void }
    ) {
      await waitFor(() => container.textContent?.includes('Connect GitHub') === true)

      await setInput(container, 'oauth-display-name', 'Mihir GitHub')
      await setInput(container, 'oauth-client-id', 'my-client-id')
      await setInput(container, 'oauth-client-secret', 'my-client-secret')
      await submitForm(container)

      await waitFor(() =>
        requests.some((req) => req.path === '/api/v1/connections/oauth2/authorization-url')
      )

      const authUrlRequest = requests.find(
        (req) => req.path === '/api/v1/connections/oauth2/authorization-url'
      )
      expect(authUrlRequest?.body).toMatchObject({
        pieceName: 'github',
        clientId: 'my-client-id',
        redirectUrl: `${window.location.origin}/redirect`,
      })

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: popup as unknown as Window | null,
            data: { code: 'oauth-code-123' },
          })
        )
      })
    }

    it('requests a real authorization URL and completes the connection via callback code', async () => {
      const authorizationUrl = 'https://github.com/login/oauth/authorize?client_id=abc'
      const requests = stubRecordingApi([
        (req) => {
          if (
            req.method === 'POST' &&
            req.path === '/api/v1/connections/oauth2/authorization-url'
          ) {
            return jsonResponse({ authorizationUrl, codeVerifier: 'verifier-123' })
          }
          if (req.method === 'POST' && req.path === '/api/v1/connections') {
            return jsonResponse(githubConnection('conn_oauth', 'Mihir GitHub'), 201)
          }
          return undefined
        },
      ])
      const container = renderNew({ route: '/connections/new?pieceName=github' })
      const { popup } = stubPopup(authorizationUrl)

      await completeOAuth(container, requests, popup)

      const createRequest = requests.find(
        (req) => req.method === 'POST' && req.path === '/api/v1/connections'
      )
      expect(createRequest).toBeDefined()
      expect(createRequest?.body).toMatchObject({
        displayName: 'Mihir GitHub',
        pieceName: 'github',
        type: 'OAUTH2',
        externalId: expect.any(String),
      })
      expect(createRequest?.body?.value).toMatchObject({
        type: 'OAUTH2',
        client_id: 'my-client-id',
        client_secret: 'my-client-secret',
        code: 'oauth-code-123',
        code_challenge: 'verifier-123',
        redirect_url: `${window.location.origin}/redirect`,
        scope: '',
      })

      await waitFor(() => lastLocation?.pathname === '/integrations/github')
      expect(lastLocation?.search).toContain('tab=connections')
    }, 15000)

    it('reuses the existing externalId when reconnecting so the connection updates in place', async () => {
      const authorizationUrl = 'https://github.com/login/oauth/authorize?client_id=abc'
      const requests = stubRecordingApi([
        (req) => {
          if (
            req.method === 'POST' &&
            req.path === '/api/v1/connections/oauth2/authorization-url'
          ) {
            return jsonResponse({ authorizationUrl })
          }
          if (req.method === 'POST' && req.path === '/api/v1/connections') {
            return jsonResponse(githubConnection('conn_1', 'Mihir GitHub'), 201)
          }
          return undefined
        },
      ])
      const container = renderNew({
        route:
          '/connections/new?pieceName=github&externalId=ext_conn_1&displayName=Mihir%20GitHub',
      })
      const { popup } = stubPopup(authorizationUrl)

      await completeOAuth(container, requests, popup)

      const createRequest = requests.find(
        (req) => req.method === 'POST' && req.path === '/api/v1/connections'
      )
      expect(createRequest?.body?.externalId).toBe('ext_conn_1')
    }, 15000)

    it('reports a useful state when no code arrives because the popup was closed', async () => {
      const authorizationUrl = 'https://github.com/login/oauth/authorize?client_id=abc'
      const requests = stubRecordingApi([
        (req) =>
          req.method === 'POST' &&
          req.path === '/api/v1/connections/oauth2/authorization-url'
            ? jsonResponse({ authorizationUrl })
            : undefined,
      ])
      const container = renderNew({ route: '/connections/new?pieceName=github' })
      const { popup } = stubPopup(authorizationUrl)

      await waitFor(() => container.textContent?.includes('Connect GitHub') === true)
      await setInput(container, 'oauth-display-name', 'GH')
      await setInput(container, 'oauth-client-id', 'cid')
      await setInput(container, 'oauth-client-secret', 'cs')
      await submitForm(container)

      await waitFor(() =>
        requests.some((req) => req.path === '/api/v1/connections/oauth2/authorization-url')
      )

      await act(async () => {
        popup.closed = true
      })

      await waitFor(
        () =>
          container.textContent?.includes(
            'The authorization window was closed before access was granted.'
          ) === true,
        6000
      )
      expect(
        requests.some((req) => req.method === 'POST' && req.path === '/api/v1/connections')
      ).toBe(false)
    }, 15000)
  })
})
