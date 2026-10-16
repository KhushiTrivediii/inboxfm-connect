import { createTrigger, TriggerStrategy } from '@inboxfm-connect/pieces-framework';
import { signrequestAuth } from '../common/auth';
import { makeRequest } from '../common/client';
import { HttpMethod } from '@inboxfm-connect/pieces-common';

export const signrequestDeclined = createTrigger({
  auth: signrequestAuth,
  name: 'signrequestDeclined',
  displayName: 'signrequest declined',
  description: 'Fires when a SignRequest is declined',
  aiMetadata: { description: 'Fires when a recipient declines a SignRequest. Use to handle rejected or refused signature requests.' },
  props: {},
  sampleData: {},
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    const apiKey = context.auth.secret_text;

    const body = {
      event_type: 'declined',
      callback_url: context.webhookUrl,
    };

    const response = await makeRequest(
      apiKey,
      HttpMethod.POST,
      '/webhooks/',
      body
    );
    await context.store.put('signrequest_declined_webhook', response.uuid);
  },
  async onDisable(context) {
    const apiKey = context.auth.secret_text;
    const webhookId = await context.store.get<any>(
      'signrequest_declined_webhook'
    );

    if (!webhookId) {
      console.debug('No Signrequest webhook found in store to delete');
      return;
    }

    await makeRequest(apiKey, HttpMethod.DELETE, `/webhooks/${webhookId}/`);
    await context.store.delete('signrequest_declined_webhook');
  },
  async run(context) {
    const body = context.payload.body as any;
    if (body.event_type !== 'declined') {
      return [];
    }
    return [context.payload.body];
  },
});
