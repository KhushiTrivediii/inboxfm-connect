# @inboxfm-connect/scheduler

In-process task scheduling and cron evaluation engine for `@inboxfm-connect`.

## Features

- **Lifecycle Execution**: One-shot timeouts (`once`), fixed intervals (`every`), and recurring cron schedules (`cron`).
- **Cron Parsing & Validation**: Fast 5-field and 6-field standard cron parsing supporting ranges (`1-5`), steps (`*/15`, `1-10/2`), lists (`1,15,30`), wildcards (`*`), and month/day names (`JAN-DEC`, `SUN-SAT`).
- **DST-Aware Next-Tick Computation**: Next-tick calculation powered by `Intl.DateTimeFormat` across all IANA timezones with full Daylight Saving Time (DST) edge-case resolution (spring-forward gap skipping and fall-back chronological ordering).
- **Error Isolation & Recovery**: Synchronous exceptions and async promise rejections inside task handlers are caught and dispatched to `onError` without crashing the process or breaking recurring schedules.
- **Missed-Tick Execution Policy**: Documented and locked missed-tick behavior preventing thundering-herd duplicate executions.

---

## API Reference

### `scheduler` / `LocalScheduler`

```ts
import { scheduler } from '@inboxfm-connect/scheduler'

// 1. One-shot timeout
const onceId = await scheduler.once({
    name: 'cleanup-session',
    delayMs: 5000,
    fn: async () => {
        await doCleanup()
    },
    onError: ({ id, name, error }) => {
        logger.error(`Task ${name} failed:`, error)
    },
})

// 2. Fixed interval
const intervalId = await scheduler.every({
    name: 'poll-metrics',
    intervalMs: 60000,
    fn: () => {
        collectMetrics()
    },
})

// 3. Recurring cron
const cronId = await scheduler.cron({
    name: 'nightly-report',
    cronExpression: '0 2 * * *',
    timezone: 'America/New_York',
    recoverMissedExecutions: false, // default: skip missed ticks
    fn: async () => {
        await generateReport()
    },
    onError: ({ id, name, error }) => {
        logger.error(`Cron ${name} error:`, error)
    },
})

// 4. Cancel a task
await scheduler.cancel(cronId)

// 5. Clean shutdown
await scheduler.shutdown()
```

### Utilities

```ts
import { cronParser } from '@inboxfm-connect/scheduler'

// Validation
const isValid = cronParser.validateCronExpression('*/15 * * * *') // true

// Parsing
const schedule = cronParser.parseCronExpression('0 9 * * 1-5')

// Next-tick computation (DST-safe)
const nextDate = cronParser.computeNextTick({
    cronExpression: '30 2 * * *',
    fromDate: new Date('2026-03-08T00:00:00Z'),
    timezone: 'America/New_York',
})
```

---

## Missed-Tick Policy & Behavior (Locked)

When a node process experiences event loop lag, system sleep, container pause, or CPU throttling:

1. **Default Policy (`recoverMissedExecutions: false`)**:
   - The scheduler compares the current clock time against the next scheduled tick.
   - Any execution ticks that elapsed while the process was paused are **skipped**.
   - The scheduler locks onto the current second and only fires triggers that match from the current time forward.
   - **Rationale**: Prevents thundering-herd storms of duplicate flow executions or webhook floods after a process resumes from a delay or restart.

2. **Catch-Up Policy (`recoverMissedExecutions: true`)**:
   - If explicitly opted-in, missed seconds during lag are scanned and each missed execution is dispatched sequentially up to the current time.

3. **Re-Registration Semantics**:
   - Registering a cron task with an existing `name` automatically cancels the previously active task under that name before scheduling the new one. This ensures idempotent schedule updates when flow triggers or scheduled tasks are edited.

---

## Daylight Saving Time (DST) & Timezone Semantics

`computeNextTick` resolves cron schedules in any target IANA timezone:

- **Spring-Forward (Gap Hour)**:
  - When local clocks jump ahead (e.g. from 01:59:59 to 03:00:00 in `America/New_York` during spring forward), the hour between 02:00:00 and 02:59:59 does not exist on that date.
  - A cron expression set for `30 2 * * *` will not match any instant on that day.
  - `computeNextTick` safely advances past the non-existent window to the next chronological match (02:30:00 on the following day), preventing infinite loops or date corruption.

- **Fall-Back (Overlap Hour)**:
  - When local clocks fall back (e.g. from 02:00:00 to 01:00:00 in `America/New_York` during fall back), the hour from 01:00:00 to 01:59:59 occurs twice (once in EDT, once in EST).
  - Chronological iteration ensures both occurrences are matched in strict temporal order without stalls or duplicate skips.
