import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli, type CliIo } from './cli.js'

function createMockIo(cwd: string): { io: CliIo; stdout: string[]; stderr: string[]; exitCode?: number } {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: CliIo = {
    stdout: (msg: string) => stdout.push(msg),
    stderr: (msg: string) => stderr.push(msg),
    exit: (code: number) => {
      ioResult.exitCode = code
    },
    cwd,
  }
  const ioResult = { io, stdout, stderr, exitCode: undefined as number | undefined }
  return ioResult
}

describe('FlowScript CLI', () => {
  it('prints usage when no command or file is provided', async () => {
    const mock = createMockIo(process.cwd())
    await runCli([], mock.io)
    expect(mock.exitCode).toBe(2)
    expect(mock.stderr[0]).toContain('FlowScript CLI')
  })

  it('initializes a new flow file with valid boilerplate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-test-'))
    try {
      const mock = createMockIo(dir)
      await runCli(['init', 'sample-workflow'], mock.io)
      expect(mock.exitCode).toBeUndefined()
      expect(mock.stdout[0]).toContain('✓ Created sample-workflow.flow')

      const created = await readFile(join(dir, 'sample-workflow.flow'), 'utf8')
      expect(created).toContain('flow: sample-workflow')
      expect(created).toContain('kind: manual')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite existing flow file unless --force is passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-test-'))
    try {
      const mock1 = createMockIo(dir)
      await runCli(['init', 'my-flow'], mock1.io)
      expect(mock1.exitCode).toBeUndefined()

      const mock2 = createMockIo(dir)
      await runCli(['init', 'my-flow'], mock2.io)
      expect(mock2.exitCode).toBe(1)
      expect(mock2.stderr[0]).toContain('already exists')

      const mock3 = createMockIo(dir)
      await runCli(['init', 'my-flow', '--force'], mock3.io)
      expect(mock3.exitCode).toBeUndefined()
      expect(mock3.stdout[0]).toContain('✓ Created my-flow.flow')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('formats poorly indented flow files and supports --check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-test-'))
    try {
      const flowPath = join(dir, 'unformatted.flow')
      const unformatted = `flow: unformatted\nversion: 1\ntrigger:\n   kind: manual\nsteps:\n - id: s1\n   kind: transform\n   dependsOn: []\n`
      await writeFile(flowPath, unformatted, 'utf8')

      const mockCheck = createMockIo(dir)
      await runCli(['fmt', 'unformatted.flow', '--check'], mockCheck.io)
      expect(mockCheck.exitCode).toBe(1)
      expect(mockCheck.stderr[0]).toContain('is not formatted')

      const mockFmt = createMockIo(dir)
      await runCli(['fmt', 'unformatted.flow'], mockFmt.io)
      expect(mockFmt.exitCode).toBeUndefined()
      expect(mockFmt.stdout[0]).toContain('✓ Formatted unformatted.flow')

      const mockCheckAfter = createMockIo(dir)
      await runCli(['fmt', 'unformatted.flow', '--check'], mockCheckAfter.io)
      expect(mockCheckAfter.exitCode).toBeUndefined()
      expect(mockCheckAfter.stdout[0]).toContain('is formatted')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lints valid flow and reports diagnostics on invalid flow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-test-'))
    try {
      const validPath = join(dir, 'valid.flow')
      await writeFile(validPath, `flow: valid\nversion: 1\ntrigger:\n  kind: manual\nsteps: []\n`, 'utf8')

      const mockValid = createMockIo(dir)
      await runCli(['lint', 'valid.flow'], mockValid.io)
      expect(mockValid.exitCode).toBeUndefined()
      expect(mockValid.stdout[0]).toContain('no errors')

      const invalidPath = join(dir, 'invalid.flow')
      await writeFile(invalidPath, `flow: 123-bad-name\nversion: 1\ntrigger:\n  kind: manual\nsteps: []\n`, 'utf8')

      const mockInvalid = createMockIo(dir)
      await runCli(['lint', 'invalid.flow'], mockInvalid.io)
      expect(mockInvalid.exitCode).toBe(1)
      expect(mockInvalid.stderr[0]).toContain('FLOW_SCHEMA_ERROR')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('compiles flow and outputs valid IR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-test-'))
    try {
      const flowPath = join(dir, 'compilable.flow')
      await writeFile(flowPath, `flow: compilable\nversion: 1\ntrigger:\n  kind: manual\nsteps:\n  - id: t1\n    kind: transform\n    dependsOn: []\n`, 'utf8')

      const mock = createMockIo(dir)
      await runCli(['compile', 'compilable.flow'], mock.io)
      expect(mock.exitCode).toBeUndefined()
      const json = JSON.parse(mock.stdout[0]) as { hash: string; ir: { name: string } }
      expect(json.ir.name).toBe('compilable')
      expect(json.hash).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs integration flows locally when --mock is provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-test-'))
    try {
      const flowPath = join(dir, 'integration.flow')
      const source = `flow: integration-flow
version: 1
trigger:
  kind: manual
steps:
  - id: send_email
    kind: integration
    config:
      piece: smtp
      action: send_mail
    dependsOn: []
output:
  email:
    $ref: steps.send_email
`
      await writeFile(flowPath, source, 'utf8')

      const mockNoFlag = createMockIo(dir)
      await runCli(['run', 'integration.flow'], mockNoFlag.io)
      expect(mockNoFlag.exitCode).toBe(3)
      expect(mockNoFlag.stderr[0]).toContain('require the trusted Connect runtime adapter')

      const mockWithFlag = createMockIo(dir)
      await runCli(['run', 'integration.flow', '--mock'], mockWithFlag.io)
      expect(mockWithFlag.exitCode).toBeUndefined()
      const output = JSON.parse(mockWithFlag.stdout[0]) as { status: string; steps: Array<{ status: string }> }
      expect(output.status).toBe('succeeded')
      expect(output.steps[0].status).toBe('succeeded')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
