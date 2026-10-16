import { createAction, Property } from '@inboxfm-connect/pieces-framework';
import { httpClient, HttpMethod } from '@inboxfm-connect/pieces-common';
import { devinAuth } from '../..';

export const sendMessage = createAction({
  name: 'send_message',
  displayName: 'Send Message',
  description: 'Sends a message to a Devin session',
  audience: 'both',
  aiMetadata: { description: 'Posts a message into an existing Devin session to give it further instructions, context, or follow-up requests. Use this to continue a conversation with an already-running session rather than starting a new one. Requires the target session id and message text; not idempotent, as each call appends a new message.', idempotent: false },
  auth: devinAuth,
  props: {
    sessionId: Property.ShortText({
      displayName: 'Session ID',
      required: true,
      description: 'The ID of the session to send the message to',
    }),
    message: Property.LongText({
      displayName: 'Message',
      required: true,
      description: 'The message to send to the session',
    }),
  },
  async run({ auth, propsValue }) {
    const response = await httpClient.sendRequest({
      method: HttpMethod.POST,
      // v1 endpoint is POST /v1/sessions/{session_id}/message (singular
      // "message"): https://docs.devin.ai/api-reference/v1/sessions/send-a-message-to-an-existing-devin-session
      // The previous /v1/session/{id}/messages path 404s (no such route).
      url: `https://api.devin.ai/v1/sessions/${propsValue.sessionId}/message`,
      headers: {
        Authorization: `Bearer ${auth.secret_text}`,
      },
      body: {
        message: propsValue.message,
      },
    });
    return response.body;
  },
});

