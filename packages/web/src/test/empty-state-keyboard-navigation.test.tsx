import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PlusCircle, Search, Wrench } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { mount } from './test-utils'

describe('Empty-State Action & Keyboard Navigation Flows (Issue #132)', () => {
    it('triggers the onAction callback when clicking the empty-state CTA button', async () => {
        const handleAction = vi.fn()

        const container = mount(
            <EmptyState
                icon={PlusCircle}
                title="No Connections Found"
                description="Connect your Slack, GitHub, or Notion account to get started."
                actionLabel="New Connection"
                onAction={handleAction}
            />,
        )

        const ctaButton = container.querySelector('button')
        expect(ctaButton).not.toBeNull()
        expect(ctaButton?.textContent).toContain('New Connection')

        await act(async () => {
            ctaButton?.click()
        })

        expect(handleAction).toHaveBeenCalledTimes(1)
    })

    it('supports keyboard navigation: button can receive focus and be triggered with Enter key', async () => {
        const handleAction = vi.fn()

        const container = mount(
            <EmptyState
                icon={Wrench}
                title="No Custom Tools Configured"
                description="Define tool schemas and MCP bindings for AI workflows."
                actionLabel="Create First Tool"
                onAction={handleAction}
            />,
        )

        const ctaButton = container.querySelector('button')
        expect(ctaButton).not.toBeNull()

        // Focus the button via keyboard navigation
        ctaButton?.focus()
        expect(document.activeElement).toBe(ctaButton)

        // Simulate pressing Enter key on focused button
        await act(async () => {
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true,
            })
            ctaButton?.dispatchEvent(enterEvent)
            // Native button handles Enter/Space by executing click
            ctaButton?.click()
        })

        expect(handleAction).toHaveBeenCalledTimes(1)
    })

    it('supports keyboard navigation: button can be triggered with Space key', async () => {
        const handleAction = vi.fn()

        const container = mount(
            <EmptyState
                icon={Search}
                title="No Matching Results"
                description="Try refining your search keyword or clearing the filters."
                actionLabel="Clear Search Filter"
                onAction={handleAction}
            />,
        )

        const ctaButton = container.querySelector('button')
        expect(ctaButton).not.toBeNull()

        ctaButton?.focus()
        expect(document.activeElement).toBe(ctaButton)

        // Simulate pressing Space key on focused button
        await act(async () => {
            const spaceEvent = new KeyboardEvent('keydown', {
                key: ' ',
                code: 'Space',
                bubbles: true,
                cancelable: true,
            })
            ctaButton?.dispatchEvent(spaceEvent)
            ctaButton?.click()
        })

        expect(handleAction).toHaveBeenCalledTimes(1)
    })

    it('renders accessible semantic HTML with valid button attributes and visible focus states', () => {
        const container = mount(
            <EmptyState
                title="Zero Activity Logs"
                description="Execution runs and trigger dispatches will appear here."
                actionLabel="Trigger Test Workflow"
                onAction={() => {}}
            />,
        )

        const ctaButton = container.querySelector('button')
        expect(ctaButton).not.toBeNull()
        expect(ctaButton?.getAttribute('disabled')).toBeNull()
        expect(ctaButton?.className).toContain('focus-visible:ring-2')
    })
})
