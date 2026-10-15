import { describe, expect, it, vi } from 'vitest';
import {
  FigmaWebhookData,
  createWebhookTriggerKey,
  verifyFigmaWebhookRequest,
  verifyWebhookPasscode,
} from './webhook';

const PASSCODE = 'figma_passcode_V1StGXR8_Z5jdHi6B-myT';

// Event payload shape from the Figma webhooks v2 events documentation
// (https://developers.figma.com/docs/rest-api/webhooks-events).
const EVENT_BODY = {
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

function mockStore(value: FigmaWebhookData | null) {
  return {
    get: vi.fn().mockResolvedValue(value),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const webhookData: FigmaWebhookData = {
  webhookId: '22',
  passcode: PASSCODE,
};

describe('verifyWebhookPasscode', () => {
  it('accepts the passcode Figma passed back in the event body', () => {
    expect(verifyWebhookPasscode(PASSCODE, EVENT_BODY.passcode)).toBe(true);
  });

  it('rejects a wrong passcode', () => {
    expect(verifyWebhookPasscode(PASSCODE, 'figma_passcode_attacker_guess')).toBe(false);
  });

  it('rejects when the delivered passcode is missing', () => {
    expect(verifyWebhookPasscode(PASSCODE, undefined)).toBe(false);
  });

  it('rejects when the stored passcode is missing', () => {
    expect(verifyWebhookPasscode(undefined, PASSCODE)).toBe(false);
  });

  it('rejects a non-string delivered passcode', () => {
    expect(verifyWebhookPasscode(PASSCODE, { passcode: PASSCODE })).toBe(false);
    expect(verifyWebhookPasscode(PASSCODE, 12345)).toBe(false);
  });

  it('rejects a passcode of different length without throwing', () => {
    expect(verifyWebhookPasscode(PASSCODE, 'short')).toBe(false);
  });
});

describe('verifyFigmaWebhookRequest', () => {
  it('resolves when the event body passcode matches the stored one', async () => {
    const store = mockStore(webhookData);
    await expect(
      verifyFigmaWebhookRequest({ store, payload: { body: EVENT_BODY } }, 'new_comment'),
    ).resolves.toBeUndefined();
    expect(store.get).toHaveBeenCalledWith(createWebhookTriggerKey('new_comment'));
  });

  it('throws when the delivered passcode does not match the stored one', async () => {
    await expect(
      verifyFigmaWebhookRequest(
        { store: mockStore(webhookData), payload: { body: { ...EVENT_BODY, passcode: 'spoofed' } } },
        'new_comment',
      ),
    ).rejects.toThrow('Webhook passcode verification failed. This request may not be from Figma.');
  });

  it('throws when the event body carries no passcode but one is stored', async () => {
    const { passcode: _omitted, ...bodyWithoutPasscode } = EVENT_BODY;
    await expect(
      verifyFigmaWebhookRequest(
        { store: mockStore(webhookData), payload: { body: bodyWithoutPasscode } },
        'new_comment',
      ),
    ).rejects.toThrow('Webhook passcode verification failed. This request may not be from Figma.');
  });

  it('skips verification when no webhook data is stored (legacy instances)', async () => {
    await expect(
      verifyFigmaWebhookRequest(
        { store: mockStore(null), payload: { body: { ...EVENT_BODY, passcode: 'anything' } } },
        'new_comment',
      ),
    ).resolves.toBeUndefined();
  });

  it('skips verification when the stored entry has no passcode', async () => {
    const stored = { ...webhookData, passcode: '' };
    await expect(
      verifyFigmaWebhookRequest(
        { store: mockStore(stored), payload: { body: { ...EVENT_BODY, passcode: 'anything' } } },
        'new_comment',
      ),
    ).resolves.toBeUndefined();
  });

  it('throws when the body is not an object but a passcode is stored', async () => {
    await expect(
      verifyFigmaWebhookRequest({ store: mockStore(webhookData), payload: { body: 'not-json' } }, 'new_comment'),
    ).rejects.toThrow('Webhook passcode verification failed. This request may not be from Figma.');
  });
});
