# Scheduler

## Summary
`@inboxfm-connect/scheduler` provides process-local one-shot, interval, and cron tasks. Registering the same cron name cancels the old task synchronously before replacement. It does not persist tasks or provide a distributed execution guarantee.

`cronParser` validates five/six-field cron expressions and computes the next instant in an IANA timezone. It accepts zero-padded fields, handles DST gaps/overlaps, and advances unmatched dates by local calendar boundaries rather than fixed 24-hour durations.

## Key Files
- `packages/scheduler/src/local-scheduler.ts` — registration, cancellation, error callbacks, and shutdown
- `packages/scheduler/src/cron-parser.ts` — parsing, validation, and next-tick calculation
- `packages/scheduler/test/` — deterministic lifecycle, concurrency, and timezone regression tests
- `packages/server/api/test/integration/ce/execution/scheduled-trigger-flow-execution.test.ts` — API lifecycle and execution persistence coverage

## Edition Availability
The scheduler library is available to all editions. Calling application modules remain responsible for project/platform ownership, persisted restoration, and multi-server deduplication.

## Domain Terms
- **Task name** — the identifier used to replace/cancel a recurring local task
- **Next tick** — the next chronological instant matching a cron expression in a timezone
- **Recovery** — optional dispatch of ticks missed while the process was paused; disabled by default
