import { Blocks } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CategoryFilter } from '@/components/integrations/category-filter'
import { IntegrationGrid, IntegrationGridSkeleton } from '@/components/integrations/integration-grid'
import { IntegrationSearch } from '@/components/integrations/integration-search'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationsListParams } from '@/lib/api/types'
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value'
import { useIntegrationCategories, useIntegrations } from '@/lib/query/hooks'

const SEARCH_DEBOUNCE_MS = 300
const SUGGESTED_SEARCHES = ['GitHub', 'Gmail', 'Slack']

type SortField = NonNullable<IntegrationsListParams['sortBy']>
type SortDirection = NonNullable<IntegrationsListParams['orderBy']>

const SORT_FIELD_OPTIONS: Array<{ value: SortField; label: string }> = [
  { value: 'NAME', label: 'Name' },
  { value: 'POPULARITY', label: 'Popularity' },
]

const SORT_DIRECTION_OPTIONS: Array<{ value: SortDirection; label: string }> = [
  { value: 'ASC', label: 'Ascending' },
  { value: 'DESC', label: 'Descending' },
]

function CatalogSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 cursor-pointer rounded-md border border-input bg-card px-2 text-xs text-muted-foreground shadow-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export default function IntegrationsPage() {
  const [searchInput, setSearchInput] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL')
  const [sortBy, setSortBy] = useState<SortField>('NAME')
  const [orderBy, setOrderBy] = useState<SortDirection>('ASC')

  const searchQuery = useDebouncedValue(searchInput.trim(), SEARCH_DEBOUNCE_MS)

  const queryParams = useMemo<IntegrationsListParams>(
    () => ({
      ...(searchQuery ? { searchQuery } : {}),
      ...(selectedCategory !== 'ALL' ? { categories: [selectedCategory] } : {}),
      sortBy,
      orderBy,
    }),
    [searchQuery, selectedCategory, sortBy, orderBy]
  )

  const {
    data: integrations,
    isLoading,
    isError,
    refetch,
  } = useIntegrations(queryParams)
  const { data: categories, isLoading: isCategoriesLoading } = useIntegrationCategories()

  const pieces = integrations?.data ?? []
  const hasActiveFilters = searchInput.trim().length > 0 || selectedCategory !== 'ALL'

  const clearFilters = () => {
    setSearchInput('')
    setSelectedCategory('ALL')
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Integrations" description="Connect your apps and discover their tools." />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <IntegrationSearch
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search integrations..."
          label="Search integrations"
          className="w-full lg:max-w-sm"
        />
        <div className="flex items-center gap-2 lg:ml-auto">
          <CatalogSelect
            id="integrations-sort-by"
            label="Sort integrations by"
            value={sortBy}
            options={SORT_FIELD_OPTIONS}
            onChange={(value) => setSortBy(value === 'POPULARITY' ? 'POPULARITY' : 'NAME')}
          />
          <CatalogSelect
            id="integrations-sort-order"
            label="Sort direction"
            value={orderBy}
            options={SORT_DIRECTION_OPTIONS}
            onChange={(value) => setOrderBy(value === 'DESC' ? 'DESC' : 'ASC')}
          />
        </div>
      </div>

      <CategoryFilter
        categories={categories ?? []}
        value={selectedCategory}
        onChange={setSelectedCategory}
        isLoading={isCategoriesLoading}
      />

      <div className="text-xs text-muted-foreground" aria-live="polite">
        {isLoading ? (
          <Skeleton className="inline-block h-3 w-28 align-middle" />
        ) : (
          <>
            {pieces.length} integration{pieces.length === 1 ? '' : 's'}
            {hasActiveFilters ? ' matching filters' : ' available'}
          </>
        )}
      </div>

      {isError ? (
        <ErrorState
          title="Unable to load integrations."
          description="The catalog could not be reached. Check your connection and try again."
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <IntegrationGridSkeleton count={9} />
      ) : pieces.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No integrations found"
          description={
            hasActiveFilters
              ? 'No integrations match your current search and filters.'
              : 'The catalog is empty right now. Try again later.'
          }
          actionLabel={hasActiveFilters ? 'Clear Filters' : undefined}
          onAction={hasActiveFilters ? clearFilters : undefined}
        >
          {hasActiveFilters && (
            <div className="flex items-center justify-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Try:</span>
              {SUGGESTED_SEARCHES.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => setSearchInput(term)}
                  className="cursor-pointer rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {term}
                </button>
              ))}
            </div>
          )}
        </EmptyState>
      ) : (
        <IntegrationGrid pieces={pieces} />
      )}
    </div>
  )
}
