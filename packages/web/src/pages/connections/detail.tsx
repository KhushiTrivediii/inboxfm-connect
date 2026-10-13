import { Activity, ArrowLeft, KeyRound, PencilLine, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ConnectionStatusBadge } from '@/components/connections/connection-status-badge'
import { DeleteConnectionDialog } from '@/components/connections/delete-connection-dialog'
import { PieceLogo } from '@/components/connections/piece-logo'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiClientError } from '@/lib/api/client'
import { TestConnectionResult } from '@/lib/api/types'
import { useConnection, useDeleteConnection, useIntegration, useTestConnection } from '@/lib/query/hooks'
import { connectionLinks } from '@/lib/utils/connection-links'
import { connectionFormat } from '@/lib/utils/connection-format'

function formatDate(value?: string): string {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

interface DetailRowProps {
  label: string
  children: React.ReactNode
}

function DetailRow({ label, children }: DetailRowProps) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xs font-medium text-foreground sm:text-right">{children}</dd>
    </div>
  )
}

export default function ConnectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: connection, isLoading, isError, error, refetch } = useConnection(id)
  const { data: piece } = useIntegration(connection?.pieceName)
  const deleteConnection = useDeleteConnection()
  const testConnection = useTestConnection()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  // Navigating from one connection's detail straight to another reuses this
  // component instance (same route, different :id), so the previous
  // connection's verdict, timestamp and failure message would otherwise stay
  // on screen next to the new connection. Drop it whenever the id changes.
  useEffect(() => {
    setTestResult(null)
  }, [id])

  function handleTest() {
    if (!id) return
    testConnection.mutate(
      { id },
      {
        onSuccess: (result) => {
          setTestResult(result)
          if (result.ok) {
            toast.success('Connection is healthy')
          } else {
            toast.error('Connection test failed', {
              description: result.message ?? 'The connection could not be refreshed.',
            })
          }
        },
        onError: (testError) => {
          toast.error('Connection test failed', {
            description:
              testError instanceof Error
                ? testError.message
                : 'The connection could not be tested. Try again.',
          })
        },
      },
    )
  }

  if (!id || isLoading) {
    return (
      <div className="space-y-6" aria-hidden="true" data-testid="connection-detail-skeleton">
        <Skeleton className="h-3 w-40" />
        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
        </div>
        <Card className="rounded-xl p-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="mb-3 h-4 w-full max-w-sm" />
          ))}
        </Card>
      </div>
    )
  }

  if (isError || !connection) {
    const notFound = error instanceof ApiClientError && error.statusCode === 404
    return (
      <div className="space-y-4">
        <ErrorState
          title={notFound ? 'Connection not found' : 'Unable to load connection.'}
          description={
            notFound
              ? 'This connection may have been deleted or belongs to another project.'
              : 'The connection details could not be loaded. Check your connection and try again.'
          }
          onRetry={() => void refetch()}
        />
        <div className="flex justify-center">
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <Link to="/connections">
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to Connections</span>
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  const pieceDisplayName = piece?.displayName ?? connection.pieceName
  // The in-flight result (if any) is fresher than what the GET returned, so it
  // wins; otherwise fall back to the persisted verdict so last-tested info
  // survives reloads and navigation.
  const lastTestedAt = testResult?.testedAt ?? connection.testedAt ?? null
  const lastTestFailed = testResult
    ? !testResult.ok
    : connection.testedStatus === 'ERROR'
  const lastTestMessage = testResult?.message ?? connection.testedMessage ?? null

  return (
    <div className="space-y-6">
      <PageHeader
        title={connection.displayName}
        description={`Connected account for ${pieceDisplayName}.`}
        breadcrumbs={[
          { label: 'Connections', href: '/connections' },
          { label: connection.displayName },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild className="gap-1.5">
              <Link
                to={connectionLinks.reconnect({
                  pieceName: connection.pieceName,
                  externalId: connection.externalId,
                  displayName: connection.displayName,
                })}
              >
                <PencilLine className="h-3.5 w-3.5" />
                <span>Reconnect</span>
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleTest}
              disabled={testConnection.isPending}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>{testConnection.isPending ? 'Testing…' : 'Test'}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete</span>
            </Button>
          </div>
        }
      />

      <Card className="rounded-xl shadow-xs">
        <CardContent className="p-5">
          <div className="mb-5 flex items-center gap-3 border-b border-border pb-4">
            <PieceLogo
              logoUrl={piece?.logoUrl}
              pieceDisplayName={pieceDisplayName}
              className="h-11 w-11"
            />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">{connection.displayName}</h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <KeyRound className="h-3 w-3 text-primary" aria-hidden="true" />
                <span>{pieceDisplayName}</span>
              </p>
            </div>
          </div>

          <dl className="space-y-3.5">
            <DetailRow label="Connection">{connection.displayName}</DetailRow>
            <DetailRow label="Integration">{pieceDisplayName}</DetailRow>
            <DetailRow label="Authentication">
              {connectionFormat.connectionTypeLabel(connection.type)}
            </DetailRow>
            <DetailRow label="Status">
              <ConnectionStatusBadge status={testResult?.status ?? connection.status} />
            </DetailRow>
            <DetailRow label="Last tested">
              {lastTestedAt ? formatDate(lastTestedAt) : '—'}
            </DetailRow>
            {lastTestFailed && (
              <DetailRow label="Test result">
                <span className="text-destructive">{lastTestMessage ?? 'The connection failed its last health check.'}</span>
              </DetailRow>
            )}
            <DetailRow label="Created">{formatDate(connection.created)}</DetailRow>
            <DetailRow label="Updated">{formatDate(connection.updated)}</DetailRow>
            {connection.externalId && (
              <DetailRow label="External ID">
                <span className="font-mono text-[11px] break-all">{connection.externalId}</span>
              </DetailRow>
            )}
          </dl>

          <p className="mt-5 rounded-md border border-dashed border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
            Credential values are stored encrypted and are never displayed after creation.
          </p>
        </CardContent>
      </Card>

      <DeleteConnectionDialog
        open={deleteOpen}
        connectionName={connection.displayName}
        deleting={deleteConnection.isPending}
        onClose={() => setDeleteOpen(false)}
        onDelete={() => {
          if (!connection) return
          deleteConnection.mutate(
            { id: connection.id },
            {
              onSuccess: () => {
                setDeleteOpen(false)
                navigate('/connections')
              },
              onError: (deleteError) => {
                setDeleteOpen(false)
                toast.error('Failed to delete connection', {
                  description:
                    deleteError instanceof Error
                      ? deleteError.message
                      : 'The connection could not be deleted. Try again.',
                })
              },
            }
          )
        }}
      />
    </div>
  )
}
