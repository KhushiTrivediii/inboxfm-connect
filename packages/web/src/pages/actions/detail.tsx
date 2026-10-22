import { ArrowLeft, Play, RotateCcw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { CodeSnippets } from '@/components/actions/code-snippets'
import { ConnectionPicker } from '@/components/actions/connection-picker'
import {
  ExecutionPanel,
  LocalExecutionRecord,
} from '@/components/actions/execution-panel'
import { PropertyField } from '@/components/actions/property-field'
import { RequestPreview } from '@/components/actions/request-preview'
import { PieceLogo } from '@/components/connections/piece-logo'
import { PageHeader } from '@/components/layout/page-header'
import { AuthBadge, requiresConnection } from '@/components/integrations/auth-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { apiClient, ApiClientError } from '@/lib/api/client'
import { ExecuteRequest, PieceProperty } from '@/lib/api/types'
import {
  ActionFormValues,
  initialValuesFromProps,
  serializeValues,
  validateActionValues,
} from '@/lib/utils/action-form'
import { sanitizeExecuteRequest } from '@/lib/utils/code-generation'
import { executionErrors } from '@/lib/utils/execution-errors'
import { useConnectionsQuery, useExecuteTool, useIntegration } from '@/lib/query/hooks'

function ActionDetailSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true" data-testid="action-detail-skeleton">
      <div className="space-y-2">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-border bg-card p-5">
          <Skeleton className="h-9 w-full" />
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-4 rounded-xl border border-border bg-card p-5">
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  )
}

