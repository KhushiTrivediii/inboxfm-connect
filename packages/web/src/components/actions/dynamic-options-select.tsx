import { RefreshCw, Search } from 'lucide-react'
import { ChangeEvent, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownOption, DropdownState } from '@/lib/api/types'
import { apiClient } from '@/lib/api/client'
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value'
import { cn } from '@/lib/utils/cn'

const SEARCH_DEBOUNCE_MS = 300

export interface DynamicOptionsSelectProps {
  pieceName: string
  pieceVersion: string
  actionOrTriggerName: string
  propertyName: string
  getInput: () => Record<string, unknown>
  value: unknown
  onChange: (value: unknown) => void
  multiple?: boolean
  disabled?: boolean
  invalid?: boolean
  id?: string
  describedBy?: string
}

function sameOptionValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function selectedLabel(options: DropdownOption[], value: unknown): string | undefined {
  const match = options.find((option) => sameOptionValue(option.value, value))
  return match?.label
}

export function DynamicOptionsSelect({
  pieceName,
  pieceVersion,
  actionOrTriggerName,
  propertyName,
  getInput,
  value,
  onChange,
  multiple = false,
  disabled = false,
  invalid = false,
  id,
  describedBy,
}: DynamicOptionsSelectProps) {
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS)
  const inputRef = useRef(getInput)
  inputRef.current = getInput

  // `/v1/integrations/options` is guarded by ProjectResourceType.BODY, so `projectId`
  // must travel in the body — the server never reads the x-project-id header for it.
  const projectId = apiClient.getProjectId() ?? undefined

  const query = useQuery({
    queryKey: [
      'action-options',
      projectId,
      pieceName,
      pieceVersion,
      actionOrTriggerName,
      propertyName,
      debouncedSearch,
    ],
    enabled: !disabled,
    retry: false,
    // Keep the previous page of options while a new search fetches. Without
    // this, every debounced keystroke flips the query back to `isPending`,
    // unmounting the select and the search input — the user loses focus (and
    // their caret) mid-typing and cannot continue entering a search term.
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiClient.post<DropdownState>('/integrations/options', {
        ...(projectId !== undefined ? { projectId } : {}),
        pieceName,
        pieceVersion,
        actionOrTriggerName,
        propertyName,
        input: inputRef.current(),
        searchValue: debouncedSearch || undefined,
      }),
  })

  const state = query.data
  const options = Array.isArray(state?.options) ? state.options : []
  const optionsDisabled = state?.disabled === true || disabled
  const hasSelection = !(value === undefined || value === null || value === '')
  const multiSelection = Array.isArray(value) ? value : []

  const selectClassName = cn(
    'flex w-full cursor-pointer rounded-md border border-input bg-card px-3 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
    invalid && 'border-destructive focus-visible:ring-destructive/40'
  )

  if (query.isPending) {
    return (
      <div className="space-y-1.5" data-testid={`options-loading-${propertyName}`}>
        <Skeleton className="h-9 w-full" />
        <p className="text-[11px] text-muted-foreground">Loading options…</p>
      </div>
    )
  }

  if (query.isError) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5"
        data-testid={`options-error-${propertyName}`}
      >
        <span className="text-xs text-destructive">
          Could not load options{query.error instanceof Error ? `: ${query.error.message}` : ''}.
        </span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    )
  }

  if (!multiple) {
    const current = hasSelection ? value : ''
    return (
      <div className="space-y-1.5">
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          disabled={optionsDisabled}
          value={sameOptionString(current, options)}
          onChange={(event) => {
            if (event.target.value === '') {
              onChange('')
              return
            }
            const match = options.find(
              (option) => optionKey(option.value) === event.target.value
            )
            onChange(match ? match.value : event.target.value)
          }}
          className={selectClassName}
        >
          {!hasSelection && (
            <option value="">
              {state?.placeholder ?? 'Select an option...'}
            </option>
          )}
          {hasSelection && !selectedLabel(options, value) && (
            <option value={optionKey(value)}>{displayForUnknown(value)}</option>
          )}
          {options.map((option) => (
            <option key={optionKey(option.value)} value={optionKey(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
        {!optionsDisabled && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              thin
              value={search}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
              placeholder="Search options…"
              aria-label={`Search options for ${propertyName}`}
              className="pl-8 text-xs"
              disabled={disabled}
            />
          </div>
        )}
      </div>
    )
  }

  const toggle = (raw: string, checked: boolean) => {
    const match = options.find((option) => optionKey(option.value) === raw)
    if (!match) {
      return
    }
    const next = checked
      ? [...multiSelection.filter((item) => !sameOptionValue(item, match.value)), match.value]
      : multiSelection.filter((item) => !sameOptionValue(item, match.value))
    onChange(next)
  }

  return (
    <div className="space-y-1.5" data-testid={`multi-options-${propertyName}`}>
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
          No options available.
        </p>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-input bg-card p-2">
          {options.map((option) => (
            <label
              key={optionKey(option.value)}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
            >
              <input
                type="checkbox"
                disabled={optionsDisabled}
                checked={multiSelection.some((item) => sameOptionValue(item, option.value))}
                onChange={(event) => toggle(optionKey(option.value), event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--primary)]"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )}
      <Input
        thin
        value={search}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
        placeholder="Search options…"
        aria-label={`Search options for ${propertyName}`}
        className="text-xs"
        disabled={disabled}
      />
    </div>
  )
}

function optionKey(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function displayForUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return optionKey(value)
}

function sameOptionString(current: unknown, options: DropdownOption[]): string {
  if (current === '' || current === undefined || current === null) {
    return ''
  }
  const match = options.find((option) => sameOptionValue(option.value, current))
  return match ? optionKey(match.value) : optionKey(current)
}
