import { timingSafeEqual } from 'crypto';
import { Store } from '@inboxfm-connect/pieces-framework';

export const createWebhookTriggerKey = (triggerName: string) => {
  return `figma_${triggerName}_trigger_data`;
};

export interface FigmaWebhookData {
  webhookId: string;
  passcode: string;
}

export type FigmaWebhookVerificationContext = {
  store: Store;
  payload: {
    body?: unknown;
  };
};

/**
 * Compares the passcode Figma puts in the request body of every webhook
 * delivery with the passcode stored by onEnable when the webhook was created.
 *
 * Figma sends the webhook's passcode back in the top-level `passcode` field
 * of every event payload (including the PING event sent on creation) so the
 * receiver can verify the delivery actually came from Figma; the value must
 * match what was provided when the webhook was created.
 * See https://developers.figma.com/docs/rest-api/webhooks-security
 */
export const verifyWebhookPasscode = (
  storedPasscode: string | undefined,
  deliveredPasscode: unknown,
): boolean => {
  if (!storedPasscode || typeof deliveredPasscode !== 'string') {
    return false;
  }

  const storedBuffer = Buffer.from(storedPasscode, 'utf8');
  const deliveredBuffer = Buffer.from(deliveredPasscode, 'utf8');
  if (storedBuffer.length !== deliveredBuffer.length) {
    return false;
  }

  return timingSafeEqual(storedBuffer, deliveredBuffer);
};

/**
 * Verifies the `passcode` field of an incoming Figma webhook delivery against
 * the passcode stored by onEnable when the webhook was created. Throws on a
 * failed verification; skips verification when no passcode is stored for
 * this trigger instance.
 */
export const verifyFigmaWebhookRequest = async (
  context: FigmaWebhookVerificationContext,
  triggerName: string,
): Promise<void> => {
  const webhookData = await context.store.get<FigmaWebhookData>(
    createWebhookTriggerKey(triggerName),
  );

  const passcode = webhookData?.passcode;
  if (!passcode) {
    // No passcode stored for this trigger instance, so there is nothing to
    // verify against. onEnable always generates and stores one, so this can
    // only happen for trigger instances enabled before verification was added
    // or whose store entry was lost — accept those instead of breaking them.
    return;
  }

  const payloadBody = context.payload.body as Record<string, unknown> | undefined;
  const deliveredPasscode = payloadBody?.['passcode'];
  if (!verifyWebhookPasscode(passcode, deliveredPasscode)) {
    throw new Error('Webhook passcode verification failed. This request may not be from Figma.');
  }
};
