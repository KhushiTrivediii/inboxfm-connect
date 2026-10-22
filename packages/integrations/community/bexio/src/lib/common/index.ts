import { HttpError } from '@inboxfm-connect/pieces-common';

export const bexioCommon = {
  baseUrl: 'https://api.bexio.com',
  api_version: '3.0',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpError) {
    const body = error.response?.body;
    if (isRecord(body)) {
      const msg = body['message'] ?? body['error'];
      if (typeof msg === 'string' && msg.trim()) {
        return msg.trim();
      }
    } else if (typeof body === 'string' && body.trim()) {
      return body.trim();
    }
    if (error.response?.status) {
      return `HTTP ${error.response.status}`;
    }
  }

  if (isRecord(error)) {
    const resp = error['response'];
    if (isRecord(resp)) {
      const data = resp['data'] ?? resp['body'];
      if (isRecord(data)) {
        const msg = data['message'] ?? data['error'];
        if (typeof msg === 'string' && msg.trim()) {
          return msg.trim();
        }
      } else if (typeof data === 'string' && data.trim()) {
        return data.trim();
      }
      if (resp['status']) {
        return `HTTP ${resp['status']}`;
      }
    }
  }

  if (error instanceof Error) {
    if (error.message.startsWith('{') && error.message.includes('"response"')) {
      try {
        const parsed: unknown = JSON.parse(error.message);
        if (isRecord(parsed) && isRecord(parsed['response'])) {
          const resp = parsed['response'];
          const body = resp['body'] ?? resp['data'];
          if (isRecord(body)) {
            const msg = body['message'] ?? body['error'];
            if (typeof msg === 'string' && msg.trim()) {
              return msg.trim();
            }
          } else if (typeof body === 'string' && body.trim()) {
            return body.trim();
          }
          if (resp['status']) {
            return `HTTP ${resp['status']}`;
          }
        }
      } catch {
        // Fall back to original message
      }
    }
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return fallback;
}
