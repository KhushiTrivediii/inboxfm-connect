import { describe, expect, it } from 'vitest'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { LoadingState } from '@/components/ui/loading-state'
import { Skeleton } from '@/components/ui/skeleton'
import { mount } from './test-utils'

describe('Design System UI Primitives & Visual Regression (Issue #132)', () => {
    describe('Button Component', () => {
        it('renders all button variants with correct class names', () => {
            const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const
            for (const variant of variants) {
                const container = mount(<Button variant={variant}>Click Me</Button>)
                const btn = container.querySelector('button')
                expect(btn).not.toBeNull()
                expect(btn?.textContent).toBe('Click Me')
                expect(container.innerHTML).toMatchSnapshot(`button-variant-${variant}`)
            }
        })

        it('renders all button sizes with correct padding and typography', () => {
            const sizes = ['default', 'xs', 'sm', 'lg', 'icon', 'icon-sm', 'icon-xs'] as const
            for (const size of sizes) {
                const container = mount(<Button size={size}>Size {size}</Button>)
                const btn = container.querySelector('button')
                expect(btn).not.toBeNull()
                expect(container.innerHTML).toMatchSnapshot(`button-size-${size}`)
            }
        })

        it('renders loading state with disabled attribute and spinning loader', () => {
            const container = mount(<Button loading>Submitting</Button>)
            const btn = container.querySelector('button')
            expect(btn?.disabled).toBe(true)
            expect(container.querySelector('svg')).not.toBeNull()
            expect(container.textContent).toContain('Submitting')
        })

        it('renders disabled state correctly', () => {
            const container = mount(<Button disabled>Disabled Action</Button>)
            const btn = container.querySelector('button')
            expect(btn?.disabled).toBe(true)
            expect(btn?.className).toContain('disabled:opacity-50')
        })
    })

    describe('Badge Component', () => {
        it('renders all badge variants and matches visual snapshot', () => {
            const variants = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const
            for (const variant of variants) {
                const container = mount(<Badge variant={variant}>Badge {variant}</Badge>)
                const badge = container.querySelector('div')
                expect(badge?.textContent).toBe(`Badge ${variant}`)
                expect(container.innerHTML).toMatchSnapshot(`badge-variant-${variant}`)
            }
        })

        it('renders status dot indicator with appropriate color mappings', () => {
            const container = mount(<Badge variant="success" dot>Active</Badge>)
            const dot = container.querySelector('span')
            expect(dot).not.toBeNull()
            expect(dot?.className).toContain('bg-emerald-500')
            expect(container.textContent).toContain('Active')
        })
    })

    describe('Card Component Family', () => {
        it('renders complete Card hierarchy with header, title, description, content and footer', () => {
            const container = mount(
                <Card className="custom-card">
                    <CardHeader>
                        <CardTitle>Integration Status</CardTitle>
                        <CardDescription>Live webhook connection overview</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <p>All 14 webhook endpoints active</p>
                    </CardContent>
                    <CardFooter>
                        <Button size="sm">Manage Settings</Button>
                    </CardFooter>
                </Card>,
            )

            expect(container.textContent).toContain('Integration Status')
            expect(container.textContent).toContain('Live webhook connection overview')
            expect(container.textContent).toContain('All 14 webhook endpoints active')
            expect(container.textContent).toContain('Manage Settings')
            expect(container.innerHTML).toMatchSnapshot('card-complete-structure')
        })
    })

    describe('EmptyState, ErrorState, LoadingState & Skeleton Components', () => {
        it('renders EmptyState with title, description and action', () => {
            const container = mount(
                <EmptyState
                    title="No Integrations Found"
                    description="Get started by configuring your first third-party integration."
                    actionLabel="Add Integration"
                    onAction={() => {}}
                />,
            )

            expect(container.textContent).toContain('No Integrations Found')
            expect(container.textContent).toContain('Get started by configuring your first third-party integration.')
            expect(container.textContent).toContain('Add Integration')
            expect(container.innerHTML).toMatchSnapshot('empty-state-rendered')
        })

        it('renders ErrorState with title, description and retry action', () => {
            const container = mount(
                <ErrorState
                    title="Failed to Load Webhooks"
                    description="The server returned a 500 error while fetching webhook definitions."
                    onRetry={() => {}}
                />,
            )

            expect(container.textContent).toContain('Failed to Load Webhooks')
            expect(container.textContent).toContain('The server returned a 500 error')
            expect(container.textContent).toContain('Try again')
            expect(container.innerHTML).toMatchSnapshot('error-state-rendered')
        })

        it('renders LoadingState with animated skeleton rows', () => {
            const container = mount(<LoadingState rows={5} />)
            const skeletons = container.querySelectorAll('.animate-pulse')
            expect(skeletons.length).toBe(7) // 2 header skeletons + 5 row skeletons
        })

        it('renders Skeleton placeholder with animate-pulse class', () => {
            const container = mount(<Skeleton className="h-8 w-48 rounded-md" />)
            const skeleton = container.querySelector('div')
            expect(skeleton?.className).toContain('animate-pulse')
            expect(skeleton?.className).toContain('h-8')
            expect(skeleton?.className).toContain('w-48')
        })
    })
})
