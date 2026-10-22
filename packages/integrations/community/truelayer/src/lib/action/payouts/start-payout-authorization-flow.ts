
import { httpClient, HttpMethod } from '@inboxfm-connect/pieces-common';
import { createAction, OAuth2PropertyValue, Property } from '@inboxfm-connect/pieces-framework';
import { trueLayerCommon } from '../../common';

export const startPayoutAuthorizationFlow = createAction({
  auth: trueLayerCommon.auth,
  name: 'start-payout-authorization-flow',
  displayName: 'Start authorization flow',
  description: 'Start the authorization flow for a payout. This API can be called using the `resource_token` associated with the payout you are trying to fetch.',
  audience: 'both',
  aiMetadata: { description: 'Begin the authorization flow for an existing payout identified by its ID, transitioning it toward execution. Use after creating a payout that requires authorization; this advances payout state and is not idempotent. To create the payout first, use Create Payout.', idempotent: false },
  props: {
    id: Property.ShortText({
      displayName: 'ID of the payout',
      required: true,
    }),
  },
  run: async (ctx) => {
    const response = await  httpClient.sendRequest({
      method: HttpMethod.POST,
      url: `${trueLayerCommon.baseUrl}/v3/payouts/${ctx.propsValue.id}/authorization-flow`,
      headers: {
        Authorization: `Bearer ${(ctx.auth as OAuth2PropertyValue).access_token}`,
      },
      body: ctx.propsValue,
    })

    return response.body;
  },
});
