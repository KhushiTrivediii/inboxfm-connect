import { describe, expect, it } from 'vitest'
import { ConnectionStatusBadge } from './connection-status-badge'
import { AppConnectionStatus } from '@/lib/api/types'
import { mount } from '@/test/test-utils'

function renderBadge(status: AppConnectionStatus): HTMLElement {
  const container = mount(<ConnectionStatusBadge status={status} />)
  return container.firstElementChild as HTMLElement
}

describe('ConnectionStatusBadge', () => {
  it('renders ACTIVE as a success chip labeled "Connected"', () => {
    const badge = renderBadge('ACTIVE')
    expect(badge.textContent).toBe('Connected')
    expect(badge.className).toContain('bg-emerald-500/10')
    expect(badge.title).toBe('')
  })

  it('renders MISSING as a warning "Needs setup" chip with reconnect guidance', () => {
    const badge = renderBadge('MISSING')
    expect(badge.textContent).toBe('Needs setup')
    expect(badge.className).toContain('bg-amber-500/10')
    expect(badge.title).toContain('no credentials')
    expect(badge.title).toContain('Reconnect')
  })

  it('renders ERROR as a destructive chip', () => {
    const badge = renderBadge('ERROR')
    expect(badge.textContent).toBe('Error')
    expect(badge.className).toContain('bg-destructive/10')
  })

  it('falls back to the raw status and the outline variant for unknown future statuses', () => {
    const badge = renderBadge('REVOKED' as AppConnectionStatus)
    expect(badge.textContent).toBe('REVOKED')
    expect(badge.className).toContain('bg-card')
  })
})
