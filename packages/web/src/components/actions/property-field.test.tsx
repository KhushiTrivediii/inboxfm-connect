import { describe, expect, it } from 'vitest'
import { PropertyField } from './property-field'
import { PieceProperty } from '@/lib/api/types'
import { mount } from '@/test/test-utils'

const jsonProp: PieceProperty = { displayName: 'Filter', required: true, type: 'JSON' }

function renderField(value: unknown): HTMLElement {
  return mount(
    <PropertyField
      pieceName="github"
      pieceVersion="0.3.4"
      actionOrTriggerName="createIssue"
      name="filter"
      property={jsonProp}
      value={value}
      onChange={() => undefined}
      getInput={() => ({})}
    />
  )
}

describe('PropertyField JSON/OBJECT rendering', () => {
  it('renders a stored parsed JSON value as editable JSON text', () => {
    const container = renderField({ state: 'open' })
    const textarea = container.querySelector('textarea')
    expect(textarea?.value).toBe('{\n  "state": "open"\n}')
  })

  it('renders string values unchanged', () => {
    const container = renderField('{"raw":true}')
    const textarea = container.querySelector('textarea')
    expect(textarea?.value).toBe('{"raw":true}')
  })

  it('renders an empty value as an empty textarea', () => {
    const container = renderField('')
    const textarea = container.querySelector('textarea')
    expect(textarea?.value).toBe('')
  })
})
