import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { apiClient } from '@/lib/api/client'
import { stubApi } from '@/test/api-stub'
import { mount } from '@/test/test-utils'
import { useRunTriggerBinding } from './hooks'

/**
 * `useRunTriggerBinding` records executions server-side (POST /trigger-bindings/:id/run
 * returns the created Execution rows). Its sibling `useRunScheduledTaskNow` invalidates
 * ['executions'] on success; without the same invalidation here, the Activity list,
 * the Dashboard "Recent Executions" card and the command palette keep serving the
 * pre-run cache until the 2-minute staleTime lapses — the toast on the trigger detail
 * page even links the freshly created records into that stale list.
 */
describe('useRunTriggerBinding', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    apiClient.setToken(null)
    apiClient.setProjectId(null)
  })

  it('invalidates executions queries after a successful run', async () => {
    const { requests } = stubApi([
      {
        match: (url, method) =>
          url.pathname === '/api/v1/trigger-bindings/tb_run_1/run' && method === 'POST',
        respond: () => ({ status: 200, body: [] }),
      },
    ])

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    // Seed the cache the way a mounted useExecutionsQuery would have.
    const executionsKey = ['executions', { limit: 5 }, 'proj_default']
    queryClient.setQueryData(executionsKey, { data: [], next: null, previous: null })
    expect(queryClient.getQueryState(executionsKey)?.isInvalidated).toBe(false)

    let mutation: ReturnType<typeof useRunTriggerBinding> | undefined
    function Probe() {
      mutation = useRunTriggerBinding()
      return null
    }
    mount(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    )
    expect(mutation).toBeDefined()

    await act(async () => {
      await mutation?.mutateAsync({ id: 'tb_run_1' })
    })

    expect(
      requests.some(
        (request) => request.method === 'POST' && request.url.endsWith('/trigger-bindings/tb_run_1/run')
      )
    ).toBe(true)
    expect(queryClient.getQueryState(executionsKey)?.isInvalidated).toBe(true)
  })
})
