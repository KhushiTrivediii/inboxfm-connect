import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { AppShell } from './app-shell'
import { AuthProvider } from '@/lib/auth/auth-context'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

function renderShell(page?: React.ReactElement): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<AppShell />}>
                {page ? <Route index element={page} /> : null}
              </Route>
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

describe('AppShell', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('renders the authenticated layout with sidebar, header, and routed outlet', () => {
    const container = renderShell(<div data-testid="page-content">page content marker</div>)

    expect(container.querySelector('aside')).not.toBeNull()
    expect(container.textContent).toContain('Developer Console')
    expect(container.textContent).toContain('Search integrations, tools, routes...')
    expect(container.textContent).toContain('Dev Environment')
    expect(document.body.textContent).toContain('page content marker')
  })

  it('opens the command palette from the header search button', async () => {
    const container = renderShell()

    const searchButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Search integrations')
    )
    expect(searchButton).toBeDefined()

    await act(async () => {
      searchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => document.querySelector('[cmdk-root]') !== null)
    expect(document.body.textContent).toContain('Overview Dashboard')
  })

  it('opens the command palette via Ctrl+K', async () => {
    renderShell()

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })
      )
    })

    await waitFor(() => document.querySelector('[cmdk-root]') !== null)
    expect(document.body.textContent).toContain('Integrations Catalog')
  })

  it('renders the outlet page inside the route error boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = renderShell(<ThrowingPage />)

    expect(container.querySelector('aside')).not.toBeNull()
    expect(container.textContent).toContain('Application Error')
  })
})

function ThrowingPage(): React.ReactElement {
  throw new Error('route crash')
}
