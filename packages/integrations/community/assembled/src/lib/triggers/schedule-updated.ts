import { createTrigger, TriggerStrategy } from '@inboxfm-connect/pieces-framework';
import { assembledCommon } from '../common';
import { HttpMethod } from '@inboxfm-connect/pieces-common';
import { assembledAuth } from '../common/auth';

export const scheduleUpdated = createTrigger({
  auth: assembledAuth,
  name: 'schedule_updated',
  displayName: 'Schedule Updated',
  description: 'Triggers when user schedule is modified.',
  aiMetadata: {
    description: "Fires when a user's schedule changes in Assembled (for example a shift added, modified, or removed), polling the event changes endpoint for schedule modifications since the last check. Use to react to scheduling changes such as added or edited shifts.",
  },
  type: TriggerStrategy.POLLING,
  props: {},
  sampleData: {
    id: '<uuid>',
    event_id: '<uuid>',
    modified_by: {
      name: 'John Smith',
      id: '<uuid>',
      email: 'john.smith@example.com',
    },
    modified_at: 1665954677,
    event_agent_name: 'Jane Doe',
    event_agent_id: '<uuid>',
    event_agent_email: 'jane.doe@example.com',
    event_change_type: 'modify',
    description: 'Events Edited and Published',
    old_start_time: 1665702700,
    old_end_time: 1665727300,
    new_start_time: 1665703700,
    new_end_time: 1665715900,
  },
  async onEnable(context) {
    await context.store.put('lastScheduleCheck', Math.floor(Date.now() / 1000));
  },
  async onDisable() {
    // Cleanup if needed
  },
  async run(context) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lastCheck =
      (await context.store.get<number>('lastScheduleCheck')) ||
      nowSeconds - 3600; // 1 hour ago in Unix seconds

    // Assembled exposes schedule modifications through GET /v0/event_changes,
    // which takes required Unix-seconds start_time/end_time bounds and returns
    // an event_changes map (docs.assembled.com — Event changes).
    const response = await assembledCommon.makeRequest(
      context.auth.secret_text,
      HttpMethod.GET,
      `/event_changes?start_time=${lastCheck}&end_time=${nowSeconds}&limit=100`
    );

    const eventChanges = Object.values(
      (response.body.event_changes ?? {}) as Record<string, unknown>
    );

    if (eventChanges.length > 0) {
      await context.store.put('lastScheduleCheck', nowSeconds);
    }

    return eventChanges;
  },
});