export default function ActionDetailPage() {
  const { pieceName, actionName } = useParams<{ pieceName: string; actionName: string }>()
  const decodedPieceName = decodeURIComponent(pieceName ?? '')
  const decodedActionName = decodeURIComponent(actionName ?? '')

  const {
    data: piece,
    isLoading,
    isError,
    error,
    refetch: refetchPiece,
  } = useIntegration(decodedPieceName || undefined)
  const connectionsQuery = useConnectionsQuery(decodedPieceName ? { pieceName: decodedPieceName } : undefined)
  const connections = connectionsQuery.data?.data ?? []
  const executeMutation = useExecuteTool()

  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined)
  const [record, setRecord] = useState<LocalExecutionRecord | null>(null)

  const { watch, setValue, reset } = useForm<ActionFormValues>({ defaultValues: {} })
  const values = watch()

  const action = piece?.actions?.[decodedActionName]
  const actionProps = useMemo(() => action?.props ?? {}, [action])
  const loadedActionKey = `${decodedPieceName}@${decodedActionName}`
  const lastResetKeyRef = useRef('')

  useEffect(() => {
    if (!piece || !action) {
      return
    }
    if (lastResetKeyRef.current === loadedActionKey) {
      return
    }
    lastResetKeyRef.current = loadedActionKey
    reset(initialValuesFromProps(action.props))
    setFieldErrors({})
    setRecord(null)
    setSelectedConnectionId('')
  }, [piece, action, loadedActionKey, reset])

  useEffect(() => {
    if (selectedConnectionId || connections.length === 0) {
      return
    }
    // Only auto-select from the set ConnectionPicker itself allows — it renders
    // ERROR connections as disabled "reconnect before use" options — preferring
    // an ACTIVE one. When every connection is errored, leave the choice empty so
    // the user is routed to reconnect instead of silently running against a
    // broken credential.
    const selectable = connections.filter((connection) => connection.status !== 'ERROR')
    const preferred =
      selectable.find((connection) => connection.status === 'ACTIVE') ?? selectable[0]
    if (preferred) {
      setSelectedConnectionId(preferred.id)
    }
  }, [connections, selectedConnectionId])

  const valuesRef = useRef<ActionFormValues>(values)
  valuesRef.current = values
  const actionPropsRef = useRef<Record<string, PieceProperty>>(actionProps)
  actionPropsRef.current = actionProps
  const getInput = useCallback(
    () => serializeValues(actionPropsRef.current, valuesRef.current),
    []
  )

  if (isLoading) {
    return <ActionDetailSkeleton />
  }

  if (isError || !piece) {
    const notFound = error instanceof ApiClientError && error.statusCode === 404
    return (
      <div className="space-y-4">
        <ErrorState
          title={notFound ? 'Integration not found' : 'Unable to load integration'}
          description={
            notFound
              ? `No integration named "${decodedPieceName}" exists in the catalog.`
              : 'The integration metadata could not be loaded. Check your connection and try again.'
          }
          onRetry={() => void refetchPiece()}
        />
        <div className="flex justify-center">
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <Link to="/actions">
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>All Actions</span>
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  if (!action) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Action not found"
          description={`"${decodedActionName}" is not an action of ${piece.displayName}. Browse its catalog to find available actions.`}
        />
        <div className="flex justify-center">
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <Link to={`/integrations/${encodeURIComponent(piece.name)}?tab=actions`}>
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>{piece.displayName} Actions</span>
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  const actionRequiresAuth = action.requireAuth ?? requiresConnection(piece.auth?.type)

  const buildRequest = (): ExecuteRequest | null => {
    const nextErrors = validateActionValues(actionProps, values)
    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return null
    }
    if (!selectedConnectionId) {
      setConnectionError('Select a connection before executing.')
      return null
    }
    setConnectionError(undefined)
    return {
      integration: piece.name,
      tool: action.name,
      connectionId: selectedConnectionId,
      input: serializeValues(actionProps, values),
    }
  }

  const runExecution = async () => {
    const request = buildRequest()
    if (!request) {
      return
    }
    const startedAt = performance.now()
    setRecord({
      status: 'pending',
      request,
      durationMs: null,
    })
    try {
      // A resolved promise means the execution layer ran the tool. The body is the
      // raw action output; it carries no framework-level success flag to inspect.
      const output = await executeMutation.mutateAsync(request)
      const durationMs = Math.round(performance.now() - startedAt)
      setRecord({
        status: 'success',
        request,
        output,
        hasOutput: true,
        durationMs,
      })
      toast.success(`Executed ${action.displayName} (${durationMs} ms)`)
    } catch (executionError) {
      const durationMs = Math.round(performance.now() - startedAt)
      setRecord({
        status: 'failed',
        request,
        durationMs,
        transportError: executionErrors.describe(
          executionError,
          'The tool could not be executed. Try again shortly.'
        ),
      })
    }
  }

  const previewRequest = sanitizeExecuteRequest(actionProps, {
    projectId: apiClient.getProjectId() ?? '$PROJECT_ID',
    integration: piece.name,
    tool: action.name,
    connectionId: selectedConnectionId || '$CONNECTION_ID',
    input: serializeValues(actionProps, values),
  })

  const hasVisibleInputs = Object.keys(actionProps).length > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${piece.displayName} / ${decodedActionName}`}
        description={action.description || `Run ${action.displayName} against the live API.`}
        breadcrumbs={[
          { label: 'Actions', href: '/actions' },
          { label: piece.displayName, href: `/integrations/${encodeURIComponent(piece.name)}?tab=actions` },
          { label: action.displayName },
        ]}
      />

      <Card className="border-border shadow-xs">
        <CardContent className="flex flex-wrap items-center gap-3 p-4 pt-5">
          <PieceLogo logoUrl={piece.logoUrl} pieceDisplayName={piece.displayName} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-foreground">{action.displayName}</h2>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {action.name}
              </code>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {action.description || 'No description provided.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {actionRequiresAuth ? (
              <AuthBadge authType={piece.auth?.type} />
            ) : (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <ShieldCheck className="h-3 w-3" />
                No auth required
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void runExecution()
          }}
          className="space-y-5 rounded-xl border border-border bg-card p-5 shadow-xs"
          aria-label={`${action.displayName} configuration`}
          noValidate
        >
          <ConnectionPicker
            pieceName={piece.name}
            pieceDisplayName={piece.displayName}
            connections={connections}
            isLoading={connectionsQuery.isLoading}
            selectedId={selectedConnectionId}
            onSelect={(id) => {
              setSelectedConnectionId(id)
              setConnectionError(undefined)
            }}
            disabled={executeMutation.isPending}
            error={connectionError}
          />
          {!actionRequiresAuth && connections.length > 0 && (
            <p className="-mt-2 text-[11px] leading-relaxed text-muted-foreground">
              This action does not use authentication, but executions are routed through the
              selected account.
            </p>
          )}

          {hasVisibleInputs && (
            <div className="space-y-4 border-t border-border pt-4">
              {Object.entries(actionProps).map(([propName, property]) => (
                <PropertyField
                  key={propName}
                  pieceName={piece.name}
                  pieceVersion={piece.version}
                  actionOrTriggerName={action.name}
                  name={propName}
                  property={property}
                  value={values[propName]}
                  onChange={(nextValue) =>
                    setValue(propName, nextValue, { shouldDirty: true })
                  }
                  getInput={getInput}
                  error={fieldErrors[propName]}
                  disabled={executeMutation.isPending || (actionRequiresAuth && !selectedConnectionId)}
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button
              type="submit"
              size="sm"
              loading={executeMutation.isPending}
              disabled={!selectedConnectionId}
              className="gap-1.5 font-semibold"
            >
              {!executeMutation.isPending && <Play className="h-3.5 w-3.5" />}
              <span>Execute Tool</span>
            </Button>
            {record && record.status !== 'pending' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void runExecution()}
                disabled={executeMutation.isPending}
                className="gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Run Again</span>
              </Button>
            )}
          </div>
          {Object.keys(fieldErrors).length > 0 && (
            <p role="alert" className="text-xs font-medium text-destructive">
              Fix the highlighted fields before executing.
            </p>
          )}
        </form>

        <div className="space-y-6">
          <section
            className="rounded-xl border border-border bg-card p-5 shadow-xs"
            aria-label="Execution result"
          >
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Execution Result
            </h3>
            <ExecutionPanel record={record} />
          </section>

          <RequestPreview request={previewRequest} />

          <section
            className="rounded-xl border border-border bg-card p-5 shadow-xs"
            aria-label="Code snippets"
          >
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Take the code with you
            </h3>
            <CodeSnippets request={previewRequest} />
          </section>
        </div>
      </div>
    </div>
  )
}
