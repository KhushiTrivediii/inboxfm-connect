import { Lock, Mail } from 'lucide-react'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiClient } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/auth-context'
import { toast } from 'sonner'

export function resolvePostLoginTarget(returnUrlParam?: string | null, stateFrom?: unknown): string {
  let candidate: string | undefined

  if (returnUrlParam && returnUrlParam.startsWith('/') && !returnUrlParam.startsWith('//')) {
    candidate = returnUrlParam
  } else if (typeof stateFrom === 'string' && stateFrom.startsWith('/') && !stateFrom.startsWith('//')) {
    candidate = stateFrom
  } else if (
    stateFrom &&
    typeof stateFrom === 'object' &&
    'pathname' in stateFrom &&
    typeof (stateFrom as { pathname: unknown }).pathname === 'string'
  ) {
    const fromObj = stateFrom as { pathname: string; search?: string; hash?: string }
    if (fromObj.pathname.startsWith('/') && !fromObj.pathname.startsWith('//')) {
      const search = typeof fromObj.search === 'string' ? fromObj.search : ''
      const hash = typeof fromObj.hash === 'string' ? fromObj.hash : ''
      candidate = `${fromObj.pathname}${search}${hash}`
    }
  }

  if (candidate && !candidate.startsWith('/login')) {
    return candidate
  }

  return '/'
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn } = useAuth()

  const navigateAfterLogin = () => {
    const searchParams = new URLSearchParams(location.search)
    const returnUrlParam = searchParams.get('returnUrl')
    const stateFrom = (location.state as { from?: unknown } | null)?.from

    const targetUrl = resolvePostLoginTarget(returnUrlParam, stateFrom)
    navigate(targetUrl, { replace: true })
  }

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      // The sign-in response is FLAT: the user fields, `token` and `projectId` sit
      // at the top level — there is no nested `user`. Verified against the running
      // backend (`authenticationService.signInWithPassword` returns the user row with
      // `token`/`projectId` merged in).
      const res = await apiClient.post<{
        id: string
        email: string
        firstName: string
        lastName: string
        platformRole?: string
        token: string
        projectId: string
      }>('/authentication/sign-in', {
        email,
        password,
      })

      const { token, projectId, ...user } = res
      signIn(token, user, projectId)
      toast.success('Signed in successfully')
      navigateAfterLogin()
    } catch (err) {
      toast.error('Authentication failed', {
        description: err instanceof Error ? err.message : 'Invalid credentials',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleDevSignIn = async () => {
    setIsLoading(true)
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
      const { token, projectId, ...user } = res
      signIn(token, user, projectId)
      toast.success('Signed in as Dev user')
      navigateAfterLogin()
    } catch (err) {
      toast.error('Dev authentication failed', {
        description: err instanceof Error ? err.message : 'Invalid dev credentials',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background/50 p-4">
      <Card className="w-full max-w-sm border-border bg-card shadow-lg">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold mb-3 shadow-md">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="h-6 w-6" fill="none">
              <path d="M10 9H22V13H10V9ZM10 15H18V19H10V15ZM10 21H22V25H10V21Z" fill="currentColor"/>
            </svg>
          </div>
          <CardTitle className="text-xl font-bold tracking-tight">InboxFM Connect</CardTitle>
          <CardDescription className="text-xs text-muted-foreground mt-1">
            Sign in to your developer console
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSubmit} className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Email</label>
              <Input
                type="email"
                icon={<Mail className="h-4 w-4" />}
                placeholder="developer@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Password</label>
              <Input
                type="password"
                icon={<Lock className="h-4 w-4" />}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" loading={isLoading} className="w-full mt-2 font-semibold shadow-xs">
              Sign in
            </Button>
          </form>

          {import.meta.env.DEV && (
            <div className="pt-3 border-t border-border/80">
              <div className="text-center mb-2">
                <span className="text-[11px] text-muted-foreground">Local Development Mode</span>
              </div>
              <Button
                type="button"
                variant="outline"
                loading={isLoading}
                onClick={handleDevSignIn}
                className="w-full text-xs font-medium border-primary/30 text-primary hover:bg-primary/5 hover:border-primary"
              >
                1-Click Sign in as Dev (dev@ap.com)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
