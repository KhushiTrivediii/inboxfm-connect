import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth/auth-context'
import { apiClient } from '@/lib/api/client'
import { queryClient } from '@/lib/query/query-client'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { router } from '@/router'
import { RouterProvider } from 'react-router-dom'
import { act } from 'react'
import { mount, waitFor } from '@/test/test-utils'

function stubBackend() {
  const mockProject = {
    id: 'prj_test',
    displayName: 'Test Project',
    platformId: 'plt_test',
  }
  const stubFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const pathname = new URL(url, 'http://localhost').pathname
    if (pathname === '/api/v1/projects') {
      return new Response(JSON.stringify({ data: [mockProject] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const isArrayResponse =
      url.includes('/trigger-bindings') || url.includes('/scheduled-tasks')
    const body = isArrayResponse ? [] : { data: [], next: null, previous: null }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  global.fetch = vi.fn(stubFetch)
}

function signInTestUser() {
  const mockUser = {
    id: 'usr_test',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    platformId: 'plt_test',
  }
  apiClient.setToken('mock-token')
  apiClient.setProjectId('prj_test')
  sessionStorage.setItem('ap-user', JSON.stringify(mockUser))
}

function signOutTestUser() {
  apiClient.setToken(null)
  apiClient.setProjectId(null)
  localStorage.clear()
  sessionStorage.clear()
}

async function navigateAndMount(path: string): Promise<HTMLElement> {
  await act(async () => {
    if (router.state.location.pathname === path) {
      await router.navigate('/__reset_route__')
    }
    await router.navigate(path)
  })

  return mount(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

async function renderRouterAt(path: string): Promise<HTMLElement> {
  const container = await navigateAndMount(path)
  await waitFor(() => container.querySelector('aside') !== null, 8000)
  return container
}

describe('router', () => {
  beforeEach(() => {
    queryClient.clear()
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = ''
    apiClient.setToken('test-token')
    apiClient.setProjectId('proj_default')
    stubBackend()
    signInTestUser()
  })

  it('renders the application shell at the index route', async () => {
    const container = await renderRouterAt('/')

    expect(container.querySelector('aside')).not.toBeNull()
    expect(container.textContent).toContain('Search integrations, tools, routes...')
  }, 15000)

  it('serves the dashboard page at /', async () => {
    const container = await renderRouterAt('/')

    await waitFor(() => container.textContent?.includes('Developer Quick Actions') === true, 8000)

    expect(container.textContent).toContain('Welcome back')
    expect(container.textContent).toContain('Available Tools')
  }, 15000)

  it('redirects unknown routes to the 404 page', async () => {
    const container = await renderRouterAt('/this-route-does-not-exist')

    await waitFor(() => document.body.textContent?.includes('404') === true)

    expect(container.querySelector('aside')).not.toBeNull()
    expect(document.body.textContent).toContain('404')
  }, 15000)

  it('serves the public landing page at /welcome without the app shell', async () => {
    const container = await navigateAndMount('/welcome')

    await waitFor(() => document.body.textContent?.includes('InboxFM Connect') === true)

    expect(container.querySelector('aside')).toBeNull()
    expect(document.body.textContent).toContain('Workflow automation built for')
    expect(document.body.querySelector('a[href="/login"]')).not.toBeNull()
  }, 15000)

  it('redirects unauthenticated users to the /login page preserving return URL', async () => {
    signOutTestUser()
    const container = await navigateAndMount('/connections')

    await waitFor(() => document.body.textContent?.includes('Sign in') === true)

    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.state).toEqual({
      from: expect.objectContaining({ pathname: '/connections' }),
    })
    expect(container.querySelector('aside')).toBeNull()
  }, 15000)

  it('navigates to /actions when clicking the empty-state CTA on dashboard', async () => {
    const container = await renderRouterAt('/')

    await waitFor(() => container.textContent?.includes('Explore Tools to Test') === true)

    const ctaButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Explore Tools to Test')
    )
    expect(ctaButton).toBeDefined()

    await act(async () => {
      ctaButton?.click()
    })

    await waitFor(() => router.state.location.pathname === '/actions')
    expect(router.state.location.pathname).toBe('/actions')
  }, 15000)

  it('navigates to /actions when clicking the empty-state CTA on activity', async () => {
    const container = await renderRouterAt('/activity')

    await waitFor(() => container.textContent?.includes('Explore Actions to Run') === true)

    const ctaButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Explore Actions to Run')
    )
    expect(ctaButton).toBeDefined()

    await act(async () => {
      ctaButton?.click()
    })

    await waitFor(() => router.state.location.pathname === '/actions')
    expect(router.state.location.pathname).toBe('/actions')
  }, 15000)
})
