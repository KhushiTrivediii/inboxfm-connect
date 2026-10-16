import { describe, expect, it } from 'vitest'
import { ArraySubProperty, PieceProperty } from '@/lib/api/types'
import { serializeValues } from './action-form'

function prop(type: string): PieceProperty {
  return { displayName: 'Field', required: false, type }
}

describe('serializeValues', () => {
  it('keeps already-parsed JSON/OBJECT values prefilled from stored settings', () => {
    const props: Record<string, PieceProperty> = {
      jsonFilter: prop('JSON'),
      objectConfig: prop('OBJECT'),
      label: prop('SHORT_TEXT'),
    }
    const values = {
      jsonFilter: { state: 'open', labels: ['bug'] },
      objectConfig: { mode: 'strict' },
      label: 'hello',
    }
    expect(serializeValues(props, values)).toEqual({
      jsonFilter: { state: 'open', labels: ['bug'] },
      objectConfig: { mode: 'strict' },
      label: 'hello',
    })
  })

  it('still parses typed JSON text and drops invalid JSON', () => {
    const props: Record<string, PieceProperty> = { filter: prop('JSON') }
    expect(serializeValues(props, { filter: '{"a":1}' })).toEqual({ filter: { a: 1 } })
    expect(serializeValues(props, { filter: 'not json' })).toEqual({})
    expect(serializeValues(props, { filter: '' })).toEqual({})
  })

  it('preserves parsed JSON values inside ARRAY rows', () => {
    const subProps: Record<string, ArraySubProperty> = {
      config: { displayName: 'Config', required: false, type: 'JSON' },
    }
    const props: Record<string, PieceProperty> = {
      items: { displayName: 'Items', required: false, type: 'ARRAY', properties: subProps },
    }
    const values = { items: [{ config: { keep: true } }] }
    expect(serializeValues(props, values)).toEqual({ items: [{ config: { keep: true } }] })
  })
})
