import { AlertTriangle, Plus, X } from 'lucide-react'
import { DynamicOptionsSelect } from '@/components/actions/dynamic-options-select'
import { Input } from '@/components/ui/input'
import { DropdownOption, PieceProperty } from '@/lib/api/types'
import { isUnsupportedPropertyType } from '@/lib/utils/action-form'
import { cn } from '@/lib/utils/cn'

export interface PropertyFieldProps {
  pieceName: string
  pieceVersion: string
  actionOrTriggerName: string
  name: string
  property: PieceProperty
  value: unknown
  onChange: (value: unknown) => void
  getInput: () => Record<string, unknown>
  error?: string
  disabled?: boolean
}

function staticOptions(property: PieceProperty): DropdownOption[] {
  return Array.isArray(property.options?.options) ? property.options.options : []
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/**
 * JSON/OBJECT fields edit their value as JSON text, but edit mode prefills them
 * with the parsed value stored in settings — render that back as editable JSON
 * instead of showing an empty textarea for a configured field.
 */
function jsonText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) {
    return ''
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

const DYNAMIC_TYPES = new Set(['DROPDOWN', 'MULTI_SELECT_DROPDOWN'])

const CONTROL_TEXTAREA_TYPES = new Set(['LONG_TEXT', 'JSON', 'OBJECT'])

export function PropertyField({
  pieceName,
  pieceVersion,
  actionOrTriggerName,
  name,
  property,
  value,
  onChange,
  getInput,
  error,
  disabled = false,
}: PropertyFieldProps) {
  const fieldId = `prop-${name}`
  const describedBy = property.description ? `${fieldId}-description` : undefined
  const showError = !!error

  const inputClassName = cn(
    showError && 'border-destructive focus-visible:ring-destructive/40'
  )

  const commonProps = {
    id: fieldId,
    'aria-describedby': describedBy,
    'aria-invalid': showError || undefined,
    disabled,
  }

  let control: React.ReactNode

  switch (property.type) {
    case 'SHORT_TEXT':
      control = (
        <Input
          {...commonProps}
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className={inputClassName}
        />
      )
      break
    case 'SECRET_TEXT':
      control = (
        <Input
          {...commonProps}
          type="password"
          autoComplete="off"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className={inputClassName}
        />
      )
      break
    case 'NUMBER':
      control = (
        <Input
          {...commonProps}
          type="number"
          value={
            typeof value === 'number'
              ? String(value)
              : typeof value === 'string'
                ? value
                : ''
          }
          onChange={(event) => {
            const raw = event.target.value
            onChange(raw === '' ? '' : Number(raw))
          }}
          className={inputClassName}
        />
      )
      break
    case 'CHECKBOX':
      control = (
        <input
          {...commonProps}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 cursor-pointer accent-[var(--primary)]"
        />
      )
      break
    case 'DATE_TIME':
      control = (
        <Input
          {...commonProps}
          type="datetime-local"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className={inputClassName}
        />
      )
      break
    case 'COLOR': {
      const hex = typeof value === 'string' && value.startsWith('#') ? value : '#000000'
      control = (
        <div className="flex items-center gap-2">
          <input
            {...commonProps}
            type="color"
            value={hex}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 w-12 cursor-pointer rounded-md border border-input bg-card p-1"
          />
          <Input
            {...commonProps}
            id={fieldId}
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            placeholder="#8142E3"
            className={cn('max-w-[140px] font-mono text-xs', inputClassName)}
          />
        </div>
      )
      break
    }
    case 'STATIC_DROPDOWN': {
      const options = staticOptions(property)
      const hasSelection = !(value === undefined || value === null || value === '')
      control = (
        <select
          {...commonProps}
          value={hasSelection ? optionKey(value) : ''}
          onChange={(event) => {
            if (event.target.value === '') {
              onChange('')
              return
            }
            const match = options.find((option) => optionKey(option.value) === event.target.value)
            onChange(match ? match.value : event.target.value)
          }}
          className={cn(
            'flex h-9 w-full cursor-pointer rounded-md border border-input bg-card px-3 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
            inputClassName
          )}
        >
          {!hasSelection && (
            <option value="">
              {property.options?.placeholder ?? 'Select an option...'}
            </option>
          )}
          {hasSelection && !options.some((option) => sameValue(option.value, value)) && (
            <option value={optionKey(value)}>{optionKey(value)}</option>
          )}
          {options.map((option) => (
            <option key={optionKey(option.value)} value={optionKey(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      )
      break
    }
    case 'STATIC_MULTI_SELECT_DROPDOWN': {
      const options = staticOptions(property)
      const selected = Array.isArray(value) ? value : []
      control = (
        <div
          className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-input bg-card p-2"
          data-testid={`multi-static-${name}`}
        >
          {options.map((option) => (
            <label
              key={optionKey(option.value)}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/60"
            >
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.some((item) => sameValue(item, option.value))}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected.filter((item) => !sameValue(item, option.value)), option.value]
                    : selected.filter((item) => !sameValue(item, option.value))
                  onChange(next)
                }}
                className="h-3.5 w-3.5 accent-[var(--primary)]"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )
      break
    }
    case 'DROPDOWN':
    case 'MULTI_SELECT_DROPDOWN': {
      control = (
        <DynamicOptionsSelect
          pieceName={pieceName}
          pieceVersion={pieceVersion}
          actionOrTriggerName={actionOrTriggerName}
          propertyName={name}
          getInput={getInput}
          value={value}
          onChange={onChange}
          multiple={property.type === 'MULTI_SELECT_DROPDOWN'}
          disabled={disabled}
          invalid={showError}
          id={fieldId}
          describedBy={describedBy}
        />
      )
      break
    }
    case 'JSON':
    case 'OBJECT':
      control = (
        <textarea
          {...commonProps}
          rows={5}
          spellCheck={false}
          value={jsonText(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder='{ "key": "value" }'
          className={cn(
            'w-full rounded-md border border-input bg-muted/20 px-3 py-2 font-mono text-xs shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
            inputClassName
          )}
        />
      )
      break
    case 'ARRAY': {
      const rows = Array.isArray(value) ? value : []
      const subProps = property.properties ?? {}
      control = (
        <div className="space-y-2" data-testid={`array-field-${name}`}>
          {rows.map((row, index) => (
            <div key={index} className="rounded-md border border-border bg-card/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Item {index + 1}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove item ${index + 1}`}
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-3">
                {Object.entries(subProps).map(([subName, subProp]) => (
                  <PropertyField
                    key={subName}
                    pieceName={pieceName}
                    pieceVersion={pieceVersion}
                    actionOrTriggerName={actionOrTriggerName}
                    name={`${name}.${index}.${subName}`}
                    property={subProp}
                    value={isRecord(row) ? row[subName] : undefined}
                    onChange={(subValue) => {
                      const currentRow = isRecord(row) ? row : {}
                      const nextRow = { ...currentRow, [subName]: subValue }
                      onChange(rows.map((item, i) => (i === index ? nextRow : item)))
                    }}
                    getInput={getInput}
                    disabled={disabled}
                  />
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([...rows, {}])}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-primary disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add item
          </button>
        </div>
      )
      break
    }
    default:
      control = null
  }

  if (control === null) {
    if (isUnsupportedPropertyType(property.type)) {
      return (
        <div className="space-y-1" data-testid={`unsupported-prop-${name}`}>
          <span className="text-xs font-medium text-foreground">{property.displayName}</span>
          <p className="flex items-start gap-1.5 rounded-md border border-dashed border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            <span>
              {property.type === 'MARKDOWN'
                ? typeof property.description === 'string' && property.description
                : `This input uses an unsupported field type (${property.type}). Leave it empty or call the API directly.`}
            </span>
          </p>
        </div>
      )
    }
    return null
  }

  return (
    <div className="space-y-1.5">
      {property.type !== 'CHECKBOX' && (
        <label htmlFor={fieldId} className="block text-xs font-medium text-foreground">
          {property.displayName}
          {property.required && <span aria-hidden="true"> *</span>}
          {(DYNAMIC_TYPES.has(property.type)) && (
            <span className="ml-1.5 rounded bg-muted px-1 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              dynamic
            </span>
          )}
          {CONTROL_TEXTAREA_TYPES.has(property.type) && (
            <span className="ml-1.5 rounded bg-muted px-1 py-0.5 align-middle font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {property.type.toLowerCase()}
            </span>
          )}
        </label>
      )}
      {property.type === 'CHECKBOX' && (
        <label
          htmlFor={fieldId}
          className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground"
        >
          {property.displayName}
          {property.required && <span aria-hidden="true"> *</span>}
        </label>
      )}
      {control}
      {property.description && !error && property.type !== 'MARKDOWN' && (
        <p id={describedBy} className="text-[11px] leading-relaxed text-muted-foreground">
          {property.description}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
