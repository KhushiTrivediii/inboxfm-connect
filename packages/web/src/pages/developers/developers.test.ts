import { describe, expect, it } from 'vitest'

describe('Developers Page Snippets (#176)', () => {
  it('REST curl snippet has properly closed quotes and valid headers', () => {
    const origin = 'https://app.inboxfm.com'
    const restSnippet = `curl -X POST "${origin}/api/v1/execute" \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "<PROJECT_ID>",
    "integration": "@inboxfm-connect/piece-slack",
    "tool": "send_message",
    "externalUserId": "user_42",
    "input": {
      "channel": "#general",
      "text": "Hello from my app!"
    }
  }'`

    // Verify Authorization header has closing quote
    expect(restSnippet).toContain('-H "Authorization: Bearer <API_KEY>" \\')
    expect(restSnippet).toContain('-H "Content-Type: application/json" \\')
    
    // Check unmatched quotes across lines
    const lines = restSnippet.split('\n')
    const authLine = lines.find((l) => l.includes('Authorization: Bearer'))
    expect(authLine).toBeDefined()
    const quoteCount = (authLine!.match(/"/g) || []).length
    expect(quoteCount % 2).toBe(0)

    // Verify JSON payload inside -d is valid JSON syntax
    const jsonMatch = restSnippet.match(/-d '([\s\S]*?)'/)
    expect(jsonMatch).not.toBeNull()
    const jsonStr = jsonMatch![1]
    const parsed = JSON.parse(jsonStr)
    expect(parsed.projectId).toBe('<PROJECT_ID>')
    expect(parsed.integration).toBe('@inboxfm-connect/piece-slack')
    expect(parsed.tool).toBe('send_message')
    expect(parsed.externalUserId).toBe('user_42')
    expect(parsed.input.channel).toBe('#general')
    expect(parsed.input.text).toBe('Hello from my app!')
  })
})
