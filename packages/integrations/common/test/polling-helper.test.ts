import { describe, expect, it } from 'vitest';
import type { FilesService, Store } from '@inboxfm-connect/pieces-framework';
import { DedupeStrategy, pollingHelper } from '../src/lib/polling';

type PollingArg = Parameters<typeof pollingHelper.poll>[0];
type PollParams = Parameters<typeof pollingHelper.poll>[1];

interface PollItem {
  epochMilliSeconds: number;
  data: unknown;
}

const T0 = Date.parse('2025-01-01T00:00:00Z');

class MemoryStore implements Store {
  private readonly data = new Map<string, unknown>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.data.set(key, value);
    }
  }

  async put<T>(key: string, value: T): Promise<T> {
    this.data.set(key, value);
    return value;
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.data.has(key) ? this.data.get(key) : null) as T | null;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const files: FilesService = {
  write: async () => 'unused-file-id',
};

function makeParams(store: Store): PollParams {
  return {
    store,
    auth: {} as never,
    propsValue: {},
    files,
  };
}

function timebasedPolling(items: PollItem[]): PollingArg {
  return {
    strategy: DedupeStrategy.TIMEBASED,
    items: async () => items,
  };
}

describe('pollingHelper.poll TIMEBASED valid-item semantics', () => {
  it('emits only items strictly newer than the stored cursor and advances it to the newest epoch', async () => {
    const store = new MemoryStore({ lastPoll: T0 });
    const polling = timebasedPolling([
      { epochMilliSeconds: T0 + 100, data: 'new' },
      { epochMilliSeconds: T0 - 100, data: 'old' },
      { epochMilliSeconds: T0, data: 'boundary' },
    ]);

    const emitted = await pollingHelper.poll(polling, makeParams(store));

    expect(emitted).toEqual(['new']);
    expect(await store.get('lastPoll')).toBe(T0 + 100);
  });

  it('keeps the cursor unchanged when no item is newer', async () => {
    const store = new MemoryStore({ lastPoll: T0 });
    const polling = timebasedPolling([
      { epochMilliSeconds: T0 - 1, data: 'old' },
      { epochMilliSeconds: T0, data: 'boundary' },
    ]);

    const emitted = await pollingHelper.poll(polling, makeParams(store));

    expect(emitted).toEqual([]);
    expect(await store.get('lastPoll')).toBe(T0);
  });

  it('emits nothing and keeps the cursor for an empty item list', async () => {
    const store = new MemoryStore({ lastPoll: T0 });

    const emitted = await pollingHelper.poll(timebasedPolling([]), makeParams(store));

    expect(emitted).toEqual([]);
    expect(await store.get('lastPoll')).toBe(T0);
  });

  it('passes the stored cursor to items() as lastFetchEpochMS', async () => {
    const store = new MemoryStore({ lastPoll: T0 });
    let receivedEpoch: number | undefined;
    const polling: PollingArg = {
      strategy: DedupeStrategy.TIMEBASED,
      items: async ({ lastFetchEpochMS }) => {
        receivedEpoch = lastFetchEpochMS;
        return [{ epochMilliSeconds: T0 + 1, data: 'new' }];
      },
    };

    await pollingHelper.poll(polling, makeParams(store));

    expect(receivedEpoch).toBe(T0);
  });
});

describe('pollingHelper.poll TIMEBASED non-finite epoch guarding', () => {
  it('does not let a NaN item epoch poison the stored cursor', async () => {
    const store = new MemoryStore({ lastPoll: T0 });
    const polling = timebasedPolling([
      { epochMilliSeconds: Number.NaN, data: 'bad' },
      { epochMilliSeconds: T0 + 100, data: 'good' },
    ]);

    const emitted = await pollingHelper.poll(polling, makeParams(store));

    expect(emitted).toEqual(['good']);
    expect(await store.get('lastPoll')).toBe(T0 + 100);
  });

  it('does not let an Infinity item epoch poison the stored cursor', async () => {
    const store = new MemoryStore({ lastPoll: T0 });
    const polling = timebasedPolling([
      { epochMilliSeconds: Number.POSITIVE_INFINITY, data: 'bad' },
      { epochMilliSeconds: T0 + 100, data: 'good' },
    ]);

    const emitted = await pollingHelper.poll(polling, makeParams(store));

    expect(emitted).toEqual(['good']);
    expect(await store.get('lastPoll')).toBe(T0 + 100);
  });

  it('keeps the stored cursor when every item epoch is non-finite', async () => {
    const store = new MemoryStore({ lastPoll: T0 });
    const polling = timebasedPolling([
      { epochMilliSeconds: Number.NaN, data: 'nan' },
      { epochMilliSeconds: Number.POSITIVE_INFINITY, data: 'inf' },
      { epochMilliSeconds: Number.NEGATIVE_INFINITY, data: 'neg-inf' },
    ]);

    const emitted = await pollingHelper.poll(polling, makeParams(store));

    expect(emitted).toEqual([]);
    expect(await store.get('lastPoll')).toBe(T0);
  });

  it('keeps polling alive on the next poll after receiving a NaN item', async () => {
    const store = new MemoryStore({ lastPoll: T0 });

    const first = await pollingHelper.poll(
      timebasedPolling([
        { epochMilliSeconds: Number.NaN, data: 'bad' },
        { epochMilliSeconds: T0 + 50, data: 'good-1' },
      ]),
      makeParams(store)
    );
    const second = await pollingHelper.poll(
      timebasedPolling([{ epochMilliSeconds: T0 + 100, data: 'good-2' }]),
      makeParams(store)
    );

    expect(first).toEqual(['good-1']);
    expect(second).toEqual(['good-2']);
    expect(await store.get('lastPoll')).toBe(T0 + 100);
  });

  it('treats a NaN stored cursor as corrupt and throws', async () => {
    const store = new MemoryStore({ lastPoll: Number.NaN });

    await expect(
      pollingHelper.poll(timebasedPolling([]), makeParams(store))
    ).rejects.toThrow('lastPoll is not a finite epoch in the store.');
  });

  it('treats an Infinity stored cursor as corrupt and throws', async () => {
    const store = new MemoryStore({ lastPoll: Number.POSITIVE_INFINITY });

    await expect(
      pollingHelper.poll(timebasedPolling([]), makeParams(store))
    ).rejects.toThrow('lastPoll is not a finite epoch in the store.');
  });

  it('still throws the original error when lastPoll is missing', async () => {
    const store = new MemoryStore();

    await expect(
      pollingHelper.poll(timebasedPolling([]), makeParams(store))
    ).rejects.toThrow("lastPoll doesn't exist in the store.");
  });
});

describe('pollingHelper.onEnable TIMEBASED', () => {
  it('stores a finite lastPoll cursor', async () => {
    const store = new MemoryStore();
    const before = Date.now();

    await pollingHelper.onEnable(timebasedPolling([]), {
      store,
      auth: {} as never,
      propsValue: {},
    });

    const cursor = await store.get<number>('lastPoll');
    expect(Number.isFinite(cursor)).toBe(true);
    expect(cursor).toBeGreaterThanOrEqual(before);
  });
});
