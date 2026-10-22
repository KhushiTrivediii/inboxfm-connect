import { Activity, CalendarClock, ChevronRight, Copy, Filter, Globe, Zap } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Execution } from '@/lib/api/types'
import { useExecutionsQuery } from '@/lib/query/hooks'
import { executionDisplay, ProvenanceKind } from '@/lib/utils/execution-display'
import {
  ACTIVITY_LIMIT_VALUES,
  ACTIVITY_STATUS_FILTER_VALUES,
  ActivityStatusFilter,
  useActivityFilters,
} from './use-activity-filters'

const PROVENANCE_ICONS: Record<ProvenanceKind, typeof Zap> = {
  trigger: Zap,
  scheduled: CalendarClock,
  manual: Globe,
}

export default function ActivityPage() {
  const navigate = useNavigate()
  const { filters, setFilters } = useActivityFilters()
  const executionsQuery = useExecutionsQuery({
    status: filters.status === 'ALL' ? undefined : filters.status,
    limit: filters.limit,
  })
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const executions = executionsQuery.data?.data ?? []
  const hasActiveFilter = filters.status !== 'ALL'

  async function handleCopyId(execution: Execution) {
    try {
      await navigator.clipboard.writeText(execution.id)
      setCopiedId(execution.id)
      toast.success('Copied execution ID')
      window.setTimeout(() => setCopiedId((current) => (current === execution.id ? null : current)), 1500)
    }
    catch {
      toast.error('Could not copy execution ID')
    }
  }

  function renderContent() {
    if (executionsQuery.isLoading) {
      return (
        <>
          <p className="sr-only" role="status">Loading executions…</p>
          <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        </>
      )
    }

    if (executionsQuery.isError) {
      return (
        <div role="alert" data-testid="activity-error">
          <ErrorState
            title="Unable to load executions"
            description="The execution log could not be reached. Retry shortly."
            onRetry={() => void executionsQuery.refetch()}
          />
        </div>
      )
    }

    if (executions.length === 0 && hasActiveFilter) {
      return (
        <EmptyState
          icon={Filter}
          title="No executions match this filter."
          description={`No recorded executions have status ${filters.status}. Try a different status filter.`}
          actionLabel="Clear filter"
          onAction={() => setFilters({ status: 'ALL' })}
        />
      )
    }

    if (executions.length === 0) {
      return (
        <EmptyState
          icon={Activity}
          title="No executions recorded yet."
          description="Executions appear here when trigger bindings run, scheduled tasks fire, or executions are created through the API."
          actionLabel="Explore Actions to Run"
          onAction={() => navigate('/actions')}
        />
      )
    }

    return (
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-xs" data-testid="execution-table">
        <table className="w-full min-w-[820px] border-collapse text-left text-xs">
          <caption className="sr-only">Executions</caption>
          <thead>
            <tr className="border-b border-border bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">Source</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">Prompt</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">Created</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">Execution ID</th>
              <th scope="col" className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {executions.map((execution) => {
              const provenance = executionDisplay.provenance(execution.metadata)
              const ProvenanceIcon = PROVENANCE_ICONS[provenance]
              return (
                <tr
                  key={execution.id}
                  className="border-b border-border last:border-b-0 transition-colors hover:bg-muted/30"
                  data-testid="execution-row"
                >
                  <td className="whitespace-nowrap px-4 py-3" data-testid="execution-status-badge">
                    <Badge variant={executionDisplay.statusVariant(execution.status)} className="text-[10px]" dot>
                      {executionDisplay.statusLabel(execution.status)}
                    </Badge>
                    <span className="sr-only">{execution.status}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3" data-testid="execution-provenance-badge">
                    <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                      <ProvenanceIcon className="h-3 w-3" aria-hidden="true" />
                      <span>{executionDisplay.provenanceLabel(provenance)}</span>
                    </Badge>
                  </td>
                  <td className="max-w-[320px] px-4 py-3">
                    <Link
                      to={`/activity/${execution.id}`}
                      className="group flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <span
                        className="block truncate font-semibold text-foreground group-hover:text-primary group-focus-visible:text-primary transition-colors"
                        title={execution.prompt}
                      >
                        {execution.prompt}
                      </span>
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    <time dateTime={execution.created} title={executionDisplay.formatAbsoluteTimestamp(execution.created)}>
                      {executionDisplay.formatRelativeTimestamp(execution.created)}
                    </time>
                    <span className="sr-only"> ({executionDisplay.formatAbsoluteTimestamp(execution.created)})</span>
                  </td>
                  <td className="px-4 py-3">
                    <code className="block max-w-[140px] truncate font-mono text-[11px] text-muted-foreground" title={execution.id}>
                      {execution.id}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void handleCopyId(execution)}
                        aria-label={`Copy execution ID ${execution.id}`}
                        className="text-muted-foreground hover:text-foreground"
                        data-testid="copy-execution-id"
                      >
                        {copiedId === execution.id ? (
                          <Copy className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        asChild
                        aria-label={`Inspect execution ${execution.id}`}
                        className="text-muted-foreground hover:text-primary"
                      >
                        <Link to={`/activity/${execution.id}`}>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Recorded executions across triggers, schedules, and the API — newest first."
      />

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="activity-status-filter" className="text-xs font-semibold text-muted-foreground">
            Status
          </label>
          <select
            id="activity-status-filter"
            value={filters.status}
            onChange={(event) => setFilters({ status: event.target.value as ActivityStatusFilter })}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            data-testid="activity-status-filter"
          >
            <option value="ALL">All statuses</option>
            {ACTIVITY_STATUS_FILTER_VALUES.map((status) => (
              <option key={status} value={status}>
                {executionDisplay.statusLabel(status)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="activity-limit-filter" className="text-xs font-semibold text-muted-foreground" title="The executions API returns only the most recent entries up to this limit — older executions are not reachable from this view yet.">
            Show last
          </label>
          <select
            id="activity-limit-filter"
            value={filters.limit}
            onChange={(event) => setFilters({ limit: Number(event.target.value) })}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            data-testid="activity-limit-filter"
          >
            {ACTIVITY_LIMIT_VALUES.map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!executionsQuery.isLoading && !executionsQuery.isError && (
        <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="activity-count">
          {executions.length} execution{executions.length === 1 ? '' : 's'}
        </p>
      )}

      {renderContent()}
    </div>
  )
}
