import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import DevelopersPage from './index'
import { buildRestSnippet } from './snippets'
import { mountAt } from '@/test/test-utils'

type Quote = 'single' | 'double'

// Minimal POSIX-shell lexer: reports unterminated quotes and dangling line
// continuations — the failure mode of a copy-paste broken curl snippet.
function shellErrors(command: string): string[] {
  const errors: string[] = []
  let quote: Quote | null = null
  let escaped = false
  const lines = command.split('\n')

  lines.forEach((line, index) => {
    let continued = false
    for (let position = 0; position < line.length; position += 1) {
      const char = line[position]
      if (escaped) {
        escaped = false
        continue
      }
      if (quote === 'single') {
        if (char === "'") quote = null
        continue
      }
      if (quote === 'double') {
        if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          quote = null
        }
        continue
      }
      if (char === '\\') {
        if (position === line.length - 1) {
          continued = true
        } else {
          escaped = true
        }
      } else if (char === '"') {
        quote = 'double'
      } else if (char === "'") {
        quote = 'single'
      }
    }
    if (index === lines.length - 1 && continued && quote === null) {
      errors.push('dangling line continuation at end of input')
    }
  })

  if (quote === 'single') errors.push('unterminated single quote')
  if (quote === 'double') errors.push('unterminated double quote')
  return errors
}

function bashWorks(): boolean {
  const probe = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' })
  return probe.status === 0
}

describe('developers REST snippet', () => {
  it('is a shell-valid curl command', () => {
    const snippet = buildRestSnippet({ origin: 'https://connect.example.com' })
    expect(shellErrors(snippet)).toEqual([])
  })

  it('closes the Authorization header quote (#176)', () => {
    const snippet = buildRestSnippet({ origin: 'https://connect.example.com' })
    expect(snippet).toContain('-H "Authorization: Bearer <API_KEY>" \\')

    const broken = [
      'curl -X POST "https://connect.example.com/api/v1/execute" \\',
      '  -H "Authorization: Bearer <API_KEY> \\',
    ].join('\n')
    expect(shellErrors(broken)).toContain('unterminated double quote')
  })

  it('renders the snippet the copy button puts on the clipboard', () => {
    const container = mountAt(<DevelopersPage />)
    const rendered = Array.from(container.querySelectorAll('pre')).find((pre) =>
      pre.textContent?.includes('curl -X POST'),
    )
    expect(rendered).toBeDefined()
    expect(rendered?.textContent).toBe(buildRestSnippet({ origin: window.location.origin }))
  })

  it.skipIf(!bashWorks())('passes bash -n', () => {
    const snippet = `${buildRestSnippet({ origin: 'https://connect.example.com' })}\n`
    const result = spawnSync('bash', ['-n'], { input: snippet, encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
