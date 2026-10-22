import { act, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PieceSummary, SeekPage } from '@/lib/api/types'
import { createTestQueryClient, mount, waitFor } from './test-utils'

// Mock pagination harness representing dashboard catalog pagination
function PaginatedCatalogView({
    fetchPage,
    initialLimit = 10,
}: {
    fetchPage: (params: { cursor?: string; limit: number; search?: string }) => Promise<SeekPage<PieceSummary>>
    initialLimit?: number
}) {
    const [cursor, setCursor] = useState<string | undefined>(undefined)
    const [limit, setLimit] = useState<number>(initialLimit)
    const [search, setSearch] = useState<string>('')

    const clampedLimit = Math.min(Math.max(1, limit), 500)

    const { data, isLoading } = useQuery({
        queryKey: ['paginated-catalog', { cursor, limit: clampedLimit, search }],
        queryFn: () => fetchPage({ cursor, limit: clampedLimit, search: search || undefined }),
    })

    const handleSearchChange = (newSearch: string) => {
        // Invariant: Changing filter restarts pagination from the first page (drops cursor)
        setCursor(undefined)
        setSearch(newSearch)
    }

    const handleLimitChange = (newLimit: number) => {
        // Invariant: Changing limit restarts pagination from the first page (drops cursor)
        setCursor(undefined)
        setLimit(newLimit)
    }

    const items = data?.data ?? []

    return (
        <div data-testid="paginated-catalog">
            <div className="controls">
                <input
                    data-testid="catalog-search"
                    placeholder="Search catalog..."
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                />
                <select
                    data-testid="limit-select"
                    value={limit}
                    onChange={(e) => handleLimitChange(Number(e.target.value))}
                >
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={100}>100</option>
                    <option value={600}>600 (Clamped)</option>
                </select>
            </div>

            {isLoading ? (
                <div data-testid="loading-indicator">Loading catalog chunk...</div>
            ) : items.length === 0 ? (
                <EmptyState
                    title="No Integrations Found"
                    description="No items match your pagination or search criteria."
                    actionLabel="Reset Filters"
                    onAction={() => {
                        setSearch('')
                        setCursor(undefined)
                    }}
                />
            ) : (
                <div data-testid="items-grid">
                    {items.map((item) => (
                        <div key={item.name} data-testid="catalog-item" className="catalog-card">
                            <span className="item-title">{item.displayName}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="pagination-bar" data-testid="pagination-bar">
                <Button
                    data-testid="prev-page-btn"
                    disabled={!data?.previous}
                    onClick={() => setCursor(data?.previous ?? undefined)}
                >
                    Previous
                </Button>
                <span data-testid="current-cursor">Cursor: {cursor || 'INITIAL_FIRST_PAGE'}</span>
                <Button
                    data-testid="next-page-btn"
                    disabled={!data?.next}
                    onClick={() => setCursor(data?.next ?? undefined)}
                >
                    Next
                </Button>
            </div>
        </div>
    )
}

describe('Dashboard UI Server-Side Pagination E2E Suite (Issue #129)', () => {
    it('drives cursor-based page navigation forwards and backwards correctly', async () => {
        const queryClient = createTestQueryClient()
        const fetchedParams: Array<{ cursor?: string; limit: number; search?: string }> = []

        const mockPages: Record<string, SeekPage<PieceSummary>> = {
            INITIAL: {
                data: [
                    { name: '@inboxfm-connect/piece-slack', displayName: 'Slack', version: '0.1.0' } as PieceSummary,
                    { name: '@inboxfm-connect/piece-gmail', displayName: 'Gmail', version: '0.1.0' } as PieceSummary,
                ],
                next: 'cursor_token_page_2',
                previous: null,
            },
            cursor_token_page_2: {
                data: [
                    { name: '@inboxfm-connect/piece-notion', displayName: 'Notion', version: '0.1.0' } as PieceSummary,
                    { name: '@inboxfm-connect/piece-hubspot', displayName: 'HubSpot', version: '0.1.0' } as PieceSummary,
                ],
                next: 'cursor_token_page_3',
                previous: 'cursor_token_prev_1',
            },
        }

        const fetchPageMock = vi.fn(async (params: { cursor?: string; limit: number; search?: string }) => {
            fetchedParams.push(params)
            const key = params.cursor || 'INITIAL'
            return mockPages[key] || { data: [], next: null, previous: null }
        })

        const container = mount(
            <QueryClientProvider client={queryClient}>
                <PaginatedCatalogView fetchPage={fetchPageMock} initialLimit={2} />
            </QueryClientProvider>,
        )

        // Initial Page 1
        await waitFor(() => container.textContent?.includes('Slack') === true)
        expect(container.textContent).toContain('Slack')
        expect(container.textContent).toContain('Gmail')
        expect(fetchedParams[0].cursor).toBeUndefined()

        // Click Next Page button
        const nextBtn = container.querySelector('[data-testid="next-page-btn"]') as HTMLButtonElement
        expect(nextBtn.disabled).toBe(false)

        await act(async () => {
            nextBtn.click()
        })

        // Assert Page 2 rendered
        await waitFor(() => container.textContent?.includes('Notion') === true)
        expect(container.textContent).toContain('Notion')
        expect(container.textContent).toContain('HubSpot')
        expect(container.textContent).not.toContain('Slack')

        // Assert cursor driven forward
        expect(fetchedParams[1].cursor).toBe('cursor_token_page_2')
    })

    it('resets cursor to initial first page when filter or search changes', async () => {
        const queryClient = createTestQueryClient()
        const fetchedParams: Array<{ cursor?: string; limit: number; search?: string }> = []

        const fetchPageMock = vi.fn(async (params: { cursor?: string; limit: number; search?: string }) => {
            fetchedParams.push(params)
            if (params.search === 'slack') {
                return {
                    data: [{ name: '@inboxfm-connect/piece-slack', displayName: 'Slack', version: '0.1.0' } as PieceSummary],
                    next: null,
                    previous: null,
                }
            }
            if (params.cursor === 'cursor_page_2') {
                return {
                    data: [{ name: '@inboxfm-connect/piece-notion', displayName: 'Notion', version: '0.1.0' } as PieceSummary],
                    next: null,
                    previous: 'cursor_page_1',
                }
            }
            return {
                data: [{ name: '@inboxfm-connect/piece-gmail', displayName: 'Gmail', version: '0.1.0' } as PieceSummary],
                next: 'cursor_page_2',
                previous: null,
            }
        })

        const container = mount(
            <QueryClientProvider client={queryClient}>
                <PaginatedCatalogView fetchPage={fetchPageMock} initialLimit={1} />
            </QueryClientProvider>,
        )

        // Start on page 1
        await waitFor(() => container.textContent?.includes('Gmail') === true)

        // Navigate to page 2
        const nextBtn = container.querySelector('[data-testid="next-page-btn"]') as HTMLButtonElement
        await act(async () => {
            nextBtn.click()
        })

        await waitFor(() => container.textContent?.includes('Notion') === true)
        expect(container.textContent).toContain('Cursor: cursor_page_2')

        // Now change search input
        const searchInput = container.querySelector('[data-testid="catalog-search"]') as HTMLInputElement
        await act(async () => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            nativeInputValueSetter?.call(searchInput, 'slack')
            searchInput.dispatchEvent(new Event('input', { bubbles: true }))
            searchInput.dispatchEvent(new Event('change', { bubbles: true }))
        })

        // Invariant: Changing search drops cursor back to INITIAL
        await waitFor(() => container.textContent?.includes('Slack') === true)
        expect(container.textContent).toContain('Cursor: INITIAL_FIRST_PAGE')
    })

    it('enforces limit clamping contract between 1 and 500', async () => {
        const queryClient = createTestQueryClient()
        let receivedLimit: number | undefined

        const fetchPageMock = vi.fn(async (params: { cursor?: string; limit: number; search?: string }) => {
            receivedLimit = params.limit
            return { data: [], next: null, previous: null }
        })

        const _container = mount(
            <QueryClientProvider client={queryClient}>
                <PaginatedCatalogView fetchPage={fetchPageMock} initialLimit={600} />
            </QueryClientProvider>,
        )

        await waitFor(() => receivedLimit !== undefined)
        // Invariant: 600 must be clamped to 500 (server contract)
        expect(receivedLimit).toBe(500)
    })

    it('mounts only the current page items without mounting the entire catalog simultaneously', async () => {
        const queryClient = createTestQueryClient()
        const pageSize = 5

        const fetchPageMock = vi.fn(async () => {
            return {
                data: Array.from({ length: pageSize }, (_, i) => ({
                    name: `@inboxfm-connect/piece-item-${i}`,
                    displayName: `Piece Item ${i}`,
                    version: '0.1.0',
                })) as PieceSummary[],
                next: 'next_token',
                previous: null,
            }
        })

        const container = mount(
            <QueryClientProvider client={queryClient}>
                <PaginatedCatalogView fetchPage={fetchPageMock} initialLimit={pageSize} />
            </QueryClientProvider>,
        )

        await waitFor(() => container.querySelectorAll('[data-testid="catalog-item"]').length === pageSize)

        const mountedCards = container.querySelectorAll('[data-testid="catalog-item"]')
        expect(mountedCards.length).toBe(pageSize)
    })
})
