import { QueryCache, QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiClientError } from '../api/client'

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      showErrorDialog?: boolean
      showErrorToast?: boolean
    }
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.meta?.showErrorDialog || query.meta?.showErrorToast) {
        const message =
          error instanceof ApiClientError
            ? error.message
            : error.message || 'An unexpected error occurred'
        toast.error('Query Failed', {
          description: message,
        })
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      retry: (failureCount, error) => {
        if (error instanceof ApiClientError) {
          if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
            return false
          }
        }
        return failureCount < 2
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
})
