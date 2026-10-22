import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { lemonSqueezy } from '../../index';

const SECRET = 'lemonsqueezy_1712345678_1a2b3c4d5e';

const sign = (rawBody: string, secret: string) =>
  createHmac('sha256', secret).update(rawBody).digest('hex');

const storedWebhookData = { webhookId: '1', secret: SECRET, storeId: '1' };

// All webhook triggers of the piece, exercised through their real run()
// implementations. A future trigger that forgets to verify the signature
// fails the tampered-body case below automatically.
const triggers = Object.values(lemonSqueezy.triggers());

describe('lemon-squeezy webhook trigger signature verification (integration)', () => {
  it('covers every webhook trigger of the piece (16 today)', () => {
    expect(triggers.length).toBeGreaterThanOrEqual(16);
  });

  for (const trigger of triggers) {
    const eventName = trigger.name;

    it(`${eventName}: returns the payload when X-Signature verifies against the stored secret`, async () => {
      const body = { meta: { event_name: eventName }, data: { type: 'orders', id: '1' } };
      const rawBody = JSON.stringify(body);
      const storeGet = vi.fn().mockResolvedValue(storedWebhookData);
      const context = {
        store: { get: storeGet, put: vi.fn(), delete: vi.fn() },
        payload: { headers: { 'x-signature': sign(rawBody, SECRET) }, rawBody, body },
      } as any;

      await expect(trigger.run(context)).resolves.toEqual([body]);
      // the secret is looked up under the store key onEnable wrote for this event
      expect(storeGet).toHaveBeenCalledWith(`_${eventName}_trigger`);
    });

    it(`${eventName}: throws when the signature does not match the raw body`, async () => {
      const body = { meta: { event_name: eventName }, data: { type: 'orders', id: '1' } };
      const context = {
        store: { get: vi.fn().mockResolvedValue(storedWebhookData), put: vi.fn(), delete: vi.fn() },
        payload: {
          headers: { 'x-signature': sign('{"spoofed":true}', SECRET) },
          rawBody: JSON.stringify(body),
          body,
        },
      } as any;

      await expect(trigger.run(context)).rejects.toThrow(
        'Webhook signature verification failed. This request may not be from Lemon Squeezy.'
      );
    });
  }
});
