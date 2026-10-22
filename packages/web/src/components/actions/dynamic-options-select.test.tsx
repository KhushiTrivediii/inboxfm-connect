import { act } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DynamicOptionsSelect,
  DynamicOptionsSelectProps,
} from './dynamic-options-select'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { stubApi, StubRequestRecord, StubRoute } from '@/test/api-stub'

function baseProps(overrides: Partial<DynamicOptionsSelectProps> = {}): DynamicOptionsSelectProps {
  return {
    pieceName: 'github',
    pieceVersion: '0.3.4',
    actionOrTriggerName: 'createIssue',
    propertyName: 'repository',
    getInput: () => ({ title: 'hello' }),
    value: '',
    onChange: () => undefined,
    id: 'prop-repository',
    ...overrides,
  }
}

function renderSelect(props: DynamicOptionsSelectProps): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <DynamicOptionsSelect {...props} />
    </QueryClientProvider>
  )
}

function optionsRoutes(options: {
  state?: unknown
  failFirst?: boolean
} = {}): StubRoute[] {
  let failures = 0
  return [
    {
      match: (url) => url.pathname === '/api/v1/integrations/options',
      respond: (url) => {
        if (options.failFirst && failures === 0) {
          failures += 1
          return { status: 500, body: { message: 'options exploded' } }
        }
        void url
        return {
          status: 200,
          body:
            options.state ??
            {
              options: [
                { label: 'vedlabs/inboxfm', value: { id: 1, full_name: 'vedlabs/inboxfm' } },
                { label: 'vedlabs/other', value: { id: 2, full_name: 'vedlabs/other' } },
              ],
            },
        }
      },
    },
  ]
}

describe('DynamicOptionsSelect', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('posts the correct payload and renders returned option labels', async () => {
    const { requests } = stubApi(optionsRoutes())
    const container = renderSelect(baseProps())

    await waitFor(
      () =>
        requests.some(
          (request: StubRequestRecord) => request.url.includes('/api/v1/integrations/options')
        ) === true,
      4000
    )

    const posted = requests.find((request) => request.url.includes('/integrations/options'))
    expect(posted?.body).toEqual({
      pieceName: 'github',
      pieceVersion: '0.3.4',
      actionOrTriggerName: 'createIssue',
      propertyName: 'repository',
      input: { title: 'hello' },
    })

    await waitFor(() => container.textContent?.includes('vedlabs/inboxfm') === true)
  }, 15000)

  it('debounces search input into a single follow-up request', async () => {
    const { requests } = stubApi(optionsRoutes())
    const container = renderSelect(baseProps())

    await waitFor(() => container.querySelector('select') !== null)

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search options for repository"]'
    )
    expect(searchInput).not.toBeNull()

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(searchInput, 'v')
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(searchInput, 've')
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(searchInput, 'ved')
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await waitFor(
      () =>
        requests.filter((request) => request.url.includes('/integrations/options')).length >= 2,
      5000
    )

    const searchRequests = requests.filter(
      (request) =>
        request.url.includes('/integrations/options') &&
        (request.body as { searchValue?: string })?.searchValue !== undefined &&
        (request.body as { searchValue?: string })?.searchValue !== ''
    )
    expect(searchRequests.length).toBe(1)
    expect((searchRequests[0].body as { searchValue?: string }).searchValue).toBe('ved')
  }, 15000)

  it('keeps the search input mounted and focused while a follow-up search loads', async () => {
    const { requests } = stubApi(optionsRoutes())
    const container = renderSelect(baseProps())

    await waitFor(() => container.querySelector('select') !== null)
    await waitFor(() => container.textContent?.includes('vedlabs/inboxfm') === true)

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search options for repository"]'
    )
    expect(searchInput).not.toBeNull()

    await act(async () => {
      searchInput?.focus()
    })
    expect(document.activeElement).toBe(searchInput)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(searchInput, 'inbox')
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Wait for the debounced follow-up request to be sent.
    await waitFor(
      () =>
        requests.filter(
          (request) => (request.body as { searchValue?: string })?.searchValue === 'inbox'
        ).length >= 1,
      5000
    )

    // The refetch may not unmount the search input: it must still be in the DOM
    // and keep focus, so the user can continue typing their query.
    const inputAfterRefetch = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search options for repository"]'
    )
    expect(inputAfterRefetch).not.toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search options for repository')
  }, 15000)

  it('maps a selected label back to the raw option value', async () => {
    let selected: unknown = null
    stubApi(optionsRoutes())
    const container = renderSelect(
      baseProps({
        onChange: (value) => {
          selected = value
        },
      })
    )

    await waitFor(() => container.querySelector('select') !== null)
    await waitFor(() => container.textContent?.includes('vedlabs/inboxfm') === true)

    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select')
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, '{"id":1,"full_name":"vedlabs/inboxfm"}')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(selected).toEqual({ id: 1, full_name: 'vedlabs/inboxfm' })
  }, 15000)

  it('disables the select when the backend reports disabled options', async () => {
    stubApi(optionsRoutes({ state: { disabled: true, placeholder: 'Pick a repo first' } }))
    const container = renderSelect(baseProps())

    await waitFor(() => container.querySelector('select') !== null)
    const select = container.querySelector<HTMLSelectElement>('select')
    expect(select?.disabled).toBe(true)
    expect(container.textContent).toContain('Pick a repo first')
  }, 15000)

  it('shows an error with retry and recovers after retrying', async () => {
    const { requests } = stubApi(optionsRoutes({ failFirst: true }))
    const container = renderSelect(baseProps())

    await waitFor(
      () => container.querySelector('[data-testid="options-error-repository"]') !== null,
      4000
    )
    expect(container.textContent).toContain('Could not load options')

    const initialCount = requests.filter((request) =>
      request.url.includes('/integrations/options')
    ).length

    const retry = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry')
    )
    expect(retry).toBeTruthy()
    await act(async () => {
      retry?.click()
    })

    await waitFor(
      () =>
        requests.filter((request) => request.url.includes('/integrations/options')).length >
        initialCount
    )
    await waitFor(() => container.textContent?.includes('vedlabs/inboxfm') === true)
  }, 15000)
})
