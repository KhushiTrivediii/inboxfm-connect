import { createHmac, timingSafeEqual } from 'crypto';
import { httpClient, HttpMethod } from '@inboxfm-connect/pieces-common';
import { Property, Store } from '@inboxfm-connect/pieces-framework';
import { lemonSqueezyAuth } from './auth';
import { LEMON_SQUEEZY_API_BASE } from './api';

export const subscribeWebhook = async (auth: string, storeId: string, events: string[], targetUrl: string, secret: string) => {
  const response = await httpClient.sendRequest({
    method: HttpMethod.POST,
    url: `${LEMON_SQUEEZY_API_BASE}/webhooks`,
    headers: {
      'Authorization': `Bearer ${auth}`,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    body: {
      data: {
        type: 'webhooks',
        attributes: {
          url: targetUrl,
          events: events,
          secret: secret,
          test_mode: false
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: storeId
            }
          }
        }
      }
    }
  });
  return response.body;
};

export const unsubscribeWebhook = async (auth: string, webhookId: string) => {
  await httpClient.sendRequest({
    method: HttpMethod.DELETE,
    url: `${LEMON_SQUEEZY_API_BASE}/webhooks/${webhookId}`,
    headers: {
      'Authorization': `Bearer ${auth}`,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    }
  });
};

export const getStores = async (auth: string) => {
  const response = await httpClient.sendRequest({
    method: HttpMethod.GET,
    url: `${LEMON_SQUEEZY_API_BASE}/stores`,
    headers: {
      'Authorization': `Bearer ${auth}`,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    }
  });
  return response.body.data;
};

export const createStoreDropdownProperty = () => {
  return Property.Dropdown({
    displayName: 'Store',
    required: true,
    refreshers: ['auth'],
    auth: lemonSqueezyAuth,
    options: async ({ auth }) => {
      if (!auth) {
        return {
          disabled: true,
          options: [],
          placeholder: 'Please authenticate first'
        };
      }

      try {
        const stores = await getStores(auth.secret_text);
        return {
          options: stores.map((store: any) => ({
            label: store.attributes.name,
            value: store.id
          }))
        };
      } catch (error) {
        return {
          disabled: true,
          options: [],
          placeholder: 'Failed to load stores'
        };
      }
    }
  });
};

export const generateWebhookSecret = () => {
  return `lemonsqueezy_${Date.now()}_${Math.random().toString(36).substring(2)}`;
};

export const createWebhookTriggerKey = (eventName: string) => {
  return `_${eventName}_trigger`;
};

export interface LemonSqueezyWebhookData {
  webhookId: string;
  secret: string;
  storeId: unknown;
}

export type LemonSqueezyWebhookVerificationContext = {
  store: Store;
  payload: {
    headers: Record<string, string>;
    rawBody?: unknown;
  };
};

/**
 * Computes and compares the HMAC Lemon Squeezy puts in the X-Signature header.
 *
 * Lemon Squeezy signs the raw request body with HMAC-SHA256 using the webhook's
 * signing secret and sends the hex digest in the X-Signature header.
 * See https://docs.lemonsqueezy.com/help/webhooks/signing-requests
 */
export const verifyWebhookSignature = (
  secret: string | undefined,
  signatureHeader: string | undefined,
  rawBody: unknown,
): boolean => {
  if (!secret || !signatureHeader) {
    return false;
  }

  // The HMAC must be computed over the exact raw bytes Lemon Squeezy sent,
  // never over a re-serialized version of the parsed body.
  let rawBodyString: string | undefined;
  if (typeof rawBody === 'string') {
    rawBodyString = rawBody;
  } else if (rawBody instanceof Buffer) {
    rawBodyString = rawBody.toString('utf8');
  }

  if (rawBodyString === undefined) {
    return false;
  }

  const digest = createHmac('sha256', secret).update(rawBodyString).digest('hex');
  const digestBuffer = Buffer.from(digest, 'utf8');
  const signatureBuffer = Buffer.from(signatureHeader, 'utf8');
  if (digestBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(digestBuffer, signatureBuffer);
};

/**
 * Verifies the X-Signature header of an incoming Lemon Squeezy webhook against
 * the signing secret stored by onEnable when the webhook was subscribed. Throws
 * on a failed verification; skips verification when no secret is stored for
 * this trigger instance.
 */
export const verifyLemonSqueezyWebhookRequest = async (
  context: LemonSqueezyWebhookVerificationContext,
  eventName: string,
): Promise<void> => {
  const webhookData = await context.store.get<LemonSqueezyWebhookData>(
    createWebhookTriggerKey(eventName),
  );

  const secret = webhookData?.secret;
  if (!secret) {
    // No signing secret stored for this trigger instance, so there is nothing
    // to verify against. onEnable always generates and stores one, so this can
    // only happen for trigger instances enabled before verification was added
    // or whose store entry was lost — accept those instead of breaking them.
    return;
  }

  const signature = context.payload.headers['x-signature'];
  if (!verifyWebhookSignature(secret, signature, context.payload.rawBody)) {
    throw new Error('Webhook signature verification failed. This request may not be from Lemon Squeezy.');
  }
};

