import { navigateToLogin } from '../auth/auth-navigation'

export class ApiClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly message: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

interface RequestOptions extends RequestInit {
  params?: Record<string, unknown>
}

export class ApiClient {
  private baseUrl = '/api/v1'
  private token: string | null = null
  private projectId: string | null = null
  private redirectingFromPath: string | null = null
  private onUnauthorized: (() => void) | null = null

  constructor() {
    // The session token is a 7-day JWT — the account's full credential — so it
    // lives in sessionStorage, not localStorage: a script that can read the
    // origin's storage (XSS, malicious extension, compromised third-party
    // script) can still exfiltrate it during the tab's lifetime, but no longer
    // finds a parked 7-day credential on every visit. httpOnly cookies are the
    // complete fix but require CORS + proxying changes (issue #383).
    if (typeof sessionStorage !== 'undefined') {
      this.token = sessionStorage.getItem('ap-token')
      this.projectId = sessionStorage.getItem('ap-project-id')
      // One-time adopt-and-remove (review #384): a user upgrading from an
      // older build keeps working instead of being silently logged out —
      // their legacy localStorage token moves into the tab-scoped store and
      // the world-readable copy is deleted in the same breath.
      if (this.token === null && typeof localStorage !== 'undefined') {
        const legacyToken = localStorage.getItem('ap-token')
        if (legacyToken) {
          const legacyProjectId = localStorage.getItem('ap-project-id')
          try {
            sessionStorage.setItem('ap-token', legacyToken)
            if (legacyProjectId) {
              sessionStorage.setItem('ap-project-id', legacyProjectId)
              this.projectId = legacyProjectId
            }
            this.token = legacyToken
          } catch {
            // Storage blocked or quota-exhausted: leave the session
            // unauthenticated rather than crash the first load.
          }
          localStorage.removeItem('ap-token')
          localStorage.removeItem('ap-project-id')
        }
      }
    }
    // Purge any remaining legacy keys for users whose session already moved
    // (e.g. a second tab adopted it first): the parked 7-day JWT must not
    // stay world-readable until its natural expiry (review #384).
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('ap-token')
      localStorage.removeItem('ap-project-id')
    }
  }

  setOnUnauthorized(handler: (() => void) | null): void {
    this.onUnauthorized = handler
  }

  resetRedirectState(): void {
    this.redirectingFromPath = null
  }

  handleUnauthorized(): void {
    const currentPath = typeof window !== 'undefined' ? window.location.pathname : ''
    // The guard is keyed on the route that triggered it instead of a timer, so it
    // goes inert by itself once the app navigates away and needs no cleanup. A
    // burst of 401s raised from the page we are still on is absorbed; a 401 from
    // any other route is free to redirect again. (A fixed timer left a window
    // where a later 401, still on the same page, started a second redirect.)
    if (this.redirectingFromPath === currentPath) {
      return
    }

    if (currentPath.startsWith('/login')) {
      return
    }

    this.redirectingFromPath = currentPath
    this.setToken(null)
    this.setProjectId(null)
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('ap-user')
    }

    if (this.onUnauthorized) {
      try {
        this.onUnauthorized()
      } catch {
        // guard against listener errors
      }
    }

    try {
      navigateToLogin()
    } catch (error) {
      // A navigation that throws must not leave the guard latched forever, or the
      // user is stranded on an unauthenticated page with no way back to login.
      this.redirectingFromPath = null
      throw error
    }
  }

  setToken(token: string | null) {
    this.token = token
    // Storage writes can throw (storage blocked, quota exhausted); auth
    // state has already changed in memory, so a throwing write must not
    // fail the sign-in halfway (review #384).
    try {
      if (typeof sessionStorage !== 'undefined') {
        if (token) {
          sessionStorage.setItem('ap-token', token)
        } else {
          sessionStorage.removeItem('ap-token')
          // Clear a token persisted by an older build so stale credentials do
          // not survive an upgrade in the world-readable store.
          localStorage.removeItem('ap-token')
        }
      }
    } catch {
      // in-memory token remains authoritative for this session
    }
  }

  getToken(): string | null {
    return this.token
  }

  setProjectId(projectId: string | null) {
    this.projectId = projectId
    try {
      if (typeof sessionStorage !== 'undefined') {
        if (projectId) {
          sessionStorage.setItem('ap-project-id', projectId)
        } else {
          sessionStorage.removeItem('ap-project-id')
          localStorage.removeItem('ap-project-id')
        }
      }
    } catch {
      // in-memory project id remains authoritative for this session
    }
  }

  getProjectId(): string | null {
    return this.projectId
  }

  private buildUrl(path: string, params?: RequestOptions['params']): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'
    const url = new URL(`${this.baseUrl}${cleanPath}`, baseOrigin)

    if (params) {
      Object.entries(params).forEach(([key, val]) => {
        if (val !== undefined && val !== null) {
          if (Array.isArray(val)) {
            val.forEach((item) => url.searchParams.append(key, String(item)))
          } else {
            url.searchParams.append(key, String(val))
          }
        }
      })
    }

    return url.toString()
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { params, headers: customHeaders, ...restOptions } = options

    const headers = new Headers(customHeaders)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json')

    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`)
    }

    if (this.projectId) {
      headers.set('x-project-id', this.projectId)
    }

    const url = this.buildUrl(path, params)

    const response = await fetch(url, {
      ...restOptions,
      headers,
    })

    if (response.status === 204) {
      return undefined as T
    }

    let responseData: unknown = null
    const contentType = response.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
      try {
        responseData = await response.json()
      } catch {
        responseData = null
      }
    } else {
      responseData = await response.text()
    }

    if (!response.ok) {
      if (response.status === 401 && !path.includes('/authentication/sign-in')) {
        this.handleUnauthorized()
      }
      const errorMessage =
        (responseData as { message?: string })?.message ||
        `Request failed with status ${response.status}`
      throw new ApiClientError(response.status, errorMessage, responseData)
    }

    return responseData as T
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' })
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' })
  }
}

export const apiClient = new ApiClient()
