import { beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './sidebar'
import { mountAt, waitFor } from '@/test/test-utils'
import { stubApi } from '@/test/api-stub'
import { apiClient } from '@/lib/api/client'

const CORE_ITEMS = [
  'Overview',
  'Integrations',
  'Connections',
  'Actions',
  'Triggers',
  'Scheduled Tasks',
  'MCP',
]
const PLATFORM_ITEMS = ['Activity', 'Developers', 'API Keys', 'Settings']
const LEGACY_ITEMS = ['Flows', 'Flow Runs', 'Flow Versions', 'Folders']

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  it('renders all developer console navigation groups', () => {
    const container = mountAt(<Sidebar />, { route: '/' })
    const text = container.textContent || ''

    CORE_ITEMS.forEach((label) => expect(text).toContain(label))
    PLATFORM_ITEMS.forEach((label) => expect(text).toContain(label))
  })

  it('does not render legacy flow-builder navigation', () => {
    const container = mountAt(<Sidebar />, { route: '/' })
    const text = container.textContent || ''

    LEGACY_ITEMS.forEach((label) => expect(text).not.toContain(label))
  })

  it('marks the active route with aria-current and active styling', () => {
    const container = mountAt(<Sidebar />, { route: '/integrations' })

    const activeLink = container.querySelector('a[href="/integrations"]')
    expect(activeLink).not.toBeNull()
    expect(activeLink?.getAttribute('aria-current')).toBe('page')
    expect(activeLink?.className).toContain('text-primary')

    const overviewLink = container.querySelector('a[href="/"]')
    expect(overviewLink?.getAttribute('aria-current')).toBeNull()
    expect(overviewLink?.className).not.toContain('text-primary')
  })

  it('shows a proper "No Project" state when no project is selected (#174)', () => {
    const container = mountAt(<Sidebar />, { route: '/' })

    expect(container.textContent).toContain('No Project')
    expect(container.textContent).toContain('Developer Console')
  })

  it('shows the current project from the auth context when authenticated', async () => {
    sessionStorage.setItem('ap-user', JSON.stringify({ id: 'u_1', firstName: 'Dev', email: 'dev@inboxfm.local' }))
    apiClient.setToken('test-token')
    stubApi([
      {
        match: (url) => url.pathname.includes('/projects'),
        respond: () => ({
          status: 200,
          body: { data: [{ id: 'proj_alpha', displayName: 'Alpha Workspace', platformId: 'plat_1' }] },
        }),
      },
    ])

    const container = mountAt(<Sidebar />, { route: '/' })
    await waitFor(() => container.textContent?.includes('Alpha Workspace') === true)

    expect(container.textContent).toContain('Alpha Workspace')
    expect(container.textContent).toContain('Developer Console')
  })

  it('shows Not signed in for the session user with an empty email', () => {
    // Explicit session user with empty email string (covers auth-context fallback)
    sessionStorage.setItem('ap-user', JSON.stringify({ id: 'u_1', firstName: 'Dev', email: '' }))
    apiClient.setToken('test-token')
    const container = mountAt(<Sidebar />, { route: '/' })

    expect(container.textContent).toContain('Not signed in')
  })
})

