import {
  createTrigger,
  Property,
  TriggerStrategy,
} from '@inboxfm-connect/pieces-framework';
import { assertNotNullOrUndefined } from '@inboxfm-connect/pieces-framework';
import { nanoid } from 'nanoid';
import { figmaCommon } from '../common';
import { figmaWebhookPostRequest, figmaDeleteRequest } from '../common/utils';
import {
  FigmaWebhookData,
  createWebhookTriggerKey,
  verifyFigmaWebhookRequest,
} from '../common/webhook';
import { figmaAuth } from '../auth';

const TRIGGER_DATA_STORE_KEY = createWebhookTriggerKey('new_comment');

export const newCommentTrigger = createTrigger({
  auth: figmaAuth,
  name: 'new_comment',
  displayName: 'New Comment (Figma Professional plan only)',
  description: 'Triggers when a new comment is posted',
  aiMetadata: {
    description: 'Fires when a new comment is posted on any file within the specified Figma team (subscribes to the team-level FILE_COMMENT webhook event). Requires a Figma Professional plan.',
  },
  type: TriggerStrategy.WEBHOOK,
  sampleData: [
    {
      id: '12345',
      team_id: '1234567890',
      event_type: 'FILE_COMMENT',
      client_id: null,
      endpoint: 'http://localhost:1234/webhook',
      passcode: 'figma-passcode',
      status: 'ACTIVE',
      description: null,
      protocol_version: '2',
    },
  ],
  props: {
    team_id: Property.ShortText({
      displayName: 'Team ID',
      description:
        'Naviate to team page, copy the Id from the URL after the word team/',
      required: true,
    }),
  },

  async onEnable(context): Promise<void> {
    const token = context.auth.access_token;
    const teamId = context.propsValue['team_id'];

    assertNotNullOrUndefined(token, 'token');
    assertNotNullOrUndefined(teamId, 'teamId');

    const url = `${figmaCommon.baseUrl}/${figmaCommon.webhooks}`;
    const eventType = 'FILE_COMMENT';
    const passcode = `figma_passcode_${nanoid()}`;
    const endpoint = context.webhookUrl;

    const { response_body } = await figmaWebhookPostRequest({
      token,
      url,
      eventType,
      teamId,
      endpoint,
      passcode,
    });

    await context.store?.put<FigmaWebhookData>(TRIGGER_DATA_STORE_KEY, {
      webhookId: response_body['id'],
      passcode,
    });
  },

  async onDisable(context): Promise<void> {
    const token = context.auth.access_token;

    assertNotNullOrUndefined(token, 'token');

    const triggerData = await context.store?.get<FigmaWebhookData>(
      TRIGGER_DATA_STORE_KEY
    );
    if (triggerData !== null && triggerData !== undefined) {
      const url = `${figmaCommon.baseUrl}/${figmaCommon.webhook}`.replace(
        ':webhook_id',
        triggerData.webhookId
      );
      await figmaDeleteRequest({ token, url });
    }
  },

  async run(context) {
    await verifyFigmaWebhookRequest(context, 'new_comment');

    const payloadBody = context.payload.body as Record<string, unknown>;
    if ('event_type' in payloadBody && payloadBody['event_type'] === 'PING') {
      return [];
    }
    return [payloadBody];
  },
});

