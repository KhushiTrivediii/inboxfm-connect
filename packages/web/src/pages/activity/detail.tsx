import { ArrowLeft, Check, Copy, RefreshCw, Radio, Terminal } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ExecutionEventStream } from '@/components/activity/execution-event-stream'
import { ToolCallTimeline } from '@/components/activity/tool-call-timeline'
import { JsonViewer } from '@/components/actions/json-viewer'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiClientError } from '@/lib/api/client'
import { Execution } from '@/lib/api/types'
import { useExecutionEventStream } from '@/lib/hooks/use-execution-event-stream'
import { useExecutionQuery, useExecutionToolCallsQuery } from '@/lib/query/hooks'
import { executionDisplay } from '@/lib/utils/execution-display'

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true" data-testid="execution-detail-skeleton">
      <div className="space-y-2">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  )
}

function BackToActivity() {
  return (
    <Button variant="outline" size="sm" asChild className="gap-1.5">
      <Link to="/activity">
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>All Activity</span>
      </Link>
    </Button>
  )
}

function FieldCard({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs" data-testid={testId}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 text-xs font-semibold text-foreground">{children}</div>
    </div>
  )
}

export default function ExecutionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const executionQuery = useExecutionQuery(id)
  const toolCallsQuery = useExecutionToolCallsQuery(executionQuery.isSuccess ? id : undefined)
  const eventStream = useExecutionEventStream({ executionId: id, enabled: executionQuery.isSuccess })
  const [copied, setCopied] = useState(false)

  async function handleCopyId() {
    if (!id) {
      return
    }
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      toast.success('Copied execution ID')
      window.setTimeout(() => setCopied(false), 1500)
    }
    catch {
      toast.error('Could not copy execution ID')
    }
  }

  if (executionQuery.isLoading) {
    return <DetailSkeleton />
  }

  if (executionQuery.isError || !executionQuery.data) {
    const error = executionQuery.error
    const status = error instanceof ApiClientError ? error.statusCode : undefined
    const notFound = status === 404
    const forbidden = status === 403 || status === 401
    return (
      <div className="space-y-4" data-testid="execution-detail-error">
        <ErrorState
          title={
            notFound
              ? 'Execution not found'
              : forbidden
                ? 'You do not have access to this execution'
                : 'Unable to load this execution'
          }
          description={
            notFound
              ? `No execution with ID ${id} exists, or it has been removed.`
              : forbidden
                ? 'This execution belongs to a different project. Switch projects to inspect it.'
                : 'The execution record could not be reached. Retry shortly.'
          }
          onRetry={notFound || forbidden ? undefined : () => void executionQuery.refetch()}
        />
        <div className="flex justify-center">
          <BackToActivity />
        </div>
      </div>
    )
  }

  const execution: Execution = executionQuery.data
  const provenance = executionDisplay.provenance(execution.metadata)
  const hasMetadata = Object.keys(execution.metadata ?? {}).length > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Execution"
        description={`Recorded ${executionDisplay.formatRelativeTimestamp(execution.created)} · ${executionDisplay.provenanceLabel(provenance)}`}
        breadcrumbs={[
          { label: 'Activity', href: '/activity' },
          { label: execution.id },
        ]}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCopyId()}
              className="gap-1.5"
              data-testid="copy-execution-id"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              <span>Copy ID</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void executionQuery.refetch()
                void toolCallsQuery.refetch()
              }}
              loading={executionQuery.isFetching}
              className="gap-1.5"
              data-testid="refresh-execution"
            >
              {!executionQuery.isFetching && <RefreshCw className="h-3.5 w-3.5" />}
              <span>Refresh</span>
            </Button>
            <BackToActivity />
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FieldCard label="Status" testId="execution-status">
          <Badge variant={executionDisplay.statusVariant(execution.status)} className="text-[10px]" dot>
            {executionDisplay.statusLabel(execution.status)}
          </Badge>
          <span className="sr-only">{execution.status}</span>
        </FieldCard>
        <FieldCard label="Source" testId="execution-provenance">
          {executionDisplay.provenanceLabel(provenance)}
        </FieldCard>
        <FieldCard label="Created" testId="execution-created">
          <time dateTime={execution.created}>
            {executionDisplay.formatAbsoluteTimestamp(execution.created)}
          </time>
        </FieldCard>
        <FieldCard label="Last updated" testId="execution-updated">
          <time dateTime={execution.updated}>
            {executionDisplay.formatAbsoluteTimestamp(execution.updated)}
          </time>
        </FieldCard>
      </div>

      {/*
        finishTime / tokenUsage / cost are real columns whose only writer is dead code
        (`executionService.updateStatus` has no callers), so they are rendered strictly
        when non-null instead of shown as zeros or "—".
      */}
      {(execution.finishTime != null || execution.tokenUsage != null || execution.cost != null) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="execution-terminal-facts">
          {execution.finishTime != null && (
            <FieldCard label="Finished" testId="execution-finish-time">
              <time dateTime={execution.finishTime}>
                {executionDisplay.formatAbsoluteTimestamp(execution.finishTime)}
              </time>
            </FieldCard>
          )}
          {execution.tokenUsage != null && (
            <FieldCard label="Tokens" testId="execution-token-usage">
              {execution.tokenUsage.totalTokens} total
              <span className="ml-1 font-normal text-muted-foreground">
                ({execution.tokenUsage.promptTokens} prompt / {execution.tokenUsage.completionTokens} completion)
              </span>
            </FieldCard>
          )}
          {execution.cost != null && (
            <FieldCard label="Cost" testId="execution-cost">
              {execution.cost}
            </FieldCard>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold">Prompt</CardTitle>
              <CardDescription className="text-xs">
                The instruction this execution was recorded with.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Rendered as text: the prompt is caller-supplied and never trusted as markup. */}
              <p
                className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-foreground"
                data-testid="execution-prompt"
              >
                {execution.prompt}
              </p>
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold">Identity</CardTitle>
              <CardDescription className="text-xs">
                Tenant and requester identifiers attached to this record.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <dl className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
                <div>
                  <dt className="font-semibold uppercase tracking-wider text-muted-foreground">Execution ID</dt>
                  <dd className="mt-0.5 break-all font-mono text-foreground" data-testid="execution-id">
                    {execution.id}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-wider text-muted-foreground">Project</dt>
                  <dd className="mt-0.5 break-all font-mono text-foreground">{execution.projectId}</dd>
                </div>
                {execution.userId != null && (
                  <div>
                    <dt className="font-semibold uppercase tracking-wider text-muted-foreground">Requested by</dt>
                    <dd className="mt-0.5 break-all font-mono text-foreground">{execution.userId}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold">Metadata</CardTitle>
              <CardDescription className="text-xs">
                Free-form record written by whichever surface created this execution.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {hasMetadata ? (
                <JsonViewer value={execution.metadata} label="Metadata" maxHeightClass="max-h-72" />
              ) : (
                <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                  No metadata was recorded.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-bold">
                <Terminal className="h-4 w-4 text-primary" aria-hidden="true" />
                <span>Tool calls ({toolCallsQuery.data?.length ?? 0})</span>
              </CardTitle>
              <CardDescription className="text-xs">
                Tools invoked under this execution, oldest first.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ToolCallTimeline
                toolCalls={toolCallsQuery.data ?? []}
                isLoading={toolCallsQuery.isLoading}
                isError={toolCallsQuery.isError}
                onRetry={() => void toolCallsQuery.refetch()}
              />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-bold">
                <Radio className="h-4 w-4 text-primary" aria-hidden="true" />
                <span>Event stream</span>
              </CardTitle>
              <CardDescription className="text-xs">
                Live server-sent events for this execution. History replays on connect.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ExecutionEventStream
                events={eventStream.events}
                status={eventStream.status}
                error={eventStream.error}
                onRetry={eventStream.retry}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
