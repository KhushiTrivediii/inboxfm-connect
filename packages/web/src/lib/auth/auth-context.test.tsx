import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api/client'
import { AuthProvider, useAuth } from '@/lib/auth/auth-context'
import { setAuthNavigator } from '@/lib/auth/auth-navigation'
import { stubApi } from '@/test/api-stub'
import { mount, waitFor } from '@/test/test-utils'

/**
 * Regression coverage for two defects a real browser click-through surfaced that the
 * API-stubbed page tests could not:
 *
 *  A. Session restore hit `GET /users/me`, which the backend does not expose (only
 *     `GET /users/:id` and `POST /users/me`). It always 400'd, dropping every real
 *     session into the local dev-mock fallback — which then overwrote the real
 *     `projectId` with `proj_default` and 404'd every project-scoped read.
 *  B. `signIn` receives the FLAT sign-in payload (user fields + token + projectId at
 *     the top level, no nested `user`), so the stored identity must be the payload
 *     itself, not a `.user` sub-object.
 */

let capturedAuth: ReturnType<typeof useAuth> | null = null

function AuthProbe() {
  capturedAuth = useAuth()
  return null
}

/**
 * `waitFor` cannot narrow `capturedAuth` for the compiler, so read it through this
 * instead of a non-null assertion: it either yields the context or fails loudly.
 */
function requireAuth(): ReturnType<typeof useAuth> {
  if (capturedAuth === null) {
    throw new Error('AuthProbe never rendered, so no auth context was captured')
  }
  return capturedAuth
}

function renderAuth() {
  return mount(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>
  )
}

const REAL_PROJECT_ID = 'aI8Kiljzb25GOgHm90NZu'
const REAL_USER = {
  id: '011YVTRotpxPKCl8hx0Tx',
  email: 'dev@ap.com',
  firstName: 'Ash',
  lastName: 'Dev',
  platformId: 'yM3YotgCYYZwTkVkYS20h',
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  apiClient.setToken(null)
  apiClient.setProjectId(null)
  capturedAuth = null
  setAuthNavigator(vi.fn())
})

afterEach(() => {
  localStorage.clear()
  setAuthNavigator(null)
  sessionStorage.clear()
})

describe('auth session restore', () => {
  it('never calls the non-existent GET /users/me and keeps the real project', async () => {
    // The apiClient is a singleton that cached localStorage at import time, so seed it
    // through its setters (which loadSession reads via apiClient.getToken/getProjectId).
    apiClient.setToken('real-jwt')
    apiClient.setProjectId(REAL_PROJECT_ID)
    localStorage.setItem('ap-user', JSON.stringify(REAL_USER))

    const { calls } = stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({
          status: 200,
          body: { data: [{ id: REAL_PROJECT_ID, displayName: 'InboxFM Main Project', platformId: REAL_USER.platformId }] },
        }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)

    expect(calls.some((c) => c.includes('/users/me'))).toBe(false)
    expect(capturedAuth?.isAuthenticated).toBe(true)
    expect(capturedAuth?.user?.email).toBe('dev@ap.com')
    expect(capturedAuth?.currentProject?.id).toBe(REAL_PROJECT_ID)
    // The dev-mock project must never clobber a valid restored session.
    expect(capturedAuth?.currentProject?.id).not.toBe('proj_default')
    expect(apiClient.getProjectId()).toBe(REAL_PROJECT_ID)
    expect(sessionStorage.getItem('ap-user')).toContain('dev@ap.com')
    expect(localStorage.getItem('ap-user')).toBeNull()
  })

  it('persists the flat sign-in payload as the user and survives a remount', async () => {
    stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({
          status: 200,
          body: { data: [{ id: REAL_PROJECT_ID, displayName: 'InboxFM Main Project', platformId: REAL_USER.platformId }] },
        }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)

    // Mirrors login.tsx: the response is flat, so the whole object (sans token/projectId)
    // is the user.
    act(() => {
      requireAuth().signIn('real-jwt', REAL_USER, REAL_PROJECT_ID)
    })

    expect(capturedAuth?.user?.id).toBe(REAL_USER.id)
    // User, token + project moved to sessionStorage (issue #383)
    expect(sessionStorage.getItem('ap-user')).toContain('dev@ap.com')
    expect(localStorage.getItem('ap-user')).toBeNull()
    expect(sessionStorage.getItem('ap-token')).toBe('real-jwt')
    expect(sessionStorage.getItem('ap-project-id')).toBe(REAL_PROJECT_ID)
    expect(localStorage.getItem('ap-token')).toBeNull()
  })

  it('signOut clears the persisted identity', async () => {
    apiClient.setToken('real-jwt')
    apiClient.setProjectId(REAL_PROJECT_ID)
    localStorage.setItem('ap-user', JSON.stringify(REAL_USER))

    stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({ status: 200, body: { data: [] } }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)

    act(() => {
      requireAuth().signOut()
    })

    expect(localStorage.getItem('ap-user')).toBeNull()
    expect(sessionStorage.getItem('ap-user')).toBeNull()
    expect(localStorage.getItem('ap-token')).toBeNull()
    expect(sessionStorage.getItem('ap-token')).toBeNull()
    expect(localStorage.getItem('ap-project-id')).toBeNull()
    expect(sessionStorage.getItem('ap-project-id')).toBeNull()
    expect(capturedAuth?.isAuthenticated).toBe(false)
  })

  it('signOut navigates to /login', async () => {
    const mockNavigator = vi.fn()
    setAuthNavigator(mockNavigator)
    apiClient.setToken('real-jwt')
    apiClient.setProjectId(REAL_PROJECT_ID)
    localStorage.setItem('ap-user', JSON.stringify(REAL_USER))

    stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({ status: 200, body: { data: [] } }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)

    act(() => {
      requireAuth().signOut()
    })

    expect(mockNavigator).toHaveBeenCalledWith(
      expect.stringContaining('/login'),
      expect.objectContaining({ replace: true })
    )
    setAuthNavigator(null)
  })

  it('resets AuthProvider state immediately when 401 is handled by apiClient', async () => {
    const mockNavigator = vi.fn()
    setAuthNavigator(mockNavigator)
    apiClient.setToken('real-jwt')
    apiClient.setProjectId(REAL_PROJECT_ID)
    localStorage.setItem('ap-user', JSON.stringify(REAL_USER))

    stubApi([
      {
        match: (url) => url.pathname.endsWith('/api/v1/projects'),
        respond: () => ({ status: 200, body: { data: [{ id: REAL_PROJECT_ID, displayName: 'InboxFM', platformId: REAL_USER.platformId }] } }),
      },
    ])

    renderAuth()
    await waitFor(() => capturedAuth?.isLoading === false)
    expect(capturedAuth?.isAuthenticated).toBe(true)

    act(() => {
      apiClient.handleUnauthorized()
    })

    expect(capturedAuth?.isAuthenticated).toBe(false)
    expect(capturedAuth?.user).toBeNull()
    expect(capturedAuth?.token).toBeNull()
    expect(capturedAuth?.currentProject).toBeNull()
    setAuthNavigator(null)
  })
})
