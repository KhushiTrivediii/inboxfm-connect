import { describe, it, expect } from 'vitest'
import { Property } from './index'
import { ArrayProperty } from './array-property'
import { ToolBase } from '../../piece-metadata'

describe('ArrayProperty schema & factory validation (issue #629)', () => {
  it('validates Property.Array factory output when properties is omitted', () => {
    const prop = Property.Array({
      displayName: 'Recipients',
      description: 'List of email recipients',
      required: true,
    })

    const parsed = ArrayProperty.safeParse(prop)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.displayName).toBe('Recipients')
      expect(parsed.data.type).toBe('ARRAY')
      expect(parsed.data.required).toBe(true)
      expect(parsed.data.properties).toBeUndefined()
    }
  })

  it('validates Property.Array factory output when properties is provided', () => {
    const prop = Property.Array({
      displayName: 'Tags',
      required: false,
      properties: {
        tag: Property.ShortText({
          displayName: 'Tag Name',
          required: true,
        }),
        color: Property.Color({
          displayName: 'Tag Color',
          required: false,
        }),
        metadata: Property.Json({
          displayName: 'Tag Metadata',
          required: false,
        }),
      },
    })

    const parsed = ArrayProperty.safeParse(prop)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.displayName).toBe('Tags')
      expect(parsed.data.required).toBe(false)
      expect(parsed.data.properties).toBeDefined()
      expect(parsed.data.properties?.tag).toBeDefined()
      expect(parsed.data.properties?.color).toBeDefined()
      expect(parsed.data.properties?.metadata).toBeDefined()
    }
  })

  it('validates serialized JSON catalog item through ToolBase', () => {
    const action = {
      name: 'send_email',
      displayName: 'Send Email',
      description: 'Sends an email to recipients',
      requireAuth: false,
      props: {
        to: Property.Array({
          displayName: 'To',
          description: 'Recipient email addresses',
          required: true,
        }),
        subject: Property.ShortText({
          displayName: 'Subject',
          required: true,
        }),
      },
    }

    // Direct runtime validation
    const runtimeResult = ToolBase.safeParse(action)
    expect(runtimeResult.success).toBe(true)

    // Serialized JSON validation (catalog storage / MCP tools)
    const serialized = JSON.parse(JSON.stringify(action))
    const serializedResult = ToolBase.safeParse(serialized)
    expect(serializedResult.success).toBe(true)
  })
})
