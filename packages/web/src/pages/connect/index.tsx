import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useParams } from 'react-router-dom'
import { AuthPropertyRenderer } from '@/components/connections/auth-property-renderer'
import { ConnectionFormShell } from '@/components/connections/connection-form-shell'
import { TextField } from '@/components/connections/form-field'
import { Card, CardContent } from '@/components/ui/card'
import { LoadingState } from '@/components/ui/loading-state'
import { apiClient, ApiClientError } from '@/lib/api/client'
import { PieceMetadata } from '@/lib/api/types'

const OAUTH_POPUP_NAME = 'inboxfm-connect-oauth-popup'
const OAUTH_POPUP_FEATURES = 'width=600,height=720,left=100,top=100'
const POPUP_POLL_INTERVAL_MS = 500

interface ConnectSessionInfo {
  projectId: string
  externalUserId: string
  allowedPieceNames: string[] | null
  expiresAt: string
}

interface SecretTextValues {
  displayName: string
  secretText: string
}

interface BasicAuthValues {
  displayName: string
  username: string
  password: string
}

interface CustomAuthValues {
  displayName: string
  props: Record<string, unknown>
}

interface OAuthUrlResponse {
  authorizationUrl: string
  codeVerifier?: string
}

function buildRedirectUrl(): string {
  return `${window.location.origin}/redirect`
}

interface OpenAuthorizationHandlers {
  onCode: (code: string) => void
  onCancelled: () => void
}

function openAuthorizationWindow(authorizationUrl: string, handlers: OpenAuthorizationHandlers): () => void {
  const popup = window.open(authorizationUrl, OAUTH_POPUP_NAME, OAUTH_POPUP_FEATURES)
  if (!popup) {
    handlers.onCancelled()
    return () => undefined
  }

  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    window.clearInterval(pollId)
    window.removeEventListener('message', onMessage)
  }

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return
    if (event.source !== popup) return
    const data = event.data as { code?: unknown } | null
    const code = typeof data?.code === 'string' ? data.code : undefined
    if (!code) return
    settle()
    handlers.onCode(code)
  }

  const pollId = window.setInterval(() => {
    if (!popup.closed) return
    window.clearInterval(pollId)
    window.setTimeout(() => {
      if (settled) return
      settle()
      handlers.onCancelled()
    }, 200)
  }, POPUP_POLL_INTERVAL_MS)

  window.addEventListener('message', onMessage)

  return () => {
    settled = true
    window.clearInterval(pollId)
    window.removeEventListener('message', onMessage)
  }
}

export default function ConnectPage() {
  const { token = '' } = useParams<{ token: string }>()
  const [session, setSession] = useState<ConnectSessionInfo | null>(null)
  const [piece, setPiece] = useState<PieceMetadata | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connectedDisplayName, setConnectedDisplayName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const sessionInfo = await apiClient.get<ConnectSessionInfo>(`/connect-sessions/${encodeURIComponent(token)}`)
        if (cancelled) return
        setSession(sessionInfo)

        const pieceName = sessionInfo.allowedPieceNames?.length === 1 ? sessionInfo.allowedPieceNames[0] : null
        if (!pieceName) {
          setLoadError('This connect link does not specify a single integration to connect. Ask the app that sent you here to generate a link scoped to one integration.')
          return
        }
        const pieceMetadata = await apiClient.get<PieceMetadata>(`/integrations/${encodeURIComponent(pieceName)}`)
        if (cancelled) return
        setPiece(pieceMetadata)
      } catch (err) {
        if (cancelled) return
        setLoadError(
          err instanceof ApiClientError && (err.statusCode === 404 || err.statusCode === 410)
            ? 'This connect link has expired or was already used. Ask the app that sent you here for a new one.'
            : 'This connect link could not be loaded. Try again in a moment.'
        )
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [token])

  if (connectedDisplayName) {
    return (
      <ConnectPageShell>
        <Card className="rounded-xl">
          <CardContent className="p-6 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-foreground">{connectedDisplayName} connected</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
              You can close this window and return to the app you came from.
            </p>
          </CardContent>
        </Card>
      </ConnectPageShell>
    )
  }

  if (loadError) {
    return (
      <ConnectPageShell>
        <Card className="rounded-xl">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-destructive" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-foreground">Unable to continue</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{loadError}</p>
          </CardContent>
        </Card>
      </ConnectPageShell>
    )
  }

  if (!session || !piece) {
    return (
      <ConnectPageShell>
        <LoadingState rows={4} />
      </ConnectPageShell>
    )
  }

  return (
    <ConnectPageShell>
      {piece.auth?.type === 'SECRET_TEXT' && (
        <SecretTextConnectPublic token={token} piece={piece} onConnected={setConnectedDisplayName} />
      )}
      {piece.auth?.type === 'BASIC_AUTH' && (
        <BasicAuthConnectPublic token={token} piece={piece} onConnected={setConnectedDisplayName} />
      )}
      {piece.auth?.type === 'CUSTOM_AUTH' && (
        <CustomAuthConnectPublic token={token} piece={piece} onConnected={setConnectedDisplayName} />
      )}
      {piece.auth?.type === 'OAUTH2' && (
        <PlatformOAuthConnectPublic token={token} piece={piece} onConnected={setConnectedDisplayName} />
      )}
      {!['SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH', 'OAUTH2'].includes(piece.auth?.type ?? '') && (
        <Card className="rounded-xl">
          <CardContent className="p-6 text-center">
            <p className="text-sm font-semibold text-foreground">This integration isn't connectable here yet</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
              {piece.displayName} uses an authentication method this connect page doesn't support yet. Ask the app that sent you here for another way to connect.
            </p>
          </CardContent>
        </Card>
      )}
    </ConnectPageShell>
  )
}

function ConnectPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-xl">{children}</div>
    </div>
  )
}

function describeConnectError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.message || 'The connection could not be created. Try again.'
  }
  return 'The connection could not be created. Try again.'
}

function SecretTextConnectPublic({ token, piece, onConnected }: { token: string, piece: PieceMetadata, onConnected: (displayName: string) => void }) {
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const { control, handleSubmit, formState: { errors } } = useForm<SecretTextValues>({
    defaultValues: { displayName: `${piece.displayName} connection`, secretText: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setPending(true)
    setErrorMessage(undefined)
    try {
      await apiClient.post(`/connect-sessions/${encodeURIComponent(token)}/connections`, {
        type: 'SECRET_TEXT',
        displayName: values.displayName.trim(),
        pieceName: piece.name,
        pieceVersion: piece.version,
        value: { type: 'SECRET_TEXT', secret_text: values.secretText },
      })
      onConnected(values.displayName.trim())
    } catch (err) {
      setErrorMessage(describeConnectError(err))
    } finally {
      setPending(false)
    }
  })

  return (
    <ConnectionFormShell
      pieceDisplayName={piece.displayName}
      pieceLogoUrl={piece.logoUrl}
      title={`Connect ${piece.displayName}`}
      description={piece.auth?.description?.trim() || `Provide the API key or token ${piece.displayName} issued for your account.`}
      submitLabel="Connect"
      pending={pending}
      errorMessage={errorMessage}
      onSubmit={(event) => void onSubmit(event)}
    >
      <Controller
        name="displayName"
        control={control}
        rules={{ required: 'Connection name is required' }}
        render={({ field }) => (
          <TextField id="connect-secret-display-name" label="Connection name" required value={field.value} onChange={field.onChange} disabled={pending} error={errors.displayName?.message} autoComplete="off" />
        )}
      />
      <Controller
        name="secretText"
        control={control}
        rules={{ required: 'Secret is required' }}
        render={({ field }) => (
          <TextField id="connect-secret-value" label="Secret" description={`${piece.displayName} API key or token.`} required type="password" value={field.value} onChange={field.onChange} disabled={pending} error={errors.secretText?.message} autoComplete="new-password" />
        )}
      />
    </ConnectionFormShell>
  )
}

function BasicAuthConnectPublic({ token, piece, onConnected }: { token: string, piece: PieceMetadata, onConnected: (displayName: string) => void }) {
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const { control, handleSubmit, formState: { errors } } = useForm<BasicAuthValues>({
    defaultValues: { displayName: `${piece.displayName} connection`, username: '', password: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setPending(true)
    setErrorMessage(undefined)
    try {
      await apiClient.post(`/connect-sessions/${encodeURIComponent(token)}/connections`, {
        type: 'BASIC_AUTH',
        displayName: values.displayName.trim(),
        pieceName: piece.name,
        pieceVersion: piece.version,
        value: { type: 'BASIC_AUTH', username: values.username.trim(), password: values.password },
      })
      onConnected(values.displayName.trim())
    } catch (err) {
      setErrorMessage(describeConnectError(err))
    } finally {
      setPending(false)
    }
  })

  return (
    <ConnectionFormShell
      pieceDisplayName={piece.displayName}
      pieceLogoUrl={piece.logoUrl}
      title={`Connect ${piece.displayName}`}
      description={piece.auth?.description?.trim() || `Sign in with your ${piece.displayName} username and password.`}
      submitLabel="Connect"
      pending={pending}
      errorMessage={errorMessage}
      onSubmit={(event) => void onSubmit(event)}
    >
      <Controller
        name="displayName"
        control={control}
        rules={{ required: 'Connection name is required' }}
        render={({ field }) => (
          <TextField id="connect-basic-display-name" label="Connection name" required value={field.value} onChange={field.onChange} disabled={pending} error={errors.displayName?.message} autoComplete="off" />
        )}
      />
      <Controller
        name="username"
        control={control}
        rules={{ required: 'Username is required' }}
        render={({ field }) => (
          <TextField id="connect-basic-username" label="Username" required value={field.value} onChange={field.onChange} disabled={pending} error={errors.username?.message} autoComplete="off" />
        )}
      />
      <Controller
        name="password"
        control={control}
        rules={{ required: 'Password is required' }}
        render={({ field }) => (
          <TextField id="connect-basic-password" label="Password" required type="password" value={field.value} onChange={field.onChange} disabled={pending} error={errors.password?.message} autoComplete="new-password" />
        )}
      />
    </ConnectionFormShell>
  )
}

function CustomAuthConnectPublic({ token, piece, onConnected }: { token: string, piece: PieceMetadata, onConnected: (displayName: string) => void }) {
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const propEntries = Object.entries(piece.auth?.props ?? {})
  const { control, handleSubmit, formState: { errors } } = useForm<CustomAuthValues>({
    defaultValues: {
      displayName: `${piece.displayName} connection`,
      props: Object.fromEntries(propEntries.map(([key, prop]) => [key, prop.defaultValue ?? ''])),
    },
  })

  const onSubmit = handleSubmit(async (values) => {
    setPending(true)
    setErrorMessage(undefined)
    try {
      await apiClient.post(`/connect-sessions/${encodeURIComponent(token)}/connections`, {
        type: 'CUSTOM_AUTH',
        displayName: values.displayName.trim(),
        pieceName: piece.name,
        pieceVersion: piece.version,
        value: { type: 'CUSTOM_AUTH', props: values.props },
      })
      onConnected(values.displayName.trim())
    } catch (err) {
      setErrorMessage(describeConnectError(err))
    } finally {
      setPending(false)
    }
  })

  return (
    <ConnectionFormShell
      pieceDisplayName={piece.displayName}
      pieceLogoUrl={piece.logoUrl}
      title={`Connect ${piece.displayName}`}
      description={piece.auth?.description?.trim() || 'Provide the authentication details this integration requires.'}
      submitLabel="Connect"
      pending={pending}
      errorMessage={errorMessage}
      onSubmit={(event) => void onSubmit(event)}
    >
      <Controller
        name="displayName"
        control={control}
        rules={{ required: 'Connection name is required' }}
        render={({ field }) => (
          <TextField id="connect-custom-display-name" label="Connection name" required value={field.value} onChange={field.onChange} disabled={pending} error={errors.displayName?.message} autoComplete="off" />
        )}
      />
      {propEntries.map(([name, prop]) => (
        <Controller
          key={name}
          name={`props.${name}`}
          control={control}
          rules={{ required: prop.required ? `${prop.displayName} is required` : false }}
          render={({ field, fieldState }) => (
            <AuthPropertyRenderer name={name} property={prop} value={field.value ?? ''} onChange={field.onChange} error={fieldState.error?.message} disabled={pending} />
          )}
        />
      ))}
    </ConnectionFormShell>
  )
}

function PlatformOAuthConnectPublic({ token, piece, onConnected }: { token: string, piece: PieceMetadata, onConnected: (displayName: string) => void }) {
  const [phase, setPhase] = useState<'form' | 'authorizing' | 'creating'>('form')
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const cleanupPopupRef = useRef<(() => void) | null>(null)
  const auth = piece.auth
  // Some OAuth pieces declare auth props (e.g. a tenant domain templated into the
  // provider's authUrl). The console flow renders and submits them; the server's
  // connect-session endpoints accept `props` in both the authorization-url and the
  // connection-create bodies, so the public flow must collect them too — otherwise
  // the authorization URL is built from the raw `{key}` template and the flow
  // breaks for exactly those pieces.
  const propEntries = Object.entries(auth?.props ?? {})
  const hasProps = propEntries.length > 0
  const { control, handleSubmit, formState: { errors }, reset } = useForm<{ displayName: string, props: Record<string, unknown> }>({
    defaultValues: {
      displayName: `${piece.displayName} connection`,
      props: Object.fromEntries(propEntries.map(([key, prop]) => [key, prop.defaultValue ?? ''])),
    },
  })

  useEffect(() => () => cleanupPopupRef.current?.(), [])

  const pending = phase !== 'form'

  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(undefined)
    setPhase('authorizing')

    let authorization: OAuthUrlResponse
    try {
      authorization = await apiClient.post<OAuthUrlResponse>(`/connect-sessions/${encodeURIComponent(token)}/oauth2/authorization-url`, {
        pieceName: piece.name,
        pieceVersion: piece.version,
        redirectUrl: buildRedirectUrl(),
        ...(hasProps ? { props: values.props } : {}),
      })
    } catch (err) {
      setPhase('form')
      setErrorMessage(describeConnectError(err))
      return
    }

    await new Promise<void>((resolve) => {
      cleanupPopupRef.current = openAuthorizationWindow(authorization.authorizationUrl, {
        onCode: async (code) => {
          cleanupPopupRef.current = null
          setPhase('creating')
          try {
            await apiClient.post(`/connect-sessions/${encodeURIComponent(token)}/connections`, {
              type: 'PLATFORM_OAUTH2',
              displayName: values.displayName.trim(),
              pieceName: piece.name,
              pieceVersion: piece.version,
              value: {
                type: 'PLATFORM_OAUTH2',
                // Ignored by the server — connect-session.controller.ts re-derives the
                // real client_id from the platform's configured OAuth app. The schema
                // just requires a non-empty placeholder here.
                client_id: 'platform-managed',
                code,
                scope: (auth?.scope ?? []).join(' '),
                redirect_url: buildRedirectUrl(),
                ...(hasProps ? { props: values.props } : {}),
                ...(authorization.codeVerifier ? { code_challenge: authorization.codeVerifier } : {}),
                ...(auth?.authorizationMethod ? { authorization_method: auth.authorizationMethod } : {}),
              },
            })
            reset()
            onConnected(values.displayName.trim())
          } catch (err) {
            setPhase('form')
            setErrorMessage(describeConnectError(err))
          } finally {
            resolve()
          }
        },
        onCancelled: () => {
          cleanupPopupRef.current = null
          setPhase('form')
          setErrorMessage('The authorization window was closed before access was granted. No changes were made.')
          resolve()
        },
      })
    })
  })

  const submitLabel = phase === 'authorizing' ? 'Starting authorization...' : phase === 'creating' ? 'Creating connection...' : `Continue to ${piece.displayName}`

  return (
    <ConnectionFormShell
      pieceDisplayName={piece.displayName}
      pieceLogoUrl={piece.logoUrl}
      title={`Connect ${piece.displayName}`}
      description="A secure window will open where you sign in and grant access. Nothing is shared beyond what you approve."
      submitLabel={submitLabel}
      pending={pending}
      errorMessage={errorMessage}
      onSubmit={(event) => void onSubmit(event)}
    >
      <Controller
        name="displayName"
        control={control}
        rules={{ required: 'Connection name is required' }}
        render={({ field }) => (
          <TextField id="connect-oauth-display-name" label="Connection name" required value={field.value} onChange={field.onChange} disabled={pending} error={errors.displayName?.message} autoComplete="off" />
        )}
      />
      {propEntries.map(([name, prop]) => (
        <Controller
          key={name}
          name={`props.${name}`}
          control={control}
          rules={{ required: prop.required ? `${prop.displayName} is required` : false }}
          render={({ field, fieldState }) => (
            <AuthPropertyRenderer name={name} property={prop} value={field.value ?? ''} onChange={field.onChange} error={fieldState.error?.message} disabled={pending} />
          )}
        />
      ))}
      <div className="rounded-md border border-dashed border-border bg-muted/40 p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span>Permissions requested</span>
        </p>
        {(auth?.scope ?? []).length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {(auth?.scope ?? []).map((scope) => (
              <li key={scope} className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                {scope}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">This integration does not declare specific scopes.</p>
        )}
      </div>
    </ConnectionFormShell>
  )
}
