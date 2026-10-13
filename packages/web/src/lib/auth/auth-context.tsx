import React, { createContext, useContext, useEffect, useState } from 'react'
import { apiClient } from '../api/client'
import { Project, User } from '../api/types'
import { navigateToLogin } from './auth-navigation'

interface AuthContextType {
  user: User | null
  currentProject: Project | null
  projects: Project[]
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  signIn: (token: string, user: User, projectId?: string) => void
  signOut: () => void
  setCurrentProject: (project: Project) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => apiClient.getToken())
  const [user, setUser] = useState<User | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [currentProject, setCurrentProjectState] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)

  const setCurrentProject = (project: Project) => {
    setCurrentProjectState(project)
    apiClient.setProjectId(project.id)
  }

  const signIn = (newToken: string, newUser: User, projectId?: string) => {
    apiClient.setToken(newToken)
    setToken(newToken)
    setUser(newUser)
    persistUser(newUser)
    if (projectId) {
      apiClient.setProjectId(projectId)
      const proj = projects.find((p) => p.id === projectId) || {
        id: projectId,
        displayName: 'Default Project',
        platformId: newUser.platformId ?? 'default',
      }
      setCurrentProjectState(proj)
    }
    // loadSession ran at mount, when this tab still had no token, so the
    // projects list is empty and the placeholder above is all the sidebar's
    // switcher has. Sign-in happens mid-session, so load the list here — the
    // switcher populates and the real project replaces the "Default Project"
    // placeholder without requiring a hard reload. Fallback mirrors the
    // restore path: the signed-in project, else the first project.
    void apiClient
      .get<{ data: Project[] }>('/projects')
      .then(
        (projectsData) => {
          const loaded = projectsData.data ?? []
          setProjects(loaded)
          const target = projectId ?? apiClient.getProjectId()
          const matched = loaded.find((p) => p.id === target) ?? loaded[0]
          if (matched) {
            setCurrentProject(matched)
          }
        },
        () => {
          // The session itself is valid; only the switcher stays empty until
          // the next full reload re-runs loadSession.
        }
      )
  }

  const resetAuthState = () => {
    apiClient.setToken(null)
    apiClient.setProjectId(null)
    clearPersistedUser()
    setToken(null)
    setUser(null)
    setProjects([])
    setCurrentProjectState(null)
  }

  const signOut = () => {
    resetAuthState()
    navigateToLogin()
  }

  useEffect(() => {
    const handleUnauthorized = () => {
      resetAuthState()
    }

    apiClient.setOnUnauthorized(handleUnauthorized)
    return () => {
      apiClient.setOnUnauthorized(null)
    }
  }, [])

  useEffect(() => {
    async function loadSession() {
      const storedToken = apiClient.getToken()
      if (!storedToken) {
        // In browser dev mode, automatically sign into the seeded dev account
        // so the developer console is immediately usable without manual sign-in
        if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
          try {
            const res = await apiClient.post<{
              id: string
              email: string
              firstName: string
              lastName: string
              platformRole?: string
              token: string
              projectId: string
            }>('/authentication/sign-in', {
              email: 'dev@ap.com',
              password: '12345678',
            })
            const { token: devToken, projectId: devProjectId, ...devUser } = res
            // signIn loads the projects list and resolves the real project
            // (the dev-mock id may not match a seeded row), so the explicit
            // fetch that used to live here would only duplicate the request.
            signIn(devToken, devUser, devProjectId)
            setIsLoading(false)
            return
          } catch {
            // Auto-login failed, fall through to unauthenticated state
          }
        }

        setUser(null)
        setProjects([])
        setCurrentProjectState(null)
        setIsLoading(false)
        return
      }

      try {
        const persistedUser = readPersistedUser()
        if (persistedUser) {
          setUser(persistedUser)
        }

        const projectsData = await apiClient.get<{ data: Project[] }>('/projects')
        const loadedProjects = projectsData.data || []
        setProjects(loadedProjects)

        const storedProjectId = apiClient.getProjectId()
        const matched = loadedProjects.find((p) => p.id === storedProjectId) || loadedProjects[0]
        if (matched) {
          setCurrentProject(matched)
        }

        if (!persistedUser) {
          setUser({
            id: 'session',
            email: '',
            firstName: '',
            lastName: '',
          })
        }
      } catch (err) {
        console.warn('Session load failed, clearing session', err)
        signOut()
      } finally {
        setIsLoading(false)
      }
    }

    void loadSession()
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        currentProject,
        projects,
        token,
        isAuthenticated: Boolean(user && token),
        isLoading,
        signIn,
        signOut,
        setCurrentProject,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useOptionalAuth(): AuthContextType | undefined {
  return useContext(AuthContext)
}

export function useAuth(): AuthContextType {
  const context = useOptionalAuth()
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

const PERSISTED_USER_KEY = 'ap-user'

// The user object carries PII (email, firstName, lastName, platformId) and was
// previously written to localStorage — world-readable on the same origin. It is
// now stored in sessionStorage so the parked data is bound to the tab's lifetime
// instead of persisting across sessions (issue #383, same fix as the JWT token).
function persistUser(user: User): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(PERSISTED_USER_KEY, JSON.stringify(user))
    }
    // A fresh persist makes any legacy copy stale by definition. The
    // adopt-and-remove in readPersistedUser never sees it when the visit
    // preceding this sign-in carried no token (no restore, no adoption),
    // so the world-readable localStorage entry must go here too.
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(PERSISTED_USER_KEY)
    }
  } catch {
    // Storage blocked or quota-exhausted: user stays in memory for this tab.
  }
}

function readPersistedUser(): User | null {
  if (typeof sessionStorage === 'undefined') return null
  // One-time adopt-and-remove: a user upgrading from an older build keeps their
  // warm-start rendering (no flash of empty name) while the world-readable copy
  // in localStorage is purged in the same breath.
  let raw = sessionStorage.getItem(PERSISTED_USER_KEY)
  if (raw === null && typeof localStorage !== 'undefined') {
    const legacy = localStorage.getItem(PERSISTED_USER_KEY)
    if (legacy !== null) {
      try {
        sessionStorage.setItem(PERSISTED_USER_KEY, legacy)
        raw = legacy
      } catch {
        // Migration blocked — leave unauthenticated rather than crash.
      }
      localStorage.removeItem(PERSISTED_USER_KEY)
    }
  }
  if (!raw) return null
  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

function clearPersistedUser(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(PERSISTED_USER_KEY)
    }
  } catch {
    // Ignore storage errors on sign-out.
  }
  // Purge any stale copy left in localStorage (e.g. a second tab that hasn't
  // adopted yet, or an older build that still wrote there).
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(PERSISTED_USER_KEY)
  }
}
