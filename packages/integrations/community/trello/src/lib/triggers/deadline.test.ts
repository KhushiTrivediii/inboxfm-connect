import {
  HttpRequest,
  HttpResponse,
  httpClient,
} from '@inboxfm-connect/pieces-common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The trello piece defines `trelloAuth` in src/index.ts, so importing the
// trigger through the piece root would evaluate `createPiece` mid-cycle (the
// index imports this trigger back) and crash under vitest's transform. The
// trigger only carries `trelloAuth` as inert metadata (the POLLING branch of
// `createTrigger` never reads `params.auth`), so a stub is enough here.
vi.mock('../..', () => ({
  trelloAuth: {
    type: 'BASIC',
    name: 'trello_auth',
    displayName: 'Trello Auth',
    description: '',
    props: {},
  },
}));

import { deadlineTrigger } from './deadline';

const BASE_TIME = Date.parse('2026-10-14T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function resp(body: unknown): HttpResponse {
  return { status: 200, headers: {}, body };
}

function makeStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    get: async (key: string) => (key in data ? data[key] : undefined),
    put: async (key: string, value: unknown) => {
      data[key] = value;
      return value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
}

function triggerContext(store: ReturnType<typeof makeStore>) {
  return {
    auth: { username: 'api-key', password: 'api-token' },
    propsValue: {
      board_id: 'board-1',
      list_id_opt: undefined,
      time_before_due: 24,
      time_unit: 'hours',
    },
    store,
    files: {},
  } as never;
}

function card(id: string, dueMs: number | null, dueComplete = false) {
  return {
    id,
    name: `card-${id}`,
    due: dueMs === null ? null : new Date(dueMs).toISOString(),
    dueComplete,
    idBoard: 'board-1',
    idList: 'list-1',
  };
}

let sendRequest: ReturnType<typeof vi.spyOn>;
let boardCards: unknown[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  sendRequest = vi.spyOn(httpClient, 'sendRequest');
  sendRequest.mockImplementation(async (_request: HttpRequest) =>
    resp(boardCards),
  );
  boardCards = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function pollOnce(store: ReturnType<typeof makeStore>) {
  return (await deadlineTrigger.run(triggerContext(store))) as Array<{
    id: string;
  }>;
}

describe('deadline trigger dedupe', () => {
  it('fires a card created later whose due date precedes the max due date already emitted', async () => {
    const store = makeStore();
    await deadlineTrigger.onEnable(triggerContext(store));

    boardCards = [card('card-far', BASE_TIME + 23 * HOUR)];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-far']);

    // Ten minutes later a NEW card appears whose due date is 21 hours EARLIER
    // than the one already emitted, but still inside the (now, now+24h) window.
    vi.setSystemTime(BASE_TIME + 10 * MINUTE);
    boardCards = [
      card('card-far', BASE_TIME + 23 * HOUR),
      card('card-near', BASE_TIME + 2 * HOUR),
    ];

    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-near']);

    // The cursor must never be folded to a future due date: a future-dated
    // cursor is exactly what used to suppress later cards with earlier dues.
    const lastPoll = (await store.get('lastPoll')) as number;
    expect(lastPoll).toBeLessThan(BASE_TIME + 2 * HOUR);
  });

  it('does not re-emit a card that already fired for its current due date', async () => {
    const store = makeStore();
    await deadlineTrigger.onEnable(triggerContext(store));

    boardCards = [card('card-a', BASE_TIME + 23 * HOUR)];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-a']);

    vi.setSystemTime(BASE_TIME + 10 * MINUTE);
    boardCards = [
      card('card-a', BASE_TIME + 23 * HOUR),
      card('card-b', BASE_TIME + 2 * HOUR),
    ];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-b']);

    vi.setSystemTime(BASE_TIME + 15 * MINUTE);
    expect(await pollOnce(store)).toEqual([]);
  });

  it('fires again when a card deadline is moved to a new due date still in the window', async () => {
    const store = makeStore();
    await deadlineTrigger.onEnable(triggerContext(store));

    boardCards = [card('card-a', BASE_TIME + 23 * HOUR)];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-a']);

    vi.setSystemTime(BASE_TIME + 10 * MINUTE);
    boardCards = [card('card-a', BASE_TIME + 23 * HOUR + 10 * MINUTE)];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-a']);
  });

  it('upgrades from a stored TIMEBASED cursor without a duplicate burst and still fires new earlier-deadline cards', async () => {
    // Legacy state left by the old implementation: lastPoll was folded to the
    // max due date ever emitted, so it can sit in the future.
    const store = makeStore({ lastPoll: BASE_TIME + 20 * HOUR });

    boardCards = [
      card('card-seen', BASE_TIME + 18 * HOUR), // due <= cursor: already delivered or suppressed by the old code
      card('card-newer', BASE_TIME + 22 * HOUR), // due > cursor: the old code would emit it now
    ];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-newer']);

    vi.setSystemTime(BASE_TIME + 10 * MINUTE);
    expect(await pollOnce(store)).toEqual([]);

    // A card created after the upgrade with a due date earlier than the cursor.
    boardCards = [
      card('card-seen', BASE_TIME + 18 * HOUR),
      card('card-newer', BASE_TIME + 22 * HOUR),
      card('card-post-upgrade', BASE_TIME + 1 * HOUR),
    ];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual([
      'card-post-upgrade',
    ]);
  });

  it('test() keeps returning every uncompleted card with a due date as sample data', async () => {
    const store = makeStore();
    boardCards = [
      card('card-future', BASE_TIME + 2 * HOUR),
      card('card-past', BASE_TIME - 2 * HOUR),
      card('card-no-due', null),
      card('card-done', BASE_TIME + 2 * HOUR, true),
    ];

    const sample = (await deadlineTrigger.test(triggerContext(store))) as Array<{
      id: string;
    }>;
    expect(sample.map((c) => c.id)).toEqual(['card-future', 'card-past']);
  });

  it('re-enabling resets dedupe so in-window cards fire again (previous cursor-reset behavior)', async () => {
    const store = makeStore();
    await deadlineTrigger.onEnable(triggerContext(store));

    boardCards = [card('card-a', BASE_TIME + 23 * HOUR)];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-a']);

    vi.setSystemTime(BASE_TIME + 10 * MINUTE);
    boardCards = [
      card('card-a', BASE_TIME + 23 * HOUR),
      card('card-b', BASE_TIME + 2 * HOUR),
    ];
    expect((await pollOnce(store)).map((c) => c.id)).toEqual(['card-b']);

    // Re-enable resets dedupe state, like the old implementation reset the cursor.
    await deadlineTrigger.onEnable(triggerContext(store));
    expect((await pollOnce(store)).map((c) => c.id).sort()).toEqual([
      'card-a',
      'card-b',
    ]);
  });
});
