import pg from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import type { FlowIR } from './compiler.js'

const { Pool } = pg
const connectionString = process.env.DATABASE_URL
const pool = new Pool(connectionString ? { connectionString } : {
  host: process.env.AP_POSTGRES_HOST ?? 'postgres',
  port: Number(process.env.AP_POSTGRES_PORT ?? 5432),
  database: process.env.AP_POSTGRES_DATABASE ?? 'activepieces',
  user: process.env.AP_POSTGRES_USERNAME ?? 'postgres',
  password: process.env.AP_POSTGRES_PASSWORD ?? 'postgres',
  max: Number(process.env.FLOWSCRIPT_DB_POOL_SIZE ?? 5),
})

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
    CREATE TABLE IF NOT EXISTS flowscript_runs (
      id uuid PRIMARY KEY,
      project_id text NOT NULL,
      flow_name text NOT NULL,
      environment text NOT NULL,
      version_id uuid NOT NULL REFERENCES flowscript_versions(id),
      trigger_kind text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      input jsonb NOT NULL DEFAULT '{}'::jsonb,
      output jsonb,
      steps jsonb,
      error text,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS flowscript_runs_project_created_idx ON flowscript_runs(project_id, created_at DESC);
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
    const versionedHash = createHash('sha256').update(JSON.stringify(versionedIr)).digest('hex')
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

export async function deployFlow(projectId: string, versionId: string, environment: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const version = await client.query<{ flow_name: string }>(
      'SELECT flow_name FROM flowscript_versions WHERE id=$1 AND project_id=$2',
      [versionId, projectId],
    )
    if (!version.rowCount) throw new Error('Published flow version not found in this project')
    const id = randomUUID()
    await client.query(
      `INSERT INTO flowscript_deployments (id, project_id, flow_name, environment, version_id, status)
       VALUES ($1,$2,$3,$4,$5,'active')
       ON CONFLICT (project_id, flow_name, environment)
       DO UPDATE SET version_id=EXCLUDED.version_id, status='active', updated_at=now()`,
      [id, projectId, version.rows[0].flow_name, environment, versionId],
    )
    await client.query('COMMIT')
    return { projectId, flowName: version.rows[0].flow_name, environment, versionId, status: 'active' }
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

export async function createRun(params: { projectId: string; flowName: string; environment: string; versionId: string; input: Record<string, unknown>; triggerKind: string }) {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO flowscript_runs (id, project_id, flow_name, environment, version_id, trigger_kind, status, input, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7,now())`,
    [id, params.projectId, params.flowName, params.environment, params.versionId, params.triggerKind, JSON.stringify(params.input)],
  )
  return id
}

export async function finishRun(id: string, result: { status: 'succeeded' | 'failed'; output?: unknown; steps: unknown[]; error?: string }) {
  await pool.query(
    'UPDATE flowscript_runs SET status=$2, output=$3, steps=$4, error=$5, finished_at=now() WHERE id=$1',
    [id, result.status, result.output === undefined ? null : JSON.stringify(result.output), JSON.stringify(result.steps), result.error ?? null],
  )
}

export async function getRun(projectId: string, runId: string) {
  const result = await pool.query(
    'SELECT id, flow_name, environment, version_id, trigger_kind, status, input, output, steps, error, started_at, finished_at, created_at FROM flowscript_runs WHERE project_id=$1 AND id=$2',
    [projectId, runId],
  )
  return result.rows[0] ?? null
}

export async function listRuns(projectId: string, flowName?: string, limit = 50) {
  const result = await pool.query(
    `SELECT id, flow_name, environment, version_id, trigger_kind, status, error, started_at, finished_at, created_at
     FROM flowscript_runs WHERE project_id=$1 AND ($2::text IS NULL OR flow_name=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [projectId, flowName ?? null, Math.min(Math.max(limit, 1), 100)],
  )
  return result.rows
}

export async function closeStore(): Promise<void> {
  await pool.end()
}
