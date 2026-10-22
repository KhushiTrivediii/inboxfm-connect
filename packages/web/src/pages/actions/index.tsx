import { Boxes, Search, X } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AuthBadge } from '@/components/integrations/auth-badge'
import { ALL_CATEGORIES, CategoryFilter } from '@/components/integrations/category-filter'
import { PieceLogo } from '@/components/connections/piece-logo'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { KnowledgeSearchResultItem, PieceSummary } from '@/lib/api/types'
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value'
import { useIntegrationCategories, useIntegrations, useKnowledgeSearch } from '@/lib/query/hooks'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MIN_LENGTH = 2
const SEARCH_LIMIT = 50

function useUrlState() {
  const [searchParams, setSearchParams] = useSearchParams()

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    setSearchParams(next, { replace: true })
  }

  return {
    query: searchParams.get('q') ?? '',
    integration: searchParams.get('integration') ?? '',
    category: searchParams.get('category') ?? '',
    connectionRequired: searchParams.get('connection') === 'required',
    setQuery: (value: string) => update({ q: value || null }),
    setIntegration: (value: string) => update({ integration: value || null }),
    setCategory: (value: string) => update({ category: value === ALL_CATEGORIES ? null : value }),
    setConnectionRequired: (value: boolean) =>
      update({ connection: value ? 'required' : null }),
  }
}

function matchesSummaryFilters(
  item: {
    pieceName: string
    requiresConnection: boolean
    categories: string[]
  },
  filters: { integration: string; category: string; connectionRequired: boolean }
): boolean {
  if (filters.integration && item.pieceName !== filters.integration) {
    return false
  }
  if (filters.category && !item.categories.includes(filters.category)) {
    return false
  }
  if (filters.connectionRequired && !item.requiresConnection) {
    return false
  }
  return true
}

