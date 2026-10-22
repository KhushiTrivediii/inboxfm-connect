import { ChevronRight, Plus, Radio, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/layout/page-header'
import { AuthBadge } from '@/components/integrations/auth-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { PieceSummary } from '@/lib/api/types'
import { useIntegrations, useIntegration } from '@/lib/query/hooks'
import { cn } from '@/lib/utils/cn'

const TRIGGER_TYPE_LABELS: Record<string, string> = {
  POLLING: 'Polling',
  WEBHOOK: 'Webhook',
}

function IntegrationListItem({
  piece,
  active,
  onSelect,
}: {
  piece: PieceSummary
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'border-primary/50 bg-primary/5'
          : 'border-border bg-card hover:border-primary/30 hover:bg-muted/40'
      )}
    >
      <img
        src={piece.logoUrl || '/favicon.svg'}
        alt=""
        aria-hidden="true"
        className="h-6 w-6 rounded border border-border object-contain p-0.5"
        onError={(event) => {
          (event.target as HTMLImageElement).src = '/favicon.svg'
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground">{piece.displayName}</span>
        <span className="block text-[10px] text-muted-foreground">{piece.triggers} triggers</span>
      </span>
      <ChevronRight className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
    </button>
  )
}

function SelectedIntegrationTriggers({ pieceName }: { pieceName: string }) {
  const { data: piece, isLoading, isError, error, refetch } = useIntegration(pieceName)
  const triggers = useMemo(() => Object.values(piece?.triggers ?? {}), [piece])

  if (isLoading) {
    return (
      <div className="space-y-2" aria-label="Loading triggers">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-[76px] w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (isError || !piece) {
    return (
      <EmptyState
        icon={Radio}
        title="Could not load triggers"
        description={
          error instanceof Error && error.message
            ? `${error.message} Retry in a moment.`
            : 'The trigger metadata for this integration could not be loaded.'
        }
      />
    )
  }

  if (triggers.length === 0) {
    return (
      <EmptyState
        icon={Radio}
        title={`${piece.displayName} exposes no triggers`}
        description="Pick another integration from the list."
        actionLabel="Refresh"
        onAction={() => void refetch()}
      />
    )
  }

  return (
    <ul className="space-y-2" data-testid="trigger-discovery-list">
      {triggers.map((trigger) => (
        <li
          key={trigger.name}
          className="rounded-xl border border-border bg-card p-4 shadow-xs transition-colors hover:border-primary/40"
          data-testid="trigger-discovery-item"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xs font-bold text-foreground">{trigger.displayName}</h3>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {trigger.name}
                </code>
                <Badge variant="outline" className="text-[10px]">
                  {TRIGGER_TYPE_LABELS[trigger.type] ?? trigger.type}
                </Badge>
              </div>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                {trigger.description || 'No description provided.'}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <AuthBadge authType={piece.auth?.type} />
                <span className="text-[10px] text-muted-foreground">{piece.displayName}</span>
              </div>
            </div>
            <Button size="xs" variant="outline" asChild className="gap-1 shrink-0">
              <Link
                to={`/automations/triggers/new?pieceName=${encodeURIComponent(piece.name)}&triggerName=${encodeURIComponent(trigger.name)}`}
                data-testid={`create-binding-${trigger.name}`}
              >
                <Plus className="h-3 w-3" />
                <span>Create Binding</span>
              </Link>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function TriggersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const { data: integrations, isLoading, isError, refetch } = useIntegrations()

  const piecesWithTriggers = useMemo(
    () =>
      (integrations?.data ?? [])
        .filter((piece) => (piece.triggers ?? 0) > 0)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [integrations]
  )

  const filteredPieces = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') {
      return piecesWithTriggers
    }
    return piecesWithTriggers.filter(
      (piece) =>
        piece.displayName.toLowerCase().includes(needle) || piece.name.toLowerCase().includes(needle)
    )
  }, [piecesWithTriggers, search])

  const requestedPiece = searchParams.get('pieceName')
  const selectedPieceName =
    requestedPiece && filteredPieces.some((piece) => piece.name === requestedPiece)
      ? requestedPiece
      : filteredPieces[0]?.name

  useEffect(() => {
    if (!requestedPiece && selectedPieceName) {
      setSearchParams((params) => {
        params.set('pieceName', selectedPieceName)
        return params
      }, { replace: true })
    }
  }, [requestedPiece, selectedPieceName, setSearchParams])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trigger Discovery"
        description="Every event source available across the catalog. Pick a trigger to bind it to an executable instruction — no canvas required."
        breadcrumbs={[{ label: 'Automations', href: '/automations/triggers' }]}
      />

      <div className="max-w-md">
        <Input
          icon={<Search className="h-4 w-4" />}
          placeholder="Search integrations..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search integrations"
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={Radio}
          title="Unable to load the integration catalog"
          description="Check your connection and try again."
          actionLabel="Retry"
          onAction={() => void refetch()}
        />
      ) : filteredPieces.length === 0 ? (
        <EmptyState
          icon={Radio}
          title={search ? 'No integrations match your search' : 'No triggers available'}
          description={
            search
              ? 'Try a different search term.'
              : 'Sync your piece catalog to browse event triggers.'
          }
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[280px_1fr]">
          <nav aria-label="Integrations with triggers" className="space-y-1.5 lg:max-h-[560px] lg:overflow-y-auto lg:pr-1" data-testid="trigger-integration-list">
            {filteredPieces.map((piece) => (
              <IntegrationListItem
                key={piece.name}
                piece={piece}
                active={piece.name === selectedPieceName}
                onSelect={() => {
                  setSearchParams((params) => {
                    params.set('pieceName', piece.name)
                    return params
                  })
                }}
              />
            ))}
          </nav>
          <Card className="border-border bg-transparent p-0 shadow-none">
            {selectedPieceName ? (
              <SelectedIntegrationTriggers pieceName={selectedPieceName} key={selectedPieceName} />
            ) : (
              <EmptyState
                icon={Radio}
                title="Select an integration"
                description="Choose an integration on the left to browse its event triggers."
              />
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
