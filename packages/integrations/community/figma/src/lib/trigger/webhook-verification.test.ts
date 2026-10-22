import { describe, expect, it, vi } from 'vitest';
import { figma } from '../../index';

const PASSCODE = 'figma_passcode_V1StGXR8_Z5jdHi6B-myT';

const storedWebhookData = { webhookId: '22', passcode: PASSCODE };

// All webhook triggers of the piece, exercised through their real run()
// implementations. A future trigger that forgets to verify the passcode
// fails the tampered-body case below automatically.
const triggers = Object.values(figma.triggers());

describe('figma webhook trigger passcode verification (integration)', () => {
  it('covers every webhook trigger of the piece (1 today)', () => {
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });

  for (const trigger of triggers) {
    const triggerName = trigger.name;

    // Event payload shape from the Figma webhooks v2 events documentation
    // (https://developers.figma.com/docs/rest-api/webhooks-events).
    const fileCommentBody = {
      event_type: 'FILE_COMMENT',
      file_key: 'zH44k2FUM629Fa4EMShiHL',
      file_name: 'Mockup library',
      comment: [{ text: 'Change selection colors' }],
      comment_id: '32',
      mentions: [{ id: '811724164054158337', handle: 'Evan Wallace' }],
      order_id: '23 ',
      parent_id: '',
      created_at: '2020-02-23T20:27:16Z',
      resolved_at: '',
      passcode: PASSCODE,
      timestamp: '2020-02-23T20:27:16Z',
      triggered_by: { id: '813845097374535682', handle: 'Dylan Field' },
      webhook_id: '22',
    };

    it(`${triggerName}: returns the payload when the body passcode verifies against the stored one`, async () => {
      const storeGet = vi.fn().mockResolvedValue(storedWebhookData);
      const context = {
        store: { get: storeGet, put: vi.fn(), delete: vi.fn() },
        payload: { body: fileCommentBody },
      } as any;

      await expect(trigger.run(context)).resolves.toEqual([fileCommentBody]);
      // the passcode is looked up under the store key onEnable wrote for this trigger
      expect(storeGet).toHaveBeenCalledWith(`figma_${triggerName}_trigger_data`);
    });

    it(`${triggerName}: returns no events for the PING handshake when its passcode verifies`, async () => {
      const context = {
        store: { get: vi.fn().mockResolvedValue(storedWebhookData), put: vi.fn(), delete: vi.fn() },
        payload: {
          body: { event_type: 'PING', passcode: PASSCODE, timestamp: '2020-02-23T20:27:16Z', webhook_id: '22' },
        },
      } as any;

      await expect(trigger.run(context)).resolves.toEqual([]);
    });

    it(`${triggerName}: throws when the delivered passcode does not match the stored one`, async () => {
      const context = {
        store: { get: vi.fn().mockResolvedValue(storedWebhookData), put: vi.fn(), delete: vi.fn() },
        payload: { body: { ...fileCommentBody, passcode: 'figma_passcode_spoofed' } },
      } as any;

      await expect(trigger.run(context)).rejects.toThrow(
        'Webhook passcode verification failed. This request may not be from Figma.'
      );
    });

    it(`${triggerName}: throws when the PING event carries the wrong passcode`, async () => {
      const context = {
        store: { get: vi.fn().mockResolvedValue(storedWebhookData), put: vi.fn(), delete: vi.fn() },
        payload: {
          body: { event_type: 'PING', passcode: 'figma_passcode_spoofed', timestamp: '2020-02-23T20:27:16Z', webhook_id: '22' },
        },
      } as any;

      await expect(trigger.run(context)).rejects.toThrow(
        'Webhook passcode verification failed. This request may not be from Figma.'
      );
    });

    it(`${triggerName}: skips verification when no passcode is stored (legacy instance)`, async () => {
      const context = {
        store: { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn() },
        payload: { body: { ...fileCommentBody, passcode: 'figma_passcode_legacy' } },
      } as any;

      await expect(trigger.run(context)).resolves.toEqual([
        { ...fileCommentBody, passcode: 'figma_passcode_legacy' },
      ]);
    });
  }
});
