import { ArraySubProperty, PieceProperty } from '@/lib/api/types'

const INPUT_PROPERTY_TYPES = new Set([
  'SHORT_TEXT',
  'LONG_TEXT',
  'SECRET_TEXT',
  'NUMBER',
  'CHECKBOX',
  'STATIC_DROPDOWN',
  'STATIC_MULTI_SELECT_DROPDOWN',
  'DROPDOWN',
  'MULTI_SELECT_DROPDOWN',
  'DATE_TIME',
  'JSON',
  'OBJECT',
  'ARRAY',
  'COLOR',
])

const UNSUPPORTED_NOTICE_TYPES = new Set(['FILE', 'DYNAMIC', 'CUSTOM', 'OAUTH2', 'MARKDOWN'])

export type ActionFormValues = Record<string, unknown>

export function isInputProperty(property: PieceProperty | ArraySubProperty): boolean {
  return INPUT_PROPERTY_TYPES.has(property.type)
}

export function isUnsupportedPropertyType(type: string): boolean {
  return UNSUPPORTED_NOTICE_TYPES.has(type)
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true
  }
  if (typeof value === 'string' && value.trim() === '') {
    return true
  }
  if (Array.isArray(value) && value.length === 0) {
    return true
  }
  return false
}

function defaultForProperty(property: PieceProperty | ArraySubProperty): unknown {
  if (property.defaultValue !== undefined && property.defaultValue !== null) {
    return property.defaultValue
  }
  switch (property.type) {
    case 'CHECKBOX':
      return false
    case 'STATIC_MULTI_SELECT_DROPDOWN':
    case 'MULTI_SELECT_DROPDOWN':
    case 'ARRAY':
      return []
    case 'JSON':
    case 'OBJECT':
      return ''
    default:
      return ''
  }
}

export function initialValuesFromProps(props: Record<string, PieceProperty>): ActionFormValues {
  const values: ActionFormValues = {}
  for (const [name, property] of Object.entries(props)) {
    values[name] = defaultForProperty(property)
  }
  return values
}

export function validatePropertyValue(
  property: PieceProperty | ArraySubProperty,
  value: unknown
): string | undefined {
  if (!isInputProperty(property)) {
    return undefined
  }
  const missing = isEmptyValue(value)
  if (property.required && missing) {
    return `${property.displayName} is required`
  }
  if (missing) {
    return undefined
  }
  if (property.type === 'NUMBER') {
    if (typeof value === 'number' ? !Number.isFinite(value) : isNaN(Number(value))) {
      return `${property.displayName} must be a number`
    }
  }
  if ((property.type === 'JSON' || property.type === 'OBJECT') && typeof value === 'string') {
    try {
      JSON.parse(value)
    } catch {
      return `${property.displayName} must be valid JSON`
    }
  }
  return undefined
}

export function validateActionValues(
  props: Record<string, PieceProperty>,
  values: ActionFormValues
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [name, property] of Object.entries(props)) {
    const error = validatePropertyValue(property, values[name])
    if (error) {
      errors[name] = error
    }
  }
  return errors
}

function serializeSubProperties(
  subProps: Record<string, ArraySubProperty>,
  row: ActionFormValues
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [name, property] of Object.entries(subProps)) {
    if (!isInputProperty(property)) {
      continue
    }
    const raw = row[name]
    const serialized = serializeSingle(name, property, raw)
    if (serialized === undefined || serialized === null) {
      continue
    }
    if (typeof serialized === 'string' && serialized.trim() === '') {
      continue
    }
    output[name] = serialized
  }
  return output
}

function serializeSingle(
  name: string,
  property: PieceProperty | ArraySubProperty,
  value: unknown
): unknown {
  switch (property.type) {
    case 'NUMBER': {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined
      }
      if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
        return Number(value)
      }
      return undefined
    }
    case 'CHECKBOX':
      return value === true
    case 'STATIC_DROPDOWN':
    case 'DROPDOWN':
      return value === '' || value === undefined || value === null ? undefined : value
    case 'STATIC_MULTI_SELECT_DROPDOWN':
    case 'MULTI_SELECT_DROPDOWN': {
      if (!Array.isArray(value)) {
        return undefined
      }
      return value.filter((item) => item !== '' && item !== undefined && item !== null)
    }
    case 'JSON':
    case 'OBJECT': {
      if (typeof value === 'string') {
        if (value.trim() === '') {
          return undefined
        }
        try {
          return JSON.parse(value)
        } catch {
          return undefined
        }
      }
      // Values prefilled from stored settings are already parsed JSON — pass
      // them through instead of silently dropping them on save.
      return value === null || value === undefined ? undefined : value
    }
    case 'ARRAY': {
      if (!Array.isArray(value)) {
        return undefined
      }
      const subProps =
        'properties' in property && property.properties ? property.properties : {}
      const rows = value
        .map((row) =>
          typeof row === 'object' && row !== null && !Array.isArray(row)
            ? serializeSubProperties(subProps, row)
            : {}
        )
        .filter((row) => Object.keys(row).length > 0)
      return rows.length > 0 ? rows : undefined
    }
    default:
      return typeof value === 'string' ? value : undefined
  }
}

export function serializeValues(
  props: Record<string, PieceProperty>,
  values: ActionFormValues
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [name, property] of Object.entries(props)) {
    if (!isInputProperty(property)) {
      continue
    }
    const serialized = serializeSingle(name, property, values[name])
    if (serialized === undefined || serialized === null) {
      continue
    }
    if (typeof serialized === 'string' && serialized.trim() === '') {
      continue
    }
    output[name] = serialized
  }
  return output
}
