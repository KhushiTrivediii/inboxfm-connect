import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ApiClientError } from '../api/client'
import { queryClient } from './query-client'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

describe('QueryClient Error Handling & Toast Feedback (Issue #29 / DESIGN_SYSTEM.md §6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryClient.clear()
  })

  it('triggers sonner toast error when a query with showErrorToast: true fails', async () => {
    const error = new ApiClientError(500, 'Internal Server Error')

    await expect(
      queryClient.fetchQuery({
        queryKey: ['connections-fail-test'],
        queryFn: () => Promise.reject(error),
        meta: { showErrorToast: true },
        retry: false,
      })
    ).rejects.toThrow()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Query Failed', {
      description: 'Internal Server Error',
    })
  })

  it('uses fallback message when a non-ApiClientError without message fails', async () => {
    await expect(
      queryClient.fetchQuery({
        queryKey: ['fallback-error-test'],
        queryFn: () => Promise.reject(new Error('')),
        meta: { showErrorToast: true },
        retry: false,
      })
    ).rejects.toThrow()

    expect(toast.error).toHaveBeenCalledWith('Query Failed', {
      description: 'An unexpected error occurred',
    })
  })

  it('surfaces errors for the shared showErrorDialog convention', async () => {
    await expect(
      queryClient.fetchQuery({
        queryKey: ['dialog-error-test'],
        queryFn: () => Promise.reject(new ApiClientError(500, 'Page unavailable')),
        meta: { showErrorDialog: true },
        retry: false,
      })
    ).rejects.toThrow()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Query Failed', {
      description: 'Page unavailable',
    })
  })

  it('does NOT trigger sonner toast error when a query explicitly disables showErrorDialog', async () => {
    const error = new ApiClientError(500, 'Silent Dialog Failure')

    await expect(
      queryClient.fetchQuery({
        queryKey: ['silent-dialog-fail-test'],
        queryFn: () => Promise.reject(error),
        meta: { showErrorDialog: false },
        retry: false,
      })
    ).rejects.toThrow()

    expect(toast.error).not.toHaveBeenCalled()
  })

  it('does NOT trigger sonner toast error when a query explicitly disables showErrorToast', async () => {
    const error = new ApiClientError(500, 'Silent Failure')

    await expect(
      queryClient.fetchQuery({
        queryKey: ['silent-fail-test'],
        queryFn: () => Promise.reject(error),
        meta: { showErrorToast: false },
        retry: false,
      })
    ).rejects.toThrow()

    expect(toast.error).not.toHaveBeenCalled()
  })

  it('does NOT trigger sonner toast error when query meta is omitted (guards against duplicate alerts)', async () => {
    await expect(
      queryClient.fetchQuery({
        queryKey: ['no-meta-fail-test'],
        queryFn: () => Promise.reject(new ApiClientError(500, 'Uncaught Error')),
        retry: false,
      })
    ).rejects.toThrow()

    expect(toast.error).not.toHaveBeenCalled()
  })
})
