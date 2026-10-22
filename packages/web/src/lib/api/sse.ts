/**
 * Minimal SSE reader built on `fetch` + `ReadableStream`.
 *
 * Native `EventSource` cannot be used anywhere in this app: the API authenticates
 * exclusively from the `Authorization: Bearer <jwt>` header
 * (`authentication-middleware.ts`) and `EventSource` cannot set request headers.
 *
 * The parser extracts only the `data:` payloads of what the backend actually emits
 * (`execution.controller.ts`): frames shaped `id: <event id>\ndata: <json>\n\n`. The
 * `id:` line exists so a native EventSource can auto-reconnect with `Last-Event-ID`;
 * fetch-based callers read the same id from the JSON payload instead, so the line is
 * dropped here along with every other non-`data:` field. There are no `event:` or
 * `retry:` lines, no comment/heartbeat frames and no terminal sentinel, so none of
 * those are invented. Unknown field names are ignored rather than guessed at.
 */

const FRAME_SEPARATOR = /\r?\n\r?\n/

/**
 * Incremental parser for data-only SSE frames.
 *
 * Network chunks split at arbitrary byte offsets, so partial frames are buffered
 * until their terminating blank line arrives.
 */
export class SseFrameParser {
  private buffer = ''

  /** Returns the `data:` payloads of every frame completed by this chunk. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const parts = this.buffer.split(FRAME_SEPARATOR)
    // The trailing element is either an incomplete frame or an empty remainder.
    this.buffer = parts.pop() ?? ''
    return parts.map(readDataPayload).filter((payload): payload is string => payload !== null)
  }

  /** Flushes a final frame that arrived without a trailing blank line. */
  flush(): string[] {
    const remainder = this.buffer
    this.buffer = ''
    if (remainder.trim() === '') {
      return []
    }
    const payload = readDataPayload(remainder)
    return payload === null ? [] : [payload]
  }
}

/**
 * Streams one SSE endpoint until the server closes it, `signal` aborts, or
 * `onMessage` requests a stop by returning `'stop'`.
 *
 * Never resolves with data — callers receive frames through `onMessage`. Payloads
 * are handed over as raw strings; JSON parsing belongs to the caller so a single
 * malformed frame cannot tear down the stream.
 */
export async function streamSse({
  url,
  token,
  signal,
  onOpen,
  onMessage,
}: StreamSseParams): Promise<void> {
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(url, { method: 'GET', headers, signal })

  if (!response.ok) {
    throw new SseStreamError(`Stream request failed with status ${response.status}`, response.status)
  }
  if (!response.body) {
    throw new SseStreamError('Stream response carried no body', response.status)
  }

  onOpen?.()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseFrameParser()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      const payloads = parser.push(decoder.decode(value, { stream: true }))
      for (const payload of payloads) {
        if (onMessage(payload) === 'stop') {
          return
        }
      }
    }
    for (const payload of parser.flush()) {
      if (onMessage(payload) === 'stop') {
        return
      }
    }
  }
  finally {
    // Releasing the lock lets `cancel()` run even when the caller aborted mid-read.
    try {
      reader.releaseLock()
    }
    catch {
      // Already released by an abort; nothing to clean up.
    }
  }
}

function readDataPayload(frame: string): string | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''))

  if (dataLines.length === 0) {
    return null
  }
  return dataLines.join('\n')
}

export class SseStreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'SseStreamError'
  }
}

export type SseMessageDecision = 'continue' | 'stop'

export interface StreamSseParams {
  url: string
  token: string | null
  signal: AbortSignal
  onOpen?: () => void
  onMessage: (payload: string) => SseMessageDecision
}
