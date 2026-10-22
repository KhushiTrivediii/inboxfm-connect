import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { ErrorBoundary } from '@/components/layout/error-boundary'
import { ErrorState } from '@/components/ui/error-state'
import { createTestQueryClient, mount, waitFor } from './test-utils'

// Component that intentionally throws during render
function CrashingComponent({ shouldThrow }: { shouldThrow: boolean }) {
    if (shouldThrow) {
        throw new Error('Critical data query failed on server with HTTP 500')
    }
    return <div data-testid="success-view">Data successfully loaded!</div>
}

// Component that consumes a React Query and renders ErrorState on failure
function QueryConsumerView({ queryFn }: { queryFn: () => Promise<string> }) {
    const { data, isError, error, refetch, isPending } = useQuery({
        queryKey: ['test-query-failure'],
        queryFn,
        retry: false,
    })

    if (isPending) {
        return <div data-testid="loading">Loading records...</div>
    }

    if (isError) {
        return (
            <ErrorState
                title="Failed to Load Data"
                description={error instanceof Error ? error.message : 'Unknown query error'}
                onRetry={() => refetch()}
            />
        )
    }

    return <div data-testid="query-data">{data}</div>
}

describe('Query Error Handling & Error Boundary Invariants (Issue #132)', () => {
    it('catches render exceptions in ErrorBoundary and displays ErrorState without leaving a blank screen', () => {
        // Suppress expected console.error from React during intentional boundary catch
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const container = mount(
            <ErrorBoundary>
                <CrashingComponent shouldThrow={true} />
            </ErrorBoundary>,
        )

        // Assert DOM is NOT empty
        expect(container.innerHTML.trim()).not.toBe('')
        expect(container.textContent).toContain('Application Error')
        expect(container.textContent).toContain('Critical data query failed on server with HTTP 500')
        expect(container.textContent).toContain('Try again')

        consoleErrorSpy.mockRestore()
    })

    it('renders custom fallback when provided to ErrorBoundary', () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const container = mount(
            <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom Safe Fallback</div>}>
                <CrashingComponent shouldThrow={true} />
            </ErrorBoundary>,
        )

        expect(container.querySelector('[data-testid="custom-fallback"]')).not.toBeNull()
        expect(container.textContent).toContain('Custom Safe Fallback')

        consoleErrorSpy.mockRestore()
    })

    it('renders ErrorState with retry button when a React Query fetch fails', async () => {
        const queryClient = createTestQueryClient()
        let callCount = 0
        const failingQueryFn = async (): Promise<string> => {
            callCount++
            if (callCount === 1) {
                throw new Error('Network error: Failed to connect to server API')
            }
            return 'Recovered data payload'
        }

        const container = mount(
            <QueryClientProvider client={queryClient}>
                <QueryConsumerView queryFn={failingQueryFn} />
            </QueryClientProvider>,
        )

        // Wait for query error state to render
        await waitFor(() => container.textContent?.includes('Failed to Load Data') === true)

        expect(container.textContent).toContain('Network error: Failed to connect to server API')
        expect(container.textContent).toContain('Try again')

        // Click retry button and assert recovery
        const retryButton = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('Try again'),
        )
        expect(retryButton).toBeDefined()

        await act(async () => {
            retryButton?.click()
        })

        await waitFor(() => container.textContent?.includes('Recovered data payload') === true)
        expect(container.textContent).toContain('Recovered data payload')
        expect(callCount).toBe(2)
    })
})
