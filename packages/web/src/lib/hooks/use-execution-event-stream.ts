import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '@/lib/api/client'
import { streamSse } from '@/lib/api/sse'
import { ExecutionEvent } from '@/lib/api/types'

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'ExecutionCompleted',
  'ExecutionFailed',
  'ExecutionCancelled',
])

/**
 * Subscribes to `GET /v1/executions/:id/events`.
 *
 * Backend contract this hook is built against, traced to the current server code
 * (`execution.controller.ts` + `execution-event.service.ts`) rather than inherited
 * from docs written before that code existed:
 * - The server replays the stored event history to every subscriber on connect
 *   (`streamResumableExecutionEvents` → `getEventsSince`), so an execution
 *   recorded before this page opened still shows its past events. History is
 *   capped at 1000 events with a 1h TTL server-side; nothing beyond what was
 *   stored is synthesised to fill gaps.
 * - Every frame carries `id: <executionId>:<seq>` above the `data:` JSON, and ids
 *   are monotonic per execution. A reconnect that presents the last received id —
 *   through the `Last-Event-ID` header native EventSource auto-reconnect sends,
 *   or the `lastEventId` query param offered to fetch-based clients like this one —
 *   is replayed only the events after it. The server also keeps a high-water
 *   sequence guard, so the history/live overlap is idempotent.
 * - Only `ExecutionStarted` is emitted today. `executionService.updateStatus`
 *   has no callers, so terminal events are unreachable. The renderer is
 *   generic so newly wired event types appear without a code change.
 * - Concurrent subscribers are independent: one viewer disconnecting never
 *   tears down another's stream (fixed server-side in #158).
 *
 * `retry` resumes from the last received event id instead of wiping the list, so
 * a churn-induced gap never hides events that already arrived; only a change of
 * `executionId` starts a fresh stream with a full history replay.
 *
 * Payloads live in component state only — never in localStorage/sessionStorage — and
 * the request is aborted on unmount so a late chunk can never touch a dead tree.
 */
export function useExecutionEventStream({ executionId, enabled = true }: UseExecutionEventStreamParams): ExecutionEventStream {
  const [events, setEvents] = useState<ExecutionEvent[]>([])
  const [status, setStatus] = useState<ExecutionStreamStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const resumeCursorRef = useRef<ResumeCursor | null>(null)

  const retry = useCallback(() => {
    abortRef.current?.abort()
    setError(null)
    setAttempt((current) => current + 1)
  }, [])

  useEffect(() => {
    if (!enabled || !executionId) {
      setStatus('idle')
      return
    }

    // The cursor belongs to one execution only: a different executionId shares no
    // history with the previous one, so drop the accumulated events and the cursor
    // to start from a full history replay instead of resuming the old position.
    if (resumeCursorRef.current?.executionId !== executionId) {
      resumeCursorRef.current = { executionId, lastEventId: null }
      setEvents([])
    }
    const lastEventId = resumeCursorRef.current.lastEventId

    const controller = new AbortController()
    abortRef.current = controller
    let active = true

    setStatus('connecting')
    setError(null)

    void streamSse({
      url: buildEventsUrl({ executionId, lastEventId }),
      token: apiClient.getToken(),
      signal: controller.signal,
      onOpen: () => {
        if (active) {
          setStatus('open')
        }
      },
      onMessage: (payload) => {
        if (!active) {
          return 'stop'
        }
        const event = decodeEvent(payload)
        if (event === null) {
          // A malformed frame is skipped rather than killing a working stream.
          return 'continue'
        }
        const cursor = resumeCursorRef.current
        if (cursor !== null && cursor.executionId === executionId) {
          cursor.lastEventId = event.id
        }
        setEvents((current) => (current.some((seen) => seen.id === event.id) ? current : [...current, event]))
        if (TERMINAL_EVENT_TYPES.has(event.type)) {
          setStatus('closed')
          return 'stop'
        }
        return 'continue'
      },
    })
      .then(() => {
        if (active) {
          setStatus('closed')
        }
      })
      .catch((streamError: unknown) => {
        if (!active || controller.signal.aborted) {
          return
        }
        setStatus('error')
        setError(describeStreamError(streamError))
      })

    return () => {
      active = false
      controller.abort()
      if (abortRef.current === controller) {
        abortRef.current = null
      }
    }
  }, [executionId, enabled, attempt])

  return { events, status, error, retry }
}

/**
 * Resume-cursor transport. `execution.controller.ts` reads the `Last-Event-ID`
 * header first (native EventSource auto-reconnect) and falls back to the
 * `lastEventId` query param, which exists precisely for fetch-based clients like
 * this one. Without a cursor the server replays the full stored history, so the
 * param is omitted on a fresh subscription rather than sent empty.
 */
function buildEventsUrl({ executionId, lastEventId }: { executionId: string, lastEventId: string | null }): string {
  const path = `/api/v1/executions/${encodeURIComponent(executionId)}/events`
  if (lastEventId === null) {
    return path
  }
  return `${path}?${new URLSearchParams({ lastEventId }).toString()}`
}

function decodeEvent(payload: string): ExecutionEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const candidate = parsed as Partial<ExecutionEvent>
    if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string') {
      return null
    }
    return {
      id: candidate.id,
      executionId: typeof candidate.executionId === 'string' ? candidate.executionId : '',
      type: candidate.type,
      timestamp: typeof candidate.timestamp === 'string' ? candidate.timestamp : '',
      payload: isRecord(candidate.payload) ? candidate.payload : {},
    }
  }
  catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeStreamError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('403')) {
      return 'You do not have access to this execution stream.'
    }
    if (error.message.includes('404')) {
      return 'This execution no longer exists.'
    }
    if (error.message === 'Failed to fetch') {
      return 'Could not reach the event stream. Check your network connection.'
    }
    return error.message
  }
  return 'The event stream stopped unexpectedly.'
}

export type ExecutionStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface UseExecutionEventStreamParams {
  executionId?: string
  enabled?: boolean
}

export interface ExecutionEventStream {
  events: ExecutionEvent[]
  status: ExecutionStreamStatus
  error: string | null
  retry: () => void
}

interface ResumeCursor {
  executionId: string
  lastEventId: string | null
}
