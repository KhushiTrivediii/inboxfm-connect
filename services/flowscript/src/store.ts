import pg from 'pg'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { canonicalizeJson, type FlowIR } from './compiler.js'
import { redactSensitiveData } from './adapter.js'

const { Pool } = pg
const connectionString = process.env.DATABASE_URL
const defaultPool = new Pool(connectionString ? { connectionString } : {
  host: process.env.AP_POSTGRES_HOST ?? 'postgres',
  port: Number(process.env.AP_POSTGRES_PORT ?? 5432),
  database: process.env.AP_POSTGRES_DATABASE ?? 'activepieces',
  user: process.env.AP_POSTGRES_USERNAME ?? 'postgres',
  password: process.env.AP_POSTGRES_PASSWORD ?? 'postgres',
  max: Number(process.env.FLOWSCRIPT_DB_POOL_SIZE ?? 5),
})
let pool = defaultPool

export function setStorePool(customPool: pg.Pool | null): void {
  pool = customPool ?? defaultPool
}

export function getStorePool(): pg.Pool {
  return pool
}

export async function initializeStore(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flowscript_versions (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      flow_name text NOT NULL,
      version integer NOT NULL,
      source_text text NOT NULL,
      ir jsonb NOT NULL,
      ir_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(project_id, flow_name, version)
    );
    CREATE TABLE IF NOT EXISTS flowscript_deployments (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      flow_name text NOT NULL,
      environment text NOT NULL,
      version_id uuid NOT NULL REFERENCES flowscript_versions(id),
      status text NOT NULL CHECK (status IN ('active', 'disabled')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(project_id, flow_name, environment)
    );
    CREATE TABLE IF NOT EXISTS flowscript_triggers (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      flow_name text NOT NULL,
      environment text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('schedule', 'webhook')),
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      secret_hash text,
      enabled boolean NOT NULL DEFAULT true,
      next_fire_at timestamptz,
      last_fired_at timestamptz,
      dispatch_lag_ms bigint,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE flowscript_triggers ADD COLUMN IF NOT EXISTS dispatch_lag_ms bigint;
    ALTER TABLE flowscript_triggers ADD COLUMN IF NOT EXISTS last_error text;
    CREATE INDEX IF NOT EXISTS flowscript_triggers_due_idx ON flowscript_triggers(kind, next_fire_at) WHERE enabled=true;
    CREATE TABLE IF NOT EXISTS flowscript_runs (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      flow_name text NOT NULL,
      environment text NOT NULL,
      version_id uuid NOT NULL REFERENCES flowscript_versions(id),
      trigger_kind text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter', 'uncertain')),
      input jsonb NOT NULL DEFAULT '{}'::jsonb,
      output jsonb,
      steps jsonb,
      error text,
      worker_id text,
      lease_expires_at timestamptz,
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      retry_at timestamptz,
      cancellation_reason text,
      idempotency_key text,
      had_non_idempotent_step boolean NOT NULL DEFAULT false,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS worker_id text;
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3;
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS retry_at timestamptz;
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS cancellation_reason text;
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS idempotency_key text;
    ALTER TABLE flowscript_runs ADD COLUMN IF NOT EXISTS had_non_idempotent_step boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS flowscript_runs_project_created_idx ON flowscript_runs(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS flowscript_runs_lease_idx ON flowscript_runs(status, lease_expires_at) WHERE status='running';
    CREATE INDEX IF NOT EXISTS flowscript_runs_retry_idx ON flowscript_runs(status, retry_at) WHERE status='queued';
    CREATE UNIQUE INDEX IF NOT EXISTS flowscript_runs_idempotency_idx ON flowscript_runs(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS flowscript_step_attempts (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES flowscript_runs(id) ON DELETE CASCADE,
      step_id text NOT NULL,
      attempt integer NOT NULL DEFAULT 1,
      status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
      error_code text,
      error_message text,
      retryable boolean,
      duration_ms integer,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS flowscript_step_attempts_run_idx ON flowscript_step_attempts(run_id, started_at ASC);
    CREATE TABLE IF NOT EXISTS flowscript_webhook_idempotency (
      id uuid PRIMARY KEY,
      trigger_id uuid NOT NULL REFERENCES flowscript_triggers(id) ON DELETE CASCADE,
      idempotency_key text NOT NULL,
      run_id uuid NOT NULL REFERENCES flowscript_runs(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(trigger_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS flowscript_webhook_idempotency_created_idx ON flowscript_webhook_idempotency(created_at);
    CREATE TABLE IF NOT EXISTS flowscript_schedule_occurrences (
      id uuid PRIMARY KEY,
      trigger_id uuid NOT NULL REFERENCES flowscript_triggers(id) ON DELETE CASCADE,
      scheduled_instant timestamptz NOT NULL,
      run_id uuid REFERENCES flowscript_runs(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(trigger_id, scheduled_instant)
    );
    CREATE INDEX IF NOT EXISTS flowscript_sched_occurrences_idx ON flowscript_schedule_occurrences(scheduled_instant);
  `)
}

export async function publishFlow(projectId: string, source: string, ir: FlowIR, hash: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const latest = await client.query<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0)::int AS version FROM flowscript_versions WHERE project_id = $1 AND flow_name = $2',
      [projectId, ir.name],
    )
    const version = Math.max(ir.version, (latest.rows[0]?.version ?? 0) + 1)
    const id = randomUUID()
    const versionedIr = { ...ir, version }
    const { sourceHash, ...semantic } = versionedIr
    const versionedHash = version === ir.version
      ? hash
      : createHash('sha256').update(canonicalizeJson(semantic)).digest('hex')
    await client.query(
      'INSERT INTO flowscript_versions (id, project_id, flow_name, version, source_text, ir, ir_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, projectId, ir.name, version, source, JSON.stringify(versionedIr), versionedHash],
    )
    await client.query('COMMIT')
    return { id, projectId, name: ir.name, version, hash: versionedHash }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function deployFlow(projectId: string, flowName: string, versionId: string, environment: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const version = await client.query<{ flow_name: string }>(
      'SELECT flow_name FROM flowscript_versions WHERE id=$1 AND project_id=$2',
      [versionId, projectId],
    )
    if (!version.rowCount) throw new Error('Published flow version not found in this project')
    if (version.rows[0].flow_name !== flowName) {
      throw new Error(`Version "${versionId}" belongs to flow "${version.rows[0].flow_name}", not "${flowName}"`)
    }
    const id = randomUUID()
    await client.query(
      `INSERT INTO flowscript_deployments (id, project_id, flow_name, environment, version_id, status)
       VALUES ($1,$2,$3,$4,$5,'active')
       ON CONFLICT (project_id, flow_name, environment)
       DO UPDATE SET version_id=EXCLUDED.version_id, status='active', updated_at=now()`,
      [id, projectId, flowName, environment, versionId],
    )
    await client.query('COMMIT')
    return { projectId, flowName, environment, versionId, status: 'active' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getDeployedFlow(projectId: string, flowName: string, environment: string) {
  const result = await pool.query<{ id: string; ir: FlowIR; flow_name: string; environment: string }>(
    `SELECT v.id, v.ir, d.flow_name, d.environment
     FROM flowscript_deployments d JOIN flowscript_versions v ON v.id=d.version_id
     WHERE d.project_id=$1 AND d.flow_name=$2 AND d.environment=$3 AND d.status='active'`,
    [projectId, flowName, environment],
  )
  return result.rows[0] ?? null
}

export async function rollbackFlow(projectId: string, flowName: string, environment: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query<{ version_id: string }>(
      "SELECT version_id FROM flowscript_deployments WHERE project_id=$1 AND flow_name=$2 AND environment=$3 AND status='active'",
      [projectId, flowName, environment],
    )
    if (!current.rowCount) {
      throw new Error("No active deployment found for flow '" + flowName + "' in environment '" + environment + "'")
    }
    const currentVersion = await client.query<{ version: number }>(
      'SELECT version FROM flowscript_versions WHERE id=$1 AND project_id=$2',
      [current.rows[0].version_id, projectId],
    )
    const currentVersionNum = currentVersion.rows[0]?.version ?? 0

    const previous = await client.query<{ id: string; version: number }>(
      'SELECT id, version FROM flowscript_versions WHERE project_id=$1 AND flow_name=$2 AND version < $3 ORDER BY version DESC LIMIT 1',
      [projectId, flowName, currentVersionNum],
    )
    if (!previous.rowCount) {
      throw new Error("No previous version available to roll back flow '" + flowName + "' in environment '" + environment + "'")
    }

    const previousVersionId = previous.rows[0].id
    const previousVersionNum = previous.rows[0].version
    await client.query(
      'UPDATE flowscript_deployments SET version_id=$1, updated_at=now() WHERE project_id=$2 AND flow_name=$3 AND environment=$4',
      [previousVersionId, projectId, flowName, environment],
    )
    await client.query('COMMIT')
    return {
      projectId,
      flowName,
      environment,
      versionId: previousVersionId,
      version: previousVersionNum,
      rolledBackFromVersion: currentVersionNum,
      status: 'active',
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function computeBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxMs)
  }
  const exp = Math.pow(2, Math.max(0, attempt - 1)) * baseMs
  const jitter = 0.8 + Math.random() * 0.4
  return Math.min(maxMs, Math.floor(exp * jitter))
}

export async function createRun(params: {
  projectId: string
  flowName: string
  environment: string
  versionId: string
  input: Record<string, unknown>
  triggerKind: string
  idempotencyKey?: string
  maxAttempts?: number
}): Promise<{ id: string; duplicate?: boolean }> {
  if (params.idempotencyKey) {
    const existing = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM flowscript_runs WHERE project_id=$1 AND idempotency_key=$2',
      [params.projectId, params.idempotencyKey],
    )
    if (existing.rows[0]) {
      return { id: existing.rows[0].id, duplicate: true }
    }
  }

  const id = randomUUID()
  const maxAttempts = params.maxAttempts ?? 3

  try {
    await pool.query(
      `INSERT INTO flowscript_runs (id, project_id, flow_name, environment, version_id, trigger_kind, status, input, idempotency_key, max_attempts, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,NULL)`,
      [id, params.projectId, params.flowName, params.environment, params.versionId, params.triggerKind, JSON.stringify(params.input), params.idempotencyKey ?? null, maxAttempts],
    )
    return { id, duplicate: false }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && ('code' in err || 'message' in err)) {
      const e = err as { code?: string; message?: string }
      if (e.code === '23505' || String(e.message).includes('unique') || String(e.message).includes('flowscript_runs_idempotency_idx')) {
        if (params.idempotencyKey) {
          const existing = await pool.query<{ id: string }>(
            'SELECT id FROM flowscript_runs WHERE project_id=$1 AND idempotency_key=$2',
            [params.projectId, params.idempotencyKey],
          )
          if (existing.rows[0]) {
            return { id: existing.rows[0].id, duplicate: true }
          }
        }
      }
    }
    throw err
  }
}

export async function finishRun(
  id: string,
  result: {
    status: 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'dead_letter'
    output?: unknown
    steps: unknown[]
    error?: string
    cancellationReason?: string
  },
) {
  await pool.query(
    `UPDATE flowscript_runs
     SET status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE $2 END,
         output=$3, steps=$4, error=$5, cancellation_reason=COALESCE(cancellation_reason, $6), finished_at=now()
     WHERE id=$1`,
    [
      id,
      result.status,
      result.output === undefined ? null : JSON.stringify(result.output),
      JSON.stringify(result.steps),
      result.error ?? null,
      result.cancellationReason ?? null,
    ],
  )
}

export async function getRun(projectId: string, runId: string) {
  const result = await pool.query<{
    id: string
    flow_name: string
    environment: string
    version_id: string
    trigger_kind: string
    status: string
    input: Record<string, unknown>
    output: unknown | null
    steps: unknown[] | null
    error: string | null
    worker_id: string | null
    lease_expires_at: Date | null
    attempt_count: number
    max_attempts: number
    retry_at: Date | null
    cancellation_reason: string | null
    idempotency_key: string | null
    had_non_idempotent_step: boolean
    started_at: Date | null
    finished_at: Date | null
    created_at: Date
  }>(
    `SELECT id, flow_name, environment, version_id, trigger_kind, status, input, output, steps, error,
            worker_id, lease_expires_at, attempt_count, max_attempts, retry_at, cancellation_reason,
            idempotency_key, had_non_idempotent_step, started_at, finished_at, created_at
     FROM flowscript_runs WHERE project_id=$1 AND id=$2`,
    [projectId, runId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    flowName: row.flow_name,
    environment: row.environment,
    versionId: row.version_id,
    triggerKind: row.trigger_kind,
    status: row.status,
    input: row.input,
    output: row.output,
    steps: row.steps ?? [],
    error: row.error,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    retryAt: row.retry_at,
    cancellationReason: row.cancellation_reason,
    idempotencyKey: row.idempotency_key,
    hadNonIdempotentStep: row.had_non_idempotent_step,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }
}

export async function listRuns(projectId: string, flowName?: string, limit = 50) {
  const result = await pool.query<{
    id: string
    flow_name: string
    environment: string
    version_id: string
    trigger_kind: string
    status: string
    error: string | null
    worker_id: string | null
    attempt_count: number
    retry_at: Date | null
    cancellation_reason: string | null
    started_at: Date | null
    finished_at: Date | null
    created_at: Date
  }>(
    `SELECT id, flow_name, environment, version_id, trigger_kind, status, error, worker_id, attempt_count, retry_at, cancellation_reason, started_at, finished_at, created_at
     FROM flowscript_runs WHERE project_id=$1 AND ($2::text IS NULL OR flow_name=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [projectId, flowName ?? null, Math.min(Math.max(limit, 1), 100)],
  )
  return result.rows.map(row => ({
    id: row.id,
    flowName: row.flow_name,
    environment: row.environment,
    versionId: row.version_id,
    triggerKind: row.trigger_kind,
    status: row.status,
    error: row.error,
    workerId: row.worker_id,
    attemptCount: row.attempt_count,
    retryAt: row.retry_at,
    cancellationReason: row.cancellation_reason,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }))
}

export async function closeStore(): Promise<void> {
  await pool.end()
}

export async function claimQueuedRun(workerId: string = randomUUID(), leaseDurationMs: number = 30_000) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{
      id: string
      project_id: string
      flow_name: string
      ir: FlowIR
      input: Record<string, unknown>
      trigger_kind: string
      attempt_count: number
      max_attempts: number
    }>(
      `SELECT r.id, r.project_id, r.flow_name, v.ir, r.input, r.trigger_kind, r.attempt_count, r.max_attempts
       FROM flowscript_runs r JOIN flowscript_versions v ON v.id=r.version_id
       WHERE r.status='queued' AND (r.retry_at IS NULL OR r.retry_at <= now())
       ORDER BY r.created_at ASC
       LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
    )
    const row = result.rows[0]
    if (!row) {
      await client.query('COMMIT')
      return null
    }

    const nextAttempt = (row.attempt_count ?? 0) + 1
    const leaseExpires = new Date(Date.now() + leaseDurationMs)

    await client.query(
      `UPDATE flowscript_runs
       SET status='running', worker_id=$2, lease_expires_at=$3, attempt_count=$4, started_at=COALESCE(started_at, now()), retry_at=NULL
       WHERE id=$1`,
      [row.id, workerId, leaseExpires, nextAttempt],
    )
    await client.query('COMMIT')
    return {
      ...row,
      worker_id: workerId,
      attempt_count: nextAttempt,
      lease_expires_at: leaseExpires,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function heartbeatRun(
  runId: string,
  workerId: string,
  extensionMs: number = 30_000,
): Promise<{ active: boolean; cancelled: boolean }> {
  const nextLease = new Date(Date.now() + extensionMs)
  const result = await pool.query<{ status: string; cancellation_reason: string | null }>(
    `UPDATE flowscript_runs
     SET lease_expires_at=$3
     WHERE id=$1 AND worker_id=$2 AND status='running'
     RETURNING status, cancellation_reason`,
    [runId, workerId, nextLease],
  )
  if (result.rows.length === 0) {
    const check = await pool.query<{ status: string }>(
      'SELECT status FROM flowscript_runs WHERE id=$1',
      [runId],
    )
    const status = check.rows[0]?.status
    return { active: false, cancelled: status === 'cancelled' }
  }
  return { active: true, cancelled: false }
}

export type StaleRecoveryResult = {
  recoveredCount: number
  retried: string[]
  uncertain: string[]
  deadLettered: string[]
}

export async function recoverStaleRuns(options?: {
  defaultMaxAttempts?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
}): Promise<StaleRecoveryResult> {
  const defaultMaxAttempts = options?.defaultMaxAttempts ?? 3
  const baseBackoffMs = options?.baseBackoffMs ?? 1000
  const maxBackoffMs = options?.maxBackoffMs ?? 30000

  const client = await pool.connect()
  const result: StaleRecoveryResult = {
    recoveredCount: 0,
    retried: [],
    uncertain: [],
    deadLettered: [],
  }

  try {
    await client.query('BEGIN')
    const expired = await client.query<{
      id: string
      project_id: string
      attempt_count: number
      max_attempts: number | null
      had_non_idempotent_step: boolean
    }>(
      `SELECT id, project_id, attempt_count, max_attempts, had_non_idempotent_step
       FROM flowscript_runs
       WHERE status='running' AND lease_expires_at < now()
       FOR UPDATE SKIP LOCKED`,
    )

    for (const run of expired.rows) {
      result.recoveredCount++
      const maxAttempts = run.max_attempts ?? defaultMaxAttempts

      if (run.had_non_idempotent_step) {
        await client.query(
          `UPDATE flowscript_runs
           SET status='uncertain',
               error='Worker lease expired after non-idempotent step execution; marked uncertain to prevent duplicate external side effects. Operator intervention required.',
               finished_at=now()
           WHERE id=$1`,
          [run.id],
        )
        result.uncertain.push(run.id)
        console.warn(JSON.stringify({
          event: 'run_stale_uncertain',
          runId: run.id,
          projectId: run.project_id,
          reason: 'Non-idempotent step may have produced side effects before crash',
        }))
      } else if (run.attempt_count < maxAttempts) {
        const backoff = computeBackoff(run.attempt_count, baseBackoffMs, maxBackoffMs)
        const retryAt = new Date(Date.now() + backoff)
        await client.query(
          `UPDATE flowscript_runs
           SET status='queued',
               retry_at=$2,
               error='Worker lease expired; re-queued for retry',
               worker_id=NULL,
               lease_expires_at=NULL
           WHERE id=$1`,
          [run.id, retryAt],
        )
        result.retried.push(run.id)
        console.log(JSON.stringify({
          event: 'run_stale_retry_scheduled',
          runId: run.id,
          attempt: run.attempt_count,
          retryAt: retryAt.toISOString(),
          backoffMs: backoff,
        }))
      } else {
        await client.query(
          `UPDATE flowscript_runs
           SET status='dead_letter',
               error='Worker lease expired and maximum retry attempts exhausted',
               finished_at=now()
           WHERE id=$1`,
          [run.id],
        )
        result.deadLettered.push(run.id)
        console.error(JSON.stringify({
          event: 'run_dead_lettered',
          runId: run.id,
          attempts: run.attempt_count,
          error: 'Lease expired and max retry attempts exhausted',
        }))
      }
    }

    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function cancelRun(
  projectId: string,
  runId: string,
  reason = 'Cancelled by user',
): Promise<{ id: string; status: string } | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const check = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM flowscript_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
      [projectId, runId],
    )
    const run = check.rows[0]
    if (!run) {
      await client.query('COMMIT')
      return null
    }

    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'dead_letter' || run.status === 'uncertain') {
      await client.query('COMMIT')
      return { id: run.id, status: run.status }
    }

    if (run.status === 'queued') {
      await client.query(
        "UPDATE flowscript_runs SET status='cancelled', cancellation_reason=$2, finished_at=now() WHERE id=$1",
        [runId, reason],
      )
    } else if (run.status === 'running') {
      await client.query(
        "UPDATE flowscript_runs SET status='cancelled', cancellation_reason=$2 WHERE id=$1",
        [runId, reason],
      )
    }

    await client.query('COMMIT')
    return { id: run.id, status: 'cancelled' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function recordStepAttemptStart(params: {
  runId: string
  stepId: string
  attempt: number
}): Promise<string> {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO flowscript_step_attempts (id, run_id, step_id, attempt, status, started_at)
     VALUES ($1, $2, $3, $4, 'running', now())`,
    [id, params.runId, params.stepId, params.attempt],
  )
  return id
}

export async function recordStepAttemptFinish(
  attemptId: string,
  params: {
    status: 'succeeded' | 'failed' | 'skipped'
    errorCode?: string
    errorMessage?: string
    retryable?: boolean
    durationMs?: number
  },
): Promise<void> {
  const sanitizedMsg = params.errorMessage ? String(redactSensitiveData(params.errorMessage)) : null
  await pool.query(
    `UPDATE flowscript_step_attempts
     SET status=$2, error_code=$3, error_message=$4, retryable=$5, duration_ms=$6, finished_at=now()
     WHERE id=$1`,
    [attemptId, params.status, params.errorCode ?? null, sanitizedMsg, params.retryable ?? null, params.durationMs ?? 0],
  )
}

export async function markRunNonIdempotentStep(runId: string): Promise<void> {
  await pool.query(
    'UPDATE flowscript_runs SET had_non_idempotent_step=true WHERE id=$1',
    [runId],
  )
}

export async function listStepAttempts(runId: string): Promise<Array<{
  id: string
  runId: string
  stepId: string
  attempt: number
  status: string
  errorCode: string | null
  errorMessage: string | null
  retryable: boolean | null
  durationMs: number | null
  startedAt: Date
  finishedAt: Date | null
}>> {
  const res = await pool.query<{
    id: string
    run_id: string
    step_id: string
    attempt: number
    status: string
    error_code: string | null
    error_message: string | null
    retryable: boolean | null
    duration_ms: number | null
    started_at: Date
    finished_at: Date | null
  }>(
    'SELECT id, run_id, step_id, attempt, status, error_code, error_message, retryable, duration_ms, started_at, finished_at FROM flowscript_step_attempts WHERE run_id=$1 ORDER BY started_at ASC',
    [runId],
  )
  return res.rows.map(r => ({
    id: r.id,
    runId: r.run_id,
    stepId: r.step_id,
    attempt: r.attempt,
    status: r.status,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    retryable: r.retryable,
    durationMs: r.duration_ms,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }))
}

export async function markRunFailedBeforeStart(id: string, message: string) {
  await pool.query("UPDATE flowscript_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1 AND status='queued'", [id, message])
}

export function validateScheduleConfig(
  cron: string,
  timezone: string = 'UTC',
  options?: { missedTickPolicy?: string },
): { valid: true; nextFireAt: Date; cron: string; timezone: string; missedTickPolicy: 'run-once' | 'skip' | 'catch-up' } | { valid: false; error: string; path: 'cron' | 'timezone' | 'missedTickPolicy' } {
  const cleanCron = cron?.trim()
  if (!cleanCron) {
    return { valid: false, error: 'Cron expression is required', path: 'cron' }
  }

  const cleanTz = timezone?.trim() || 'UTC'
  try {
    Intl.DateTimeFormat(undefined, { timeZone: cleanTz })
  } catch {
    return { valid: false, error: `Invalid IANA timezone identifier: "${cleanTz}"`, path: 'timezone' }
  }

  let nextFireAt: Date
  try {
    const interval = CronExpressionParser.parse(cleanCron, { tz: cleanTz })
    nextFireAt = interval.next().toDate()
  } catch (err) {
    return {
      valid: false,
      error: `Invalid cron expression: "${cleanCron}" (${err instanceof Error ? err.message : 'parse error'})`,
      path: 'cron',
    }
  }

  const policy = options?.missedTickPolicy ?? 'run-once'
  if (policy !== 'run-once' && policy !== 'skip' && policy !== 'catch-up') {
    return {
      valid: false,
      error: `Invalid missedTickPolicy: "${policy}". Must be one of: run-once, skip, catch-up`,
      path: 'missedTickPolicy',
    }
  }

  return {
    valid: true,
    nextFireAt,
    cron: cleanCron,
    timezone: cleanTz,
    missedTickPolicy: policy,
  }
}

export async function createFlowTrigger(params: { projectId: string; flowName: string; environment: string; kind: 'schedule' | 'webhook'; config: Record<string, unknown> }) {
  const deployed = await getDeployedFlow(params.projectId, params.flowName, params.environment)
  if (!deployed) throw new Error('Flow must be deployed before adding a trigger')
  const id = randomUUID()
  if (params.kind === 'schedule') {
    const rawCron = String(params.config.cron ?? '')
    const rawTz = String(params.config.timezone ?? 'UTC')
    const rawPolicy = typeof params.config.missedTickPolicy === 'string' ? params.config.missedTickPolicy : undefined

    const validated = validateScheduleConfig(rawCron, rawTz, { missedTickPolicy: rawPolicy })
    if (!validated.valid) {
      throw new Error(validated.error)
    }

    const configToStore = {
      cron: validated.cron,
      timezone: validated.timezone,
      missedTickPolicy: validated.missedTickPolicy,
    }

    await pool.query(
      'INSERT INTO flowscript_triggers (id,project_id,flow_name,environment,kind,config,next_fire_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, params.projectId, params.flowName, params.environment, params.kind, JSON.stringify(configToStore), validated.nextFireAt],
    )
    return { id, kind: params.kind, flowName: params.flowName, environment: params.environment, nextFireAt: validated.nextFireAt, enabled: true, config: configToStore }
  }
  const token = randomBytes(32).toString('base64url')
  const secretHash = hashWebhookToken(token)
  await pool.query(
    'INSERT INTO flowscript_triggers (id,project_id,flow_name,environment,kind,config,secret_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, params.projectId, params.flowName, params.environment, params.kind, JSON.stringify(params.config), secretHash],
  )
  return { id, kind: params.kind, flowName: params.flowName, environment: params.environment, token, enabled: true }
}

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function enqueueDueSchedule(): Promise<{ enqueued: boolean; runId?: string; triggerId?: string } | boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const due = await client.query<{
      id: string
      project_id: string
      flow_name: string
      environment: string
      config: { cron: string; timezone?: string; missedTickPolicy?: 'run-once' | 'skip' | 'catch-up' }
      next_fire_at: Date
      last_fired_at: Date | null
    }>(
      `SELECT id, project_id, flow_name, environment, config, next_fire_at, last_fired_at FROM flowscript_triggers
       WHERE kind='schedule' AND enabled=true AND next_fire_at <= now()
       ORDER BY next_fire_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
    const trigger = due.rows[0]
    if (!trigger) {
      await client.query('COMMIT')
      return false
    }

    const scheduledInstant = trigger.next_fire_at
    const lagMs = Math.max(0, Date.now() - new Date(scheduledInstant).getTime())

    const cron = trigger.config.cron
    const tz = trigger.config.timezone || 'UTC'
    const policy = trigger.config.missedTickPolicy || 'run-once'

    // For 'skip' policy, if current time has passed beyond the scheduled interval, omit the missed tick
    let shouldEnqueue = true
    if (policy === 'skip') {
      try {
        const nextOccurrence = CronExpressionParser.parse(cron, { currentDate: new Date(scheduledInstant), tz }).next().toDate()
        if (Date.now() >= nextOccurrence.getTime()) {
          shouldEnqueue = false
        }
      } catch {
        // Cron parsing error will be caught and recorded below
      }
    }

    // Atomically claim this occurrence instant to ensure only one worker enqueues it
    const occId = randomUUID()
    const claimResult = await client.query<{ id: string }>(
      `INSERT INTO flowscript_schedule_occurrences (id, trigger_id, scheduled_instant)
       VALUES ($1, $2, $3)
       ON CONFLICT (trigger_id, scheduled_instant) DO NOTHING
       RETURNING id`,
      [occId, trigger.id, scheduledInstant],
    )

    let createdRunId: string | undefined
    let deploymentError: string | undefined

    if (claimResult.rows[0]) {
      if (shouldEnqueue) {
        const deployed = await client.query<{ version_id: string }>(
          "SELECT version_id FROM flowscript_deployments WHERE project_id=$1 AND flow_name=$2 AND environment=$3 AND status='active'",
          [trigger.project_id, trigger.flow_name, trigger.environment],
        )

        if (deployed.rows[0]) {
          createdRunId = randomUUID()
          await client.query(
            `INSERT INTO flowscript_runs (id,project_id,flow_name,environment,version_id,trigger_kind,status,input)
             VALUES ($1,$2,$3,$4,$5,'schedule','queued','{}'::jsonb)`,
            [createdRunId, trigger.project_id, trigger.flow_name, trigger.environment, deployed.rows[0].version_id],
          )

          await client.query(
            'UPDATE flowscript_schedule_occurrences SET run_id=$1 WHERE id=$2',
            [createdRunId, occId],
          )
        } else {
          deploymentError = `No active deployment for flow "${trigger.flow_name}" in environment "${trigger.environment}"`
        }
      }
    } else {
      console.log(JSON.stringify({
        event: 'schedule_claim_lost',
        triggerId: trigger.id,
        flowName: trigger.flow_name,
        scheduledInstant: new Date(scheduledInstant).toISOString(),
      }))
    }

    // Advance next_fire_at according to missedTickPolicy
    let nextFireAt: Date
    try {
      // For 'run-once' or 'skip', advance from now() so downtime does not cascade into a tick storm
      const baseDate = policy === 'catch-up' ? new Date(scheduledInstant) : new Date()
      nextFireAt = CronExpressionParser.parse(cron, { currentDate: baseDate, tz }).next().toDate()
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : 'Cron parse error'
      await client.query(
        'UPDATE flowscript_triggers SET last_error=$2, enabled=false WHERE id=$1',
        [trigger.id, errorMsg],
      )
      console.error(JSON.stringify({
        event: 'schedule_dispatch_failed',
        triggerId: trigger.id,
        flowName: trigger.flow_name,
        error: errorMsg,
      }))
      await client.query('COMMIT')
      return false
    }

    const finalError = deploymentError ?? null
    await client.query(
      'UPDATE flowscript_triggers SET last_fired_at=now(), next_fire_at=$2, dispatch_lag_ms=$3, last_error=$4 WHERE id=$1',
      [trigger.id, nextFireAt, lagMs, finalError],
    )

    if (claimResult.rows[0]) {
      console.log(JSON.stringify({
        event: 'schedule_dispatched',
        triggerId: trigger.id,
        flowName: trigger.flow_name,
        lagMs,
        nextFireAt: nextFireAt.toISOString(),
        runId: createdRunId,
        policy,
        omitted: !shouldEnqueue,
      }))
    }

    await client.query('COMMIT')
    return { enqueued: Boolean(createdRunId), runId: createdRunId, triggerId: trigger.id }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function enqueueWebhook(
  token: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ runId: string; duplicate: boolean } | null> {
  const secretHash = hashWebhookToken(token)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{ id: string; project_id: string; flow_name: string; environment: string }>(
      "SELECT id, project_id, flow_name, environment FROM flowscript_triggers WHERE kind='webhook' AND enabled=true AND secret_hash=$1",
      [secretHash],
    )
    const trigger = result.rows[0]
    if (!trigger) {
      await client.query('COMMIT')
      return null
    }

    const deployedRes = await client.query<{ version_id: string }>(
      "SELECT version_id FROM flowscript_deployments WHERE project_id=$1 AND flow_name=$2 AND environment=$3 AND status='active'",
      [trigger.project_id, trigger.flow_name, trigger.environment],
    )
    const deployed = deployedRes.rows[0]
    if (!deployed) {
      await client.query('COMMIT')
      return null
    }

    if (idempotencyKey && idempotencyKey.trim().length > 0) {
      const cleanKey = idempotencyKey.trim().slice(0, 256)
      const existingIdemp = await client.query<{ run_id: string }>(
        'SELECT run_id FROM flowscript_webhook_idempotency WHERE trigger_id=$1 AND idempotency_key=$2',
        [trigger.id, cleanKey],
      )
      if (existingIdemp.rows[0]) {
        await client.query('COMMIT')
        return { runId: existingIdemp.rows[0].run_id, duplicate: true }
      }

      const runId = randomUUID()
      await client.query(
        `INSERT INTO flowscript_runs (id,project_id,flow_name,environment,version_id,trigger_kind,status,input)
         VALUES ($1,$2,$3,$4,$5,'webhook','queued',$6)`,
        [runId, trigger.project_id, trigger.flow_name, trigger.environment, deployed.version_id, JSON.stringify(input)],
      )

      const insertIdemp = await client.query<{ run_id: string }>(
        `INSERT INTO flowscript_webhook_idempotency (id, trigger_id, idempotency_key, run_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (trigger_id, idempotency_key) DO NOTHING
         RETURNING run_id`,
        [randomUUID(), trigger.id, cleanKey, runId],
      )

      if (!insertIdemp.rows[0]) {
        // Race condition: another concurrent delivery inserted first
        const winner = await client.query<{ run_id: string }>(
          'SELECT run_id FROM flowscript_webhook_idempotency WHERE trigger_id=$1 AND idempotency_key=$2',
          [trigger.id, cleanKey],
        )
        await client.query('ROLLBACK')
        return { runId: winner.rows[0]?.run_id ?? runId, duplicate: true }
      }

      await client.query('COMMIT')
      return { runId, duplicate: false }
    }

    const runId = randomUUID()
    await client.query(
      `INSERT INTO flowscript_runs (id,project_id,flow_name,environment,version_id,trigger_kind,status,input)
       VALUES ($1,$2,$3,$4,$5,'webhook','queued',$6)`,
      [runId, trigger.project_id, trigger.flow_name, trigger.environment, deployed.version_id, JSON.stringify(input)],
    )
    await client.query('COMMIT')
    return { runId, duplicate: false }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function listFlowTriggers(projectId: string, flowName: string) {
  const result = await pool.query<{
    id: string
    flow_name: string
    environment: string
    kind: 'schedule' | 'webhook'
    config: Record<string, unknown>
    enabled: boolean
    next_fire_at: Date | null
    last_fired_at: Date | null
    dispatch_lag_ms: number | null
    last_error: string | null
    created_at: Date
  }>(
    'SELECT id, flow_name, environment, kind, config, enabled, next_fire_at, last_fired_at, dispatch_lag_ms, last_error, created_at FROM flowscript_triggers WHERE project_id=$1 AND flow_name=$2 ORDER BY created_at ASC',
    [projectId, flowName],
  )
  return result.rows.map(row => ({
    id: row.id,
    flowName: row.flow_name,
    environment: row.environment,
    kind: row.kind,
    config: row.config,
    enabled: row.enabled,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    dispatchLagMs: row.dispatch_lag_ms,
    lastError: row.last_error,
    createdAt: row.created_at,
  }))
}

export async function updateFlowTrigger(
  projectId: string,
  flowName: string,
  triggerId: string,
  updates: { enabled?: boolean },
): Promise<{ id: string; flowName: string; enabled: boolean } | null> {
  if (typeof updates.enabled !== 'boolean') return null
  const result = await pool.query<{ id: string; flow_name: string; enabled: boolean }>(
    'UPDATE flowscript_triggers SET enabled=$4 WHERE id=$1 AND project_id=$2 AND flow_name=$3 RETURNING id, flow_name, enabled',
    [triggerId, projectId, flowName, updates.enabled],
  )
  const row = result.rows[0]
  return row ? { id: row.id, flowName: row.flow_name, enabled: row.enabled } : null
}

export async function deleteFlowTrigger(
  projectId: string,
  flowName: string,
  triggerId: string,
): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM flowscript_triggers WHERE id=$1 AND project_id=$2 AND flow_name=$3',
    [triggerId, projectId, flowName],
  )
  return (result.rowCount ?? 0) > 0
}

export async function rotateWebhookTriggerToken(
  projectId: string,
  flowName: string,
  triggerId: string,
): Promise<{ id: string; flowName: string; token: string } | null> {
  const newToken = randomBytes(32).toString('base64url')
  const newSecretHash = hashWebhookToken(newToken)
  const result = await pool.query<{ id: string; flow_name: string }>(
    `UPDATE flowscript_triggers
     SET secret_hash=$4
     WHERE id=$1 AND project_id=$2 AND flow_name=$3 AND kind='webhook'
     RETURNING id, flow_name`,
    [triggerId, projectId, flowName, newSecretHash],
  )
  const row = result.rows[0]
  return row ? { id: row.id, flowName: row.flow_name, token: newToken } : null
}
