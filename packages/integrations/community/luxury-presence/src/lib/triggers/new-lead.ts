import { createTrigger, TriggerStrategy } from '@inboxfm-connect/pieces-framework';
import { luxuryPresenceAuth } from '../common/auth';
import { httpClient, HttpMethod } from '@inboxfm-connect/pieces-common';
const LUXURY_PRESENCE_API_BASE = 'https://api.luxurypresence.com/crm/v1';

type LeadsWebhookPayload = {
  eventName?: string;
  companyId?: string;
  data?: {
    isNewLead?: boolean;
  };
};

export const newLead = createTrigger({
  auth: luxuryPresenceAuth,
  name: 'newLead',
  displayName: 'New Lead',
  description:
    'Triggers when a new lead is registered in Luxury Presence. The `leads` subscription delivers every lead activity (listing views, favorites, saved searches, sign-ups, contact inquiries, ...), so this trigger only emits deliveries flagged `isNewLead: true`.',
  aiMetadata: {
    description:
      'Fires when a new lead is registered into Luxury Presence (a `leads` webhook delivery flagged `isNewLead: true`). New leads arrive from many capture channels — account sign-up, contact form inquiry, home valuation request, newsletter, e-book download, referral, ... The payload contains the lead record from the Luxury Presence CRM together with the activity that produced it.',
  },
  props: {},
  sampleData: {
    eventName: 'leads',
    companyId: '17g498eh-5b11-4d1c-8448-cb06ef213730',
    data: {
      leadId: '1d53e414-c8ad-49b8-9e23-2046f846d3d9',
      leadEmail: 'buyer@gmail.com',
      leadFirstName: 'Fluffy',
      leadLastName: 'Trang',
      leadPhoneNumber: '(718) 555-5555',
      leadSource: 'CONTACT_INQUIRY',
      leadOrigin: 'CLIENT_WEBSITE',
      activityType: 'CONTACT_INQUIRY',
      activityListingId: 'b8fb82d6-03f4-42f3-ab57-526493b60949',
      activityAction: 'CONTACT_INQUIRY',
      activityMessage: '',
      activityListingMlsId: 'RLS30036941',
      activityListingAddress: '52 JANE Street 20',
      activityListingCity: 'New York City',
      activityListingState: 'NY',
      activityListingZip: '10014',
      activitySourceUrl:
        'p-110e844c-6254-4378-a176-f04ed117be61.staging.presencepreview.site/home-search/listings/b8fb82d6-03f4-42f3-ab57-526493b60949',
      assignedAgents: [
        { firstName: '', lastName: '', email: 'jane.doe@example.com', mlsAgentId: '' },
      ],
      assignedAgent: { firstName: '', lastName: '', email: 'jane.doe@example.com', mlsAgentId: '' },
      isNewLead: true,
      newPhoneNumber: false,
      companyName: 'The Aster Group',
    },
  },
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    const apiKey = context.auth.secret_text;

    const url = `${LUXURY_PRESENCE_API_BASE}/webhooks`;

    const resp = await httpClient.sendRequest({
      method: HttpMethod.POST,
      url,
      headers: {
        // LP requires the API key in the `x-api-key` header, not a Bearer
        // token: https://docs.luxurypresence.com/docs/getting-started
        // ("You must specify your API key in the request header as `x-api-key`")
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: {
        name: 'ActivePieces New Lead Webhook',
        url: context.webhookUrl,
        events: ['leads'],
      },
    });

    const body = await resp.body;

    await context.store.put('webhook_id', body.id);
  },
  async onDisable(context) {
    const apiKey = context.auth.secret_text;

    const webhookId = (await context.store.get('webhook_id')) as string | null;

    if (webhookId) {
      const deleteUrl = `${LUXURY_PRESENCE_API_BASE}/webhooks/${encodeURIComponent(
        webhookId
      )}`;
      await httpClient.sendRequest({
        method: HttpMethod.DELETE,
        url: deleteUrl,
        headers: {
          // LP requires the API key in the `x-api-key` header, not a Bearer
          // token: https://docs.luxurypresence.com/docs/getting-started
          // ("You must specify your API key in the request header as `x-api-key`")
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
      });
    }
    await context.store.delete('webhook_id');
  },
  async run(context) {
    const payload = context.payload.body as LeadsWebhookPayload;
    if (payload?.eventName !== 'leads') {
      return [];
    }
    // The `leads` subscription delivers every lead activity — VIEW_LISTING is
    // the highest-volume type and the events array cannot filter by activity
    // type, so the handler itself must filter
    // (https://docs.luxurypresence.com/reference/webhookcontroller_createwebhook).
    // `isNewLead` is optional in deliveries and its absence is not equivalent
    // to false, so only deliveries explicitly flagged `isNewLead: true` are
    // treated as new leads.
    if (payload.data?.isNewLead !== true) {
      return [];
    }
    return [payload];
  },
});

