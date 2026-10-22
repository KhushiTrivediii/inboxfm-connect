import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation, type Location } from 'react-router-dom'
import { RequireAuth } from './require-auth'
import { mount } from '@/test/test-utils'

const mockUseAuth = vi.fn()

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads the pathname RequireAuth stashed in `state.from`. Asserts the navigation
 * happened and narrows through unknown at each hop, so no cast is needed.
 */
function readRedirectTargetPathname(location: Location | null): string | null {
  if (location === null) {
    throw new Error('expected RequireAuth to have navigated to /login')
  }
  if (!isRecord(location.state)) {
    return null
  }
  const from: unknown = location.state.from
  if (!isRecord(from)) {
    return null
  }
  const { pathname } = from
  return typeof pathname === 'string' ? pathname : null
}

describe('RequireAuth', () => {
  it('renders loading state while session restore is in progress (isLoading = true)', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: true,
    })

    const container = mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <RequireAuth>
          <div>Protected Content</div>
        </RequireAuth>
      </MemoryRouter>
    )

    expect(container.querySelector('[data-testid="auth-loading"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Protected Content')
  })

  it('redirects unauthenticated user to /login preserving return location', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    })

    // Typed through a mutable box: TS narrows a plain `let` to `never` after the
    // initializer (it cannot see that React calls LoginProbe), so `capturedLocation?.`
    // would not typecheck.
    const capture: { location: Location | null } = { location: null }

    function LoginProbe() {
      capture.location = useLocation()
      return <div>Login Page</div>
    }

    const container = mount(
      <MemoryRouter initialEntries={['/connections']}>
        <Routes>
          <Route
            path="/connections"
            element={
              <RequireAuth>
                <div>Protected Content</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>
    )

    expect(container.textContent).toContain('Login Page')
    expect(container.textContent).not.toContain('Protected Content')
    expect(capture.location).not.toBeNull()
    expect(capture.location?.pathname).toBe('/login')
    expect(readRedirectTargetPathname(capture.location)).toBe('/connections')
  })

  it('renders children when user is authenticated', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    })

    const container = mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <RequireAuth>
          <div>Protected Content</div>
        </RequireAuth>
      </MemoryRouter>
    )

    expect(container.textContent).toContain('Protected Content')
  })
})
