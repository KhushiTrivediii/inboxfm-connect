import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import TriggersPage from './index'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { stubApi, StubRoute } from '@/test/api-stub'
import { ALL_SUMMARIES, githubMetadata, seekPage } from '@/test/fixtures/integrations'
import { PieceMetadata } from '@/lib/api/types'

function slackMetadata(): PieceMetadata {
  return {
    ...githubMetadata(),
    name: 'slack',
    displayName: 'Slack',
    triggers: {
      newMessage: {
        name: 'newMessage',
        displayName: 'New Message',
        description: 'Triggers when a new message is posted.',
        type: 'WEBHOOK',
        props: {},
      },
    },
  }
}

function routes(options: { metadata?: Record<string, PieceMetadata> } = {}): StubRoute[] {
  return [
    {
      match: (url) => url.pathname === '/api/v1/integrations',
      respond: () => ({ status: 200, body: seekPage(ALL_SUMMARIES) }),
    },
    {
      match: (url) => url.pathname.startsWith('/api/v1/integrations/'),
      respond: (url) => {
        const name = url.pathname.replace('/api/v1/integrations/', '')
        const body = options.metadata?.[name]
        if (!body) {
          return { status: 404, body: { message: 'not found' } }
        }
        return { status: 200, body }
      },
    },
  ]
}

function renderDiscovery(initialRoute = '/triggers'): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route path="/triggers" element={<TriggersPage />} />
          <Route path="/automations/triggers/new" element={<div>binding form</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function selectIntegration(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label)
  )
  expect(button).toBeTruthy()
  await act(async () => {
    button?.click()
  })
}

describe('Trigger discovery', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('loads real trigger metadata for the selected integration without fetching every piece', async () => {
    const { calls } = stubApi(routes({ metadata: { github: githubMetadata(), slack: slackMetadata() } }))
    const container = renderDiscovery()

    await waitFor(() => container.textContent?.includes('New Issue') === true)

    const metadataCalls = calls.filter((call) =>
      /^.*\/api\/v1\/integrations\/[a-z]+$/.test(call)
    )
    expect(metadataCalls.length).toBe(1)

    const items = container.querySelectorAll('[data-testid="trigger-discovery-item"]')
    expect(items.length).toBe(2)
    expect(container.textContent).toContain('New Issue')
    expect(container.textContent).toContain('Triggers when a new issue is created.')
    expect(container.textContent).toContain('Push Event')

    await selectIntegration(container, 'Slack')
    await waitFor(() => container.textContent?.includes('New Message') === true)

    const slackCalls = calls.filter((call) => call.includes('/api/v1/integrations/slack'))
    expect(slackCalls.length).toBe(1)

    expect(container.textContent).toContain('Webhook')
    expect(container.textContent).not.toContain('FlowRun')
  }, 15000)

  it('links each trigger into the binding creation flow with source preselected', async () => {
    stubApi(routes({ metadata: { github: githubMetadata() } }))
    const container = renderDiscovery()

    await waitFor(() => container.textContent?.includes('New Issue') === true)

    const createLink = container.querySelector<HTMLAnchorElement>(
      '[data-testid="create-binding-newIssue"]'
    )
    expect(createLink).not.toBeNull()
    expect(createLink?.getAttribute('href')).toContain('/automations/triggers/new')
    expect(decodeURIComponent(createLink?.getAttribute('href') ?? '')).toContain('pieceName=github')
    expect(decodeURIComponent(createLink?.getAttribute('href') ?? '')).toContain('triggerName=newIssue')
  }, 15000)

  it('shows an empty state when no integration matches the search', async () => {
    stubApi(routes({ metadata: { github: githubMetadata() } }))
    const container = renderDiscovery()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    const input = container.querySelector<HTMLInputElement>('input[type="search"], input[aria-label="Search integrations"]')
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'zzz-no-match')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await waitFor(() => container.textContent?.includes('No integrations match your search') === true)
  }, 15000)
})