function SearchResults({
  results,
  summariesByName,
}: {
  results: KnowledgeSearchResultItem[]
  summariesByName: Map<string, PieceSummary>
}) {
  return (
    <div className="space-y-2" data-testid="action-search-results">
      <p className="text-xs text-muted-foreground">
        {results.length} action{results.length === 1 ? '' : 's'} matching your search
      </p>
      {results.map((result) => {
        const summary = summariesByName.get(result.pieceName)
        const href = `/actions/${encodeURIComponent(result.pieceName)}/${encodeURIComponent(result.objectName)}`
        return (
          <Link
            key={`${result.pieceName}/${result.objectName}`}
            to={href}
            className="group flex items-start gap-3 rounded-lg border border-border bg-card p-3.5 shadow-xs transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <PieceLogo logoUrl={summary?.logoUrl} pieceDisplayName={summary?.displayName ?? result.pieceName} className="h-8 w-8" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-xs font-semibold text-muted-foreground">
                  {summary?.displayName ?? result.pieceName}
                </span>
                <span className="text-xs text-muted-foreground/60">/</span>
                <code className="font-mono text-[11px] text-muted-foreground">
                  {result.objectName}
                </code>
              </div>
              <p className="mt-0.5 text-sm font-medium text-foreground">{result.displayName}</p>
              {result.oneLineDescription && (
                <p className="mt-0.5 line-clamp-1 text-xs leading-relaxed text-muted-foreground">
                  {result.oneLineDescription}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
              {result.requiresConnection ? (
                <AuthBadge compact authType={summary?.auth?.type} />
              ) : (
                <Badge variant="outline" className="text-[10px] font-medium text-muted-foreground">
                  No auth
                </Badge>
              )}
            </div>
          </Link>
        )
      })}
    </div>
  )
}

function IntegrationBrowseCard({ piece }: { piece: PieceSummary }) {
  return (
    <Link
      to={`/integrations/${encodeURIComponent(piece.name)}?tab=actions`}
      className="group block rounded-xl border border-border bg-card p-4 shadow-xs transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      data-testid="action-browse-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <PieceLogo logoUrl={piece.logoUrl} pieceDisplayName={piece.displayName} className="h-8 w-8" />
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-foreground">{piece.displayName}</h4>
            <code className="block truncate font-mono text-[10px] text-muted-foreground">
              {piece.name}
            </code>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {piece.actions} actions
        </Badge>
      </div>
      <p className="mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed text-muted-foreground">
        {piece.description || 'No description provided.'}
      </p>
      <div className="mt-3 flex items-center justify-between">
        <AuthBadge compact authType={piece.auth?.type} />
        <span className="text-[11px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
          Browse actions →
        </span>
      </div>
    </Link>
  )
}

export default function ActionsPage() {
  const urlState = useUrlState()
  const debouncedQuery = useDebouncedValue(urlState.query.trim(), SEARCH_DEBOUNCE_MS)
  const isSearchMode = debouncedQuery.length >= SEARCH_MIN_LENGTH

  const integrationsQuery = useIntegrations({ sortBy: 'NAME', orderBy: 'ASC' })
  const categoriesQuery = useIntegrationCategories()
  const knowledgeQuery = useKnowledgeSearch(
    { query: debouncedQuery, limit: SEARCH_LIMIT, objectKind: 'action' },
    isSearchMode
  )

  const pieces = useMemo(() => integrationsQuery.data?.data ?? [], [integrationsQuery.data])
  const summariesByName = useMemo(
    () => new Map(pieces.map((piece) => [piece.name, piece])),
    [pieces]
  )

  const filterOptions = useMemo(() => {
    const withActions = pieces.filter((piece) => piece.actions > 0)
    return {
      integrations: withActions.map((piece) => ({
        name: piece.name,
        displayName: piece.displayName,
      })),
      categories: categoriesQuery.data ?? [],
    }
  }, [pieces, categoriesQuery.data])

  const hasActiveFilters =
    !!urlState.integration || !!urlState.category || urlState.connectionRequired

  const filteredBrowsePieces = pieces.filter(
    (piece) =>
      piece.actions > 0 &&
      matchesSummaryFilters(
        {
          pieceName: piece.name,
          requiresConnection: !!piece.auth?.required,
          categories: piece.categories ?? [],
        },
        urlState
      )
  )

  const filteredSearchResults = (knowledgeQuery.data?.results ?? []).filter((result) =>
    matchesSummaryFilters(
      {
        pieceName: result.pieceName,
        requiresConnection: result.requiresConnection,
        categories: summariesByName.get(result.pieceName)?.categories ?? [],
      },
      urlState
    )
  )

  const clearFilters = () => {
    urlState.setIntegration('')
    urlState.setCategory(ALL_CATEGORIES)
    urlState.setConnectionRequired(false)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Actions"
        description="Find a capability, connect an account, execute it, and take the working code with you."
      />

      <div className="max-w-md">
        <Input
          type="search"
          icon={<Search className="h-4 w-4" />}
          placeholder="Search actions..."
          aria-label="Search actions"
          value={urlState.query}
          onChange={(event) => urlState.setQuery(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3" data-testid="action-filters">
        <select
          aria-label="Filter by integration"
          value={urlState.integration}
          onChange={(event) => urlState.setIntegration(event.target.value)}
          className="h-8 cursor-pointer rounded-md border border-input bg-card px-2.5 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">All integrations</option>
          {filterOptions.integrations.map((integration) => (
            <option key={integration.name} value={integration.name}>
              {integration.displayName}
            </option>
          ))}
        </select>

        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={urlState.connectionRequired}
            onChange={(event) => urlState.setConnectionRequired(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          Connection required
        </label>

        {hasActiveFilters && (
          <Button size="xs" variant="ghost" onClick={clearFilters} className="gap-1 text-muted-foreground">
            <X className="h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      <CategoryFilter
        categories={filterOptions.categories}
        value={urlState.category || ALL_CATEGORIES}
        onChange={urlState.setCategory}
        isLoading={categoriesQuery.isLoading}
      />

      {isSearchMode ? (
        knowledgeQuery.isError ? (
          <ErrorState
            title="Search failed"
            description="The action search could not be completed. Check your connection and try again."
            onRetry={() => void knowledgeQuery.refetch()}
          />
        ) : knowledgeQuery.isPending ? (
          <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : filteredSearchResults.length === 0 ? (
          <EmptyState
            icon={Search}
            title={`No actions found for "${debouncedQuery}"`}
            description={
              hasActiveFilters
                ? 'Try removing some filters or using a different search term.'
                : 'Try a different term, like "send email" or "create issue".'
            }
          >
            {hasActiveFilters && (
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </EmptyState>
        ) : (
          <SearchResults
            results={filteredSearchResults}
            summariesByName={summariesByName}
          />
        )
      ) : integrationsQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : integrationsQuery.isError ? (
        <ErrorState
          title="Could not load the catalog"
          description="The integrations catalog could not be loaded. Check your connection and try again."
          onRetry={() => void integrationsQuery.refetch()}
        />
      ) : filteredBrowsePieces.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No matching integrations"
          description={
            hasActiveFilters
              ? 'No integrations match the current filters. Remove a filter to see more.'
              : 'Install integrations or sync the catalog to browse their actions here.'
          }
        >
          {hasActiveFilters && (
            <Button size="sm" variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="browse-count">
            {filteredBrowsePieces.length} integration{filteredBrowsePieces.length === 1 ? '' : 's'} ·
            open one to browse its actions, or search above for a specific capability
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredBrowsePieces.map((piece) => (
              <IntegrationBrowseCard key={piece.name} piece={piece} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

