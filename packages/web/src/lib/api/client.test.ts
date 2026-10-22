import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient, ApiClient as ApiClientClass, ApiClientError } from './client'
import { setAuthNavigator } from '../auth/auth-navigation'

describe('ApiClient', () => {
  const mockNavigator = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    apiClient.setToken(null)
    apiClient.setProjectId(null)
    apiClient.resetRedirectState()
    mockNavigator.mockClear()
    setAuthNavigator(mockNavigator)
    vi.restoreAllMocks()
    window.history.pushState({}, '', '/dashboard')
  })

  it('should initialize with null token and project', () => {
    expect(apiClient.getToken()).toBeNull()
    expect(apiClient.getProjectId()).toBeNull()
  })

  it('stores the session token in sessionStorage, not localStorage (issue #383)', () => {
    apiClient.setToken('test_token_123')
    apiClient.setProjectId('proj_abc')

    expect(apiClient.getToken()).toBe('test_token_123')
    expect(apiClient.getProjectId()).toBe('proj_abc')
    // the 7-day credential must live in the tab-scoped store only
    expect(sessionStorage.getItem('ap-token')).toBe('test_token_123')
    expect(sessionStorage.getItem('ap-project-id')).toBe('proj_abc')
    expect(localStorage.getItem('ap-token')).toBeNull()
    expect(localStorage.getItem('ap-project-id')).toBeNull()
  })

  it('clears a legacy localStorage token left by an older build on sign-out', () => {
    localStorage.setItem('ap-token', 'stale_legacy_token')
    localStorage.setItem('ap-project-id', 'stale_legacy_project')

    apiClient.setToken(null)
    apiClient.setProjectId(null)

    expect(localStorage.getItem('ap-token')).toBeNull()
    expect(localStorage.getItem('ap-project-id')).toBeNull()
  })

  it('adopts a legacy localStorage session on first load and purges the exposed copy (review #384)', () => {
    // The upgrading user keeps working: the constructor moves their legacy
    // token into sessionStorage, keeps the session, and deletes the
    // world-readable copy in the same breath.
    localStorage.setItem('ap-token', 'legacy_session_token')
    localStorage.setItem('ap-project-id', 'legacy_project')

    const fresh = new ApiClientClass()

    expect(fresh.getToken()).toBe('legacy_session_token')
    expect(fresh.getProjectId()).toBe('legacy_project')
    expect(sessionStorage.getItem('ap-token')).toBe('legacy_session_token')
    expect(sessionStorage.getItem('ap-project-id')).toBe('legacy_project')
    expect(localStorage.getItem('ap-token')).toBeNull()
    expect(localStorage.getItem('ap-project-id')).toBeNull()
  })

  it('purges leftover legacy keys even when a session already exists in sessionStorage (review #384)', () => {
    // A second tab may have adopted the session first; this tab must still
    // delete the parked credential.
    sessionStorage.setItem('ap-token', 'current_session')
    localStorage.setItem('ap-token', 'stale_legacy_token')

    const fresh = new ApiClientClass()

    expect(fresh.getToken()).toBe('current_session')
    expect(localStorage.getItem('ap-token')).toBeNull()
  })

  it('should throw ApiClientError on non-200 responses', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'Resource not found' }),
    })

    await expect(apiClient.get('/test')).rejects.toThrow(ApiClientError)
  })

  it('should return parsed JSON data on 200 responses', async () => {
    const mockData = { id: '123', status: 'ACTIVE' }
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockData,
    })

    const result = await apiClient.get('/test')
    expect(result).toEqual(mockData)
  })

  describe('401 Unauthorized handling (#173)', () => {
    it('redirects to /login and clears stored auth state on 401 response', async () => {
      apiClient.setToken('expired_token')
      apiClient.setProjectId('proj_123')
      localStorage.setItem('ap-user', JSON.stringify({ email: 'test@ap.com' }))

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Token expired' }),
      })

      await expect(apiClient.get('/projects')).rejects.toThrow(ApiClientError)

      expect(apiClient.getToken()).toBeNull()
      expect(apiClient.getProjectId()).toBeNull()
      expect(localStorage.getItem('ap-user')).toBeNull()
      expect(mockNavigator).toHaveBeenCalledTimes(1)
      expect(mockNavigator).toHaveBeenCalledWith(
        expect.stringContaining('/login'),
        expect.objectContaining({ replace: true })
      )
    })

    it('notifies onUnauthorized listener when 401 response is handled', async () => {
      const mockUnauthorizedListener = vi.fn()
      apiClient.setOnUnauthorized(mockUnauthorizedListener)

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Session revoked' }),
      })

      await expect(apiClient.get('/projects')).rejects.toThrow(ApiClientError)

      expect(mockUnauthorizedListener).toHaveBeenCalledTimes(1)
      apiClient.setOnUnauthorized(null)
    })

    it('does not trigger redirect on 401 from sign-in endpoint (invalid credentials)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Invalid credentials' }),
      })

      await expect(
        apiClient.post('/authentication/sign-in', { email: 'bad@ap.com', password: 'wrong' })
      ).rejects.toThrow(ApiClientError)

      expect(mockNavigator).not.toHaveBeenCalled()
    })

    it('handles concurrent 401 responses and triggers navigation exactly once without loops', async () => {
      apiClient.setToken('expired_token')

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Unauthorized' }),
      })

      const requests = [
        apiClient.get('/projects').catch(() => null),
        apiClient.get('/connections').catch(() => null),
        apiClient.get('/executions').catch(() => null),
      ]

      await Promise.all(requests)

      expect(mockNavigator).toHaveBeenCalledTimes(1)
    })

    it('absorbs a burst of 401s from the same route and redirects again once the route changes', async () => {
      apiClient.setToken('expired_token')

      const respondUnauthorized = () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ message: 'Unauthorized' }),
        })
      }
      respondUnauthorized()

      await expect(apiClient.get('/projects')).rejects.toThrow(ApiClientError)
      expect(mockNavigator).toHaveBeenCalledTimes(1)

      // Still on the route that triggered the redirect, however long we wait: a
      // later 401 must not start a second redirect. (The old guard cleared itself
      // on a 100ms timer, so this is exactly the window it reopened.)
      vi.useFakeTimers()
      try {
        respondUnauthorized()
        await expect(apiClient.get('/connections')).rejects.toThrow(ApiClientError)
        vi.advanceTimersByTime(5000)
        expect(mockNavigator).toHaveBeenCalledTimes(1)
        // The guard is path-keyed, not polled, so it leaves no timer running.
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }

      // Landing on a different route makes the guard inert by itself: a further
      // 401 there is free to redirect again.
      window.history.pushState({}, '', '/executions')
      respondUnauthorized()
      await expect(apiClient.get('/runs')).rejects.toThrow(ApiClientError)
      expect(mockNavigator).toHaveBeenCalledTimes(2)
    })

    it('unlatches the redirect guard when navigation to login throws', () => {
      mockNavigator.mockImplementationOnce(() => {
        throw new Error('router exploded')
      })

      expect(() => apiClient.handleUnauthorized()).toThrow('router exploded')

      // The guard must not stay latched, otherwise every later 401 is swallowed
      // and the user can never reach /login.
      apiClient.handleUnauthorized()
      expect(mockNavigator).toHaveBeenCalledTimes(2)
    })

    it('does not trigger redirect if already on /login', async () => {
      window.history.pushState({}, '', '/login')

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Unauthorized' }),
      })

      await expect(apiClient.get('/some-route')).rejects.toThrow(ApiClientError)

      expect(mockNavigator).not.toHaveBeenCalled()
    })
  })
})
