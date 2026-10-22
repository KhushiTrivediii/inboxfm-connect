/// <reference types="vitest/globals" />

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AxiosHttpClient, HttpMethod } from '@inboxfm-connect/pieces-common';

// The HTTP client is a native-fetch implementation: egress is enforced by the
// engine's in-process dns.lookup / Socket.connect guards under AP_NETWORK_MODE=STRICT,
// so there is no process-wide proxy-env wiring. A caller proxies per request by
// passing a `dispatcher` (the HTTP piece's "Use Proxy" feature) - see
// packages/integrations/common/src/lib/http/core/fetch-http-client.ts.
//
// These tests therefore assert that a caller-supplied dispatcher reaches fetch
// and that omitting one leaves undici's default path intact. fetch is stubbed,
// so no test here performs DNS or a real request.
describe('AxiosHttpClient', () => {
  const originalFetch = globalThis.fetch;

  const stubFetch = () => {
    // A fresh Response per call: a Response body can only be read once, and a
    // single shared instance breaks any test that makes two requests.
    const fetchSpy = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  };

  beforeEach(() => {
    delete process.env['HTTP_PROXY'];
    delete process.env['HTTPS_PROXY'];
    delete process.env['http_proxy'];
    delete process.env['https_proxy'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    delete process.env['HTTP_PROXY'];
    delete process.env['HTTPS_PROXY'];
    delete process.env['http_proxy'];
    delete process.env['https_proxy'];
  });

  it('sends no dispatcher when the caller supplies none, ignoring proxy env vars', async () => {
    process.env['HTTP_PROXY'] = 'http://127.0.0.1:4444';
    process.env['HTTPS_PROXY'] = 'http://127.0.0.1:4444';

    const fetchSpy = stubFetch();
    const client = new AxiosHttpClient();
    await client.sendRequest({ method: HttpMethod.GET, url: 'https://api.example.com/data' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });

  it('forwards a caller-supplied undici dispatcher for per-request proxying', async () => {
    const dispatcher = { __brand: 'undici-dispatcher' };
    const fetchSpy = stubFetch();

    const client = new AxiosHttpClient();
    await client.sendRequest(
      { method: HttpMethod.GET, url: 'https://api.example.com/data' },
      { dispatcher },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBe(dispatcher);
  });

  it('keeps the dispatcher scoped to the request it was passed for', async () => {
    const fetchSpy = stubFetch();
    const client = new AxiosHttpClient();

    await client.sendRequest(
      { method: HttpMethod.GET, url: 'https://api.example.com/first' },
      { dispatcher: { id: 'first' } },
    );
    await client.sendRequest({ method: HttpMethod.GET, url: 'https://api.example.com/second' });

    const first = fetchSpy.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    const second = fetchSpy.mock.calls[1][1] as RequestInit & { dispatcher?: unknown };
    expect(first.dispatcher).toEqual({ id: 'first' });
    expect(second.dispatcher).toBeUndefined();
  });
});
