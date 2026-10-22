import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HttpMethod } from '@inboxfm-connect/pieces-common';
import { agentIdDropdown } from '../src/lib/common/props';
import * as clientModule from '../src/lib/common/client';

/**
 * Issue #477 — Retell removed `GET /list-agents` on 2026-07-31. The replacement is
 * the unified `POST /v2/list-agents`, which has three properties this pins:
 *
 *  - `limit` is a QUERY parameter; the v2 body schema documents only `filter_criteria`
 *  - v2 serves voice *and* chat agents, so `filter_criteria.channel` must be sent to
 *    preserve the old voice-only dropdown
 *  - the response is the `{ items, has_more, pagination_key }` envelope, never a
 *    top-level array
 *
 * The mocks below use the documented envelope so the suite exercises the shape
 * production actually receives.
 */

const AGENT = {
  agent_id: 'agent_123',
  agent_name: 'Customer Support Bot',
  version: 1,
  is_published: true,
  voice_id: 'voice_1',
};

const mockAgents = (response: unknown) =>
  vi.spyOn(clientModule, 'retellAiApiCall').mockResolvedValue(response as never);

const runDropdown = async (response: unknown) => {
  mockAgents(response);
  const dropdown = agentIdDropdown('Agent');
  return dropdown.options({ auth: 'retell_api_key' as never }, {} as never);
};

