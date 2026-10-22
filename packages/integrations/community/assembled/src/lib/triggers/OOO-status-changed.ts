import { createTrigger, TriggerStrategy } from '@inboxfm-connect/pieces-framework';
import { assembledCommon } from '../common';
import { HttpMethod } from '@inboxfm-connect/pieces-common';
import { assembledAuth } from '../common/auth';

export const timeOffStatusChanged = createTrigger({
  auth: assembledAuth,
  name: 'OOO_status_changed',
  displayName: 'OOO Status Changed',
  description: 'Triggers on approval/rejection of OOO.',
  aiMetadata: {
    description: 'Fires when an existing time-off (out-of-office) request changes status, such as being approved or rejected, polling for time-off updates since the last check. Use to react to decisions on submitted OOO requests.',
  },
  type: TriggerStrategy.POLLING,
  props: {},
  sampleData: {
    id: '<uuid>',
    time_off_request_id: '<uuid>',
    created_at: 1546303260,
    comment: 'Enjoy your vacation',
    type: 'approve',
    time_off_request: {
      id: '<uuid>',
      agent_id: '<uuid>',
      start_time: 1546303260,
      end_time: 1546303270,
      created_at: 1546303260,
      description: 'Going to the dentist',
      status: 'approved',
      activity_type_id: '<uuid>'
    }
  },
  async onEnable(context) {
    await context.store.put('lastStatusCheck', Math.floor(Date.now() / 1000));
  },
  async onDisable() {
    // No cleanup needed
  },
  async run(context) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lastCheck =
      (await context.store.get<number>('lastStatusCheck')) ||
      nowSeconds - 86400; // 24 hours ago in Unix seconds

    // GET /v0/time_off/updates accepts an optional type filter with values
    // approve, edit, deny, cancel (docs.assembled.com). The trigger fires on
    // approvals and rejections, so fetch everything since the last check and
    // keep only "approve" and "deny" updates instead of filtering the request
    // to type=approve, which silently dropped rejections.
    const response = await assembledCommon.makeRequest(
      context.auth.secret_text,
      HttpMethod.GET,
      `/time_off/updates?updated_since=${lastCheck}`
    );

    // Handle the documented response structure
    const timeOffUpdates = Object.values(
      (response.body.time_off_updates ?? {}) as Record<
        string,
        { time_off_request_id: string; type?: string } & Record<string, unknown>
      >
    );
    const timeOffRequests = (response.body.time_off_requests ?? {}) as Record<
      string,
      unknown
    >;

    // Transform the response to include both update and request data
    const statusChanges = timeOffUpdates
      .filter(
        (update) => update.type === 'approve' || update.type === 'deny'
      )
      .map((update) => ({
        ...update,
        time_off_request: timeOffRequests[update.time_off_request_id],
      }));

    if (timeOffUpdates.length > 0) {
      await context.store.put('lastStatusCheck', nowSeconds);
    }

    return statusChanges;
  },
});
