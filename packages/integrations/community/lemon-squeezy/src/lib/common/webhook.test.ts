import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  LemonSqueezyWebhookData,
  createWebhookTriggerKey,
  verifyLemonSqueezyWebhookRequest,
  verifyWebhookSignature,
} from './webhook';

const SECRET = 'lemonsqueezy_1712345678_1a2b3c4d5e';
const RAW_BODY = JSON.stringify({
  meta: { event_name: 'order_created' },
  data: { type: 'orders', id: '1' },
});

const sign = (rawBody: string, secret: string) =>
  createHmac('sha256', secret).update(rawBody).digest('hex');

function mockStore(value: LemonSqueezyWebhookData | null) {
  return {
    get: vi.fn().mockResolvedValue(value),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const webhookData: LemonSqueezyWebhookData = {
  webhookId: '42',
  secret: SECRET,
  storeId: '1',
};

describe('verifyWebhookSignature', () => {
  it('accepts a valid X-Signature over the raw body', () => {
    expect(verifyWebhookSignature(SECRET, sign(RAW_BODY, SECRET), RAW_BODY)).toBe(true);
  });

  it('accepts a valid signature when rawBody is a Buffer', () => {
    expect(verifyWebhookSignature(SECRET, sign(RAW_BODY, SECRET), Buffer.from(RAW_BODY, 'utf8'))).toBe(true);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const tampered = RAW_BODY.replace('"id":"1"', '"id":"2"');
    expect(verifyWebhookSignature(SECRET, sign(RAW_BODY, SECRET), tampered)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    expect(verifyWebhookSignature(SECRET, sign(RAW_BODY, 'attacker_secret'), RAW_BODY)).toBe(false);
  });

  it('rejects when the signature header is missing', () => {
    expect(verifyWebhookSignature(SECRET, undefined, RAW_BODY)).toBe(false);
  });

  it('rejects when the secret is missing', () => {
    expect(verifyWebhookSignature(undefined, sign(RAW_BODY, SECRET), RAW_BODY)).toBe(false);
  });

  it('rejects when rawBody is unavailable (cannot verify)', () => {
    expect(verifyWebhookSignature(SECRET, sign(RAW_BODY, SECRET), undefined)).toBe(false);
  });

  it('rejects a signature of different length without throwing', () => {
    expect(verifyWebhookSignature(SECRET, 'deadbeef', RAW_BODY)).toBe(false);
  });
});

describe('verifyLemonSqueezyWebhookRequest', () => {
  it('resolves when the X-Signature matches the stored secret', async () => {
    const store = mockStore(webhookData);
    await expect(
      verifyLemonSqueezyWebhookRequest(
        { store, payload: { headers: { 'x-signature': sign(RAW_BODY, SECRET) }, rawBody: RAW_BODY } },
        'order_created',
      ),
    ).resolves.toBeUndefined();
    expect(store.get).toHaveBeenCalledWith(createWebhookTriggerKey('order_created'));
  });

  it('throws when the body was tampered with', async () => {
    const tampered = RAW_BODY.replace('"id":"1"', '"id":"2"');
    await expect(
      verifyLemonSqueezyWebhookRequest(
        { store: mockStore(webhookData), payload: { headers: { 'x-signature': sign(RAW_BODY, SECRET) }, rawBody: tampered } },
        'order_created',
      ),
    ).rejects.toThrow('Webhook signature verification failed. This request may not be from Lemon Squeezy.');
  });

  it('throws when the signature header is missing but a secret is stored', async () => {
    await expect(
      verifyLemonSqueezyWebhookRequest(
        { store: mockStore(webhookData), payload: { headers: {}, rawBody: RAW_BODY } },
        'order_created',
      ),
    ).rejects.toThrow('Webhook signature verification failed. This request may not be from Lemon Squeezy.');
  });

  it('skips verification when no webhook data is stored (savvycal conditional precedent)', async () => {
    await expect(
      verifyLemonSqueezyWebhookRequest(
        { store: mockStore(null), payload: { headers: {}, rawBody: RAW_BODY } },
        'order_created',
      ),
    ).resolves.toBeUndefined();
  });

  it('skips verification when the stored entry has no secret', async () => {
    const stored = { ...webhookData, secret: '' };
    await expect(
      verifyLemonSqueezyWebhookRequest(
        { store: mockStore(stored), payload: { headers: {}, rawBody: RAW_BODY } },
        'order_created',
      ),
    ).resolves.toBeUndefined();
  });
});
