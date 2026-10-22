import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import LoginPage from './login'
import { apiClient } from '@/lib/api/client'
import { mount, waitFor } from '@/test/test-utils'

const mockSignIn = vi.fn()

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({
    signIn: mockSignIn,
    user: null,
    isAuthenticated: false,
    isLoading: false,
  }),
}))

describe('LoginPage navigation handling (#173)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockSignIn.mockClear()
  })

  it('redirects to index route (/) upon successful sign-in by default', async () => {
    function Destinations() {
      return (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <div>
                <h1>Dashboard Page</h1>
              </div>
            }
          />
        </Routes>
      )
    }

    vi.spyOn(apiClient, 'post').mockResolvedValue({
      id: 'usr_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      token: 'jwt_123',
      projectId: 'prj_123',
    })

    const container = mount(
      <MemoryRouter initialEntries={['/login']}>
        <Destinations />
      </MemoryRouter>
    )

    const devButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('dev@ap.com')
    )
    expect(devButton).toBeDefined()

    await act(async () => {
      devButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Dashboard Page') === true)
    expect(container.textContent).toContain('Dashboard Page')
    expect(mockSignIn).toHaveBeenCalledWith('jwt_123', expect.any(Object), 'prj_123')
  })

  it('redirects to returnUrl search parameter if provided in query string', async () => {
    function Destinations() {
      return (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/settings"
            element={
              <div>
                <h1>Settings Page</h1>
              </div>
            }
          />
        </Routes>
      )
    }

    vi.spyOn(apiClient, 'post').mockResolvedValue({
      id: 'usr_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      token: 'jwt_123',
      projectId: 'prj_123',
    })

    const container = mount(
      <MemoryRouter initialEntries={['/login?returnUrl=%2Fsettings']}>
        <Destinations />
      </MemoryRouter>
    )

    const devButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('dev@ap.com')
    )
    expect(devButton).toBeDefined()

    await act(async () => {
      devButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Settings Page') === true)
    expect(container.textContent).toContain('Settings Page')
  })

  it('redirects to location.state.from when redirected by RequireAuth (preserving pathname, search, and hash)', async () => {
    function Destinations() {
      return (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/connections"
            element={
              <div>
                <h1>Connections Page</h1>
              </div>
            }
          />
        </Routes>
      )
    }

    vi.spyOn(apiClient, 'post').mockResolvedValue({
      id: 'usr_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      token: 'jwt_123',
      projectId: 'prj_123',
    })

    const initialEntry = {
      pathname: '/login',
      state: {
        from: {
          pathname: '/connections',
          search: '?tab=active',
          hash: '#details',
        },
      },
    }

    const container = mount(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Destinations />
      </MemoryRouter>
    )

    const devButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('dev@ap.com')
    )
    expect(devButton).toBeDefined()

    await act(async () => {
      devButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Connections Page') === true)
    expect(container.textContent).toContain('Connections Page')
  })

  it('redirects to location.state.from when state.from is a string path', async () => {
    function Destinations() {
      return (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/schedules"
            element={
              <div>
                <h1>Schedules Page</h1>
              </div>
            }
          />
        </Routes>
      )
    }

    vi.spyOn(apiClient, 'post').mockResolvedValue({
      id: 'usr_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      token: 'jwt_123',
      projectId: 'prj_123',
    })

    const initialEntry = {
      pathname: '/login',
      state: {
        from: '/schedules',
      },
    }

    const container = mount(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Destinations />
      </MemoryRouter>
    )

    const devButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('dev@ap.com')
    )
    expect(devButton).toBeDefined()

    await act(async () => {
      devButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Schedules Page') === true)
    expect(container.textContent).toContain('Schedules Page')
  })

  it('rejects external open redirects (//attacker.com) and defaults to /', async () => {
    function Destinations() {
      return (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <div>
                <h1>Dashboard Page</h1>
              </div>
            }
          />
        </Routes>
      )
    }

    vi.spyOn(apiClient, 'post').mockResolvedValue({
      id: 'usr_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      token: 'jwt_123',
      projectId: 'prj_123',
    })

    const container = mount(
      <MemoryRouter initialEntries={['/login?returnUrl=%2F%2Fattacker.com']}>
        <Destinations />
      </MemoryRouter>
    )

    const devButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('dev@ap.com')
    )
    expect(devButton).toBeDefined()

    await act(async () => {
      devButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Dashboard Page') === true)
    expect(container.textContent).toContain('Dashboard Page')
  })

  it('rejects redirect to /login and defaults to /', async () => {
    function Destinations() {
      return (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <div>
                <h1>Dashboard Page</h1>
              </div>
            }
          />
        </Routes>
      )
    }

    vi.spyOn(apiClient, 'post').mockResolvedValue({
      id: 'usr_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      token: 'jwt_123',
      projectId: 'prj_123',
    })

    const initialEntry = {
      pathname: '/login',
      state: {
        from: { pathname: '/login' },
      },
    }

    const container = mount(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Destinations />
      </MemoryRouter>
    )

    const devButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('dev@ap.com')
    )
    expect(devButton).toBeDefined()

    await act(async () => {
      devButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Dashboard Page') === true)
    expect(container.textContent).toContain('Dashboard Page')
  })
})