describe('agentIdDropdown (Issue #477)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to the v2 endpoint with limit on the query string and the voice channel filter', async () => {
    const apiSpy = mockAgents({ items: [AGENT], has_more: false });

    const dropdown = agentIdDropdown('Agent');
    await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

    expect(apiSpy).toHaveBeenCalledWith({
      auth: 'retell_api_key',
      method: HttpMethod.POST,
      url: '/v2/list-agents?limit=100',
      body: {
        filter_criteria: {
          channel: {
            type: 'string',
            op: 'eq',
            value: 'voice',
          },
        },
      },
    });
  });

  it('never sends limit in the request body', async () => {
    const apiSpy = mockAgents({ items: [AGENT] });

    const dropdown = agentIdDropdown('Agent');
    await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

    const body = apiSpy.mock.calls[0][0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('limit');
  });

  it('maps the documented items envelope into dropdown options', async () => {
    const result = await runDropdown({
      items: [AGENT],
      has_more: false,
      pagination_key: 'agent_123abc',
    });

    expect(result).toEqual({
      disabled: false,
      options: [
        {
          label: 'Customer Support Bot (agent_123)',
          value: 'agent_123',
        },
      ],
    });
  });

  it('disables the dropdown with a placeholder when the workspace has no agents', async () => {
    const result = await runDropdown({ items: [], has_more: false });

    expect(result).toEqual({
      disabled: true,
      options: [],
      placeholder: 'No agents found in your workspace.',
    });
  });

  it('does not crash on a malformed envelope', async () => {
    const result = await runDropdown({ has_more: false });

    expect(result).toEqual({
      disabled: true,
      options: [],
      placeholder: 'No agents found in your workspace.',
    });
  });

  it('follows pagination so agents past the first page are selectable', async () => {
    const apiSpy = vi
      .spyOn(clientModule, 'retellAiApiCall')
      .mockResolvedValueOnce({
        items: [{ ...AGENT, agent_id: 'agent_1' }],
        has_more: true,
        pagination_key: 'cursor_a',
      } as never)
      .mockResolvedValueOnce({
        items: [{ ...AGENT, agent_id: 'agent_2', agent_name: 'Second' }],
        has_more: true,
        pagination_key: 'cursor_b',
      } as never)
      .mockResolvedValueOnce({
        items: [{ ...AGENT, agent_id: 'agent_3', agent_name: 'Third' }],
        has_more: false,
      } as never);

    const dropdown = agentIdDropdown('Agent');
    const result = await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

    // Every page is requested, each with the cursor the previous one returned.
    expect(apiSpy).toHaveBeenCalledTimes(3);
    expect(apiSpy.mock.calls[0][0].url).toBe('/v2/list-agents?limit=100');
    expect(apiSpy.mock.calls[1][0].url).toBe('/v2/list-agents?limit=100&pagination_key=cursor_a');
    expect(apiSpy.mock.calls[2][0].url).toBe('/v2/list-agents?limit=100&pagination_key=cursor_b');

    expect(result).toEqual({
      disabled: false,
      options: [
        { label: 'Customer Support Bot (agent_1)', value: 'agent_1' },
        { label: 'Second (agent_2)', value: 'agent_2' },
        { label: 'Third (agent_3)', value: 'agent_3' },
      ],
    });
  });

  it('stops paginating when has_more is false', async () => {
    const apiSpy = mockAgents({ items: [AGENT], has_more: false });

    const dropdown = agentIdDropdown('Agent');
    await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it('stops paginating when has_more is true but no cursor is returned', async () => {
    // A cursor-less "more" would otherwise re-request page 1 forever.
    const apiSpy = mockAgents({ items: [AGENT], has_more: true });

    const dropdown = agentIdDropdown('Agent');
    await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

    expect(apiSpy).toHaveBeenCalledTimes(1);
  });

  it('breaks out when the API repeats a cursor instead of looping forever', async () => {
    const apiSpy = vi
      .spyOn(clientModule, 'retellAiApiCall')
      .mockResolvedValue({ items: [AGENT], has_more: true, pagination_key: 'same' } as never);

    const dropdown = agentIdDropdown('Agent');
    await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

    // Page 1 has no cursor, page 2 returns 'same', which would be re-sent.
    expect(apiSpy.mock.calls.length).toBeLessThanOrEqual(3);
    const urls = apiSpy.mock.calls.map((c) => c[0].url as string);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('disables without calling the API when auth is missing', async () => {
    const apiSpy = vi.spyOn(clientModule, 'retellAiApiCall');

    const dropdown = agentIdDropdown('Agent');
    const result = await dropdown.options({} as never, {} as never);

    expect(apiSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      disabled: true,
      options: [],
      placeholder: 'Connect your Retell AI account first',
    });
  });

  // choksi2212 on #485: the MAX_AGENT_PAGES bound silently truncated the list, and a short
  // dropdown is indistinguishable from a workspace that genuinely has few agents. These pin
  // that the truncation is reported - and, just as importantly, that it is NOT reported on
  // the ordinary paths, so the warning stays meaningful instead of becoming noise.
  describe('pagination bound reporting', () => {
    it('warns when the page bound is hit while the API still reports more', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Distinct cursor every page, has_more always true: the loop can only end at the bound.
      let call = 0;
      const apiSpy = vi.spyOn(clientModule, 'retellAiApiCall').mockImplementation(async () => {
        call += 1;
        return { items: [AGENT], has_more: true, pagination_key: `cursor_${call}` } as never;
      });

      const dropdown = agentIdDropdown('Agent');
      const result = await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

      // Bounded, not runaway.
      expect(apiSpy).toHaveBeenCalledTimes(20);
      // Truncated rather than empty - the bound does not break the dropdown.
      expect(result.options).toHaveLength(20);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toContain('20-page bound');
      expect(message).toContain('20 agents loaded');
      expect(message).toContain('MAX_AGENT_PAGES');
    });

    it('does not warn when the last page reports no more', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let call = 0;
      vi.spyOn(clientModule, 'retellAiApiCall').mockImplementation(async () => {
        call += 1;
        return call < 3
          ? ({ items: [AGENT], has_more: true, pagination_key: `cursor_${call}` } as never)
          : ({ items: [AGENT], has_more: false } as never);
      });

      const dropdown = agentIdDropdown('Agent');
      await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when the repeat-cursor guard breaks the walk early', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(clientModule, 'retellAiApiCall').mockResolvedValue({
        items: [AGENT],
        has_more: true,
        pagination_key: 'same',
      } as never);

      const dropdown = agentIdDropdown('Agent');
      await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

      // Stopping on a repeated cursor is a correctness escape, not truncation.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for a single-page workspace', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockAgents({ items: [AGENT], has_more: false });

      const dropdown = agentIdDropdown('Agent');
      await dropdown.options({ auth: 'retell_api_key' as never }, {} as never);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
