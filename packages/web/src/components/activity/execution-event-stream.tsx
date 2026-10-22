import { Radio, RefreshCw } from 'lucide-react'
import { JsonViewer } from '@/components/actions/json-viewer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ExecutionEvent } from '@/lib/api/types'
import { ExecutionStreamStatus } from '@/lib/hooks/use-execution-event-stream'
import { executionDisplay } from '@/lib/utils/execution-display'

const STREAM_STATUS_LABELS: Record<ExecutionStreamStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  open: 'Live',
  closed: 'Stream closed',
  error: 'Stream error',
}

const STREAM_STATUS_VARIANTS: Record<ExecutionStreamStatus, 'secondary' | 'warning' | 'success' | 'destructive' | 'outline'> = {
  idle: 'outline',
  connecting: 'warning',
  open: 'success',
  closed: 'secondary',
  error: 'destructive',
}

/**
 * Renders the frames received from `GET /v1/executions/:id/events`.
 *
 * The event type is rendered from the wire value rather than matched against a fixed
 * list, so any event the backend starts emitting shows up without a UI change. No
 * progress and no synthetic "executing"/"completed" step: the list holds exactly what
 * the server delivered — history replayed on connect plus the live frames after it —
 * so an empty list means the server has no events stored for this execution, which
 * is what the empty state says.
 */
export function ExecutionEventStream({ events, status, error, onRetry }: ExecutionEventStreamProps) {
  return (
    <div className="space-y-3" data-testid="execution-event-stream">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge
          variant={STREAM_STATUS_VARIANTS[status]}
          className="text-[10px]"
          dot
          data-testid="stream-status"
        >
          <Radio className="h-3 w-3" aria-hidden="true" />
          {STREAM_STATUS_LABELS[status]}
        </Badge>
        {(status === 'error' || status === 'closed') && (
          <Button
            size="xs"
            variant="outline"
            onClick={onRetry}
            className="gap-1"
            data-testid="stream-retry"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            <span>Reconnect</span>
          </Button>
        )}
      </div>

      {status === 'error' && error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive"
          data-testid="stream-error"
        >
          {error}
        </p>
      )}

      {events.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground"
          data-testid="stream-empty"
        >
          <p className="font-semibold text-foreground">No events received yet.</p>
          <p className="mt-1 leading-relaxed">
            Connecting replays this execution's recorded events, then follows new ones
            live. An empty list means the server has no events stored for this execution.
          </p>
        </div>
      ) : (
        <ol className="space-y-2" data-testid="stream-events">
          {events.map((event) => (
            <li
              key={event.id}
              className="rounded-xl border border-border bg-card p-3 shadow-xs"
              data-testid="stream-event"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-foreground" data-testid="stream-event-type">
                  {event.type}
                </span>
                {event.timestamp !== '' && (
                  <time
                    dateTime={event.timestamp}
                    className="font-mono text-[10px] text-muted-foreground"
                  >
                    {executionDisplay.formatAbsoluteTimestamp(event.timestamp)}
                  </time>
                )}
              </div>
              {Object.keys(event.payload).length > 0 && (
                <div className="mt-2">
                  <JsonViewer value={event.payload} label="Payload" maxHeightClass="max-h-48" />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export interface ExecutionEventStreamProps {
  events: ExecutionEvent[]
  status: ExecutionStreamStatus
  error: string | null
  onRetry: () => void
}
