import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
    EXIT_SUCCESS,
    EXIT_AUTH,
    EXIT_DRIFT,
    EXIT_SERVER,
    runProjectReplace,
} from '../../src/lib/commands/project-replace'
import {
    ProjectReplaceArtifact,
    ProjectStateSnapshot,
} from '@inboxfm-connect/shared'

describe('CLI Project Replace Integration Smoke Tests (Real HTTP Boundary)', () => {
    let server: http.Server
    let serverUrl: string
    let tmpDir: string
    let lastExportReq: { headers: http.IncomingHttpHeaders } | null = null
    let lastPlanReq: { headers: http.IncomingHttpHeaders, body: any } | null = null
    let lastApplyReq: { headers: http.IncomingHttpHeaders, body: any } | null = null
    let lastInspectReq: { headers: http.IncomingHttpHeaders, body: any } | null = null

    let mockStatusOverrides: {
        exportStatus?: number
        planStatus?: number
        applyStatus?: number
        inspectStatus?: number
    } = {}

    const sampleSnapshot: ProjectStateSnapshot = {
        schemaVersion: 1,
        sourceActivepiecesVersion: '1.0.0',
        exportedAt: '2026-09-28T00:00:00.000Z',
        sourceEnvironment: { projectId: 'src-proj-real' },
        tables: [],
        agents: [],
        triggerBindings: [],
        scheduledTasks: [],
        mcp: null,
        requiredPieces: [],
        requiredConnections: [],
        flows: [],
    }

    const sampleArtifact: ProjectReplaceArtifact = {
        artifactVersion: 1,
        toolVersion: '1.0.0',
        createdAt: '2026-09-28T00:00:00.000Z',
        plan: {
            planId: 'real-plan-999',
            schemaVersion: 1,
            toolVersion: '1.0.0',
            createdAt: '2026-09-28T00:00:00.000Z',
            sourceActivepiecesVersion: '1.0.0',
            targetActivepiecesVersion: '1.0.0',
            targetProjectId: 'dest-proj-real',
            checksum: 'chk-real-123',
            destinationStateHash: 'dst-hash-real',
            signature: 'sig-real-456',
            summary: {
                created: 1,
                updated: 0,
                deleted: 0,
                unchanged: 0,
            },
            preflight: {
                passed: true,
                errors: [],
                warnings: [],
            },
            changes: {
                creates: [{ kind: 'mcp_server', externalId: 'default', op: 'CREATE', name: 'Default MCP' }],
                updates: [],
                deletes: [],
                unchanged: [],
            },
        },
        snapshot: sampleSnapshot,
    }

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = req.url || ''
            let body = ''
            req.on('data', (chunk) => {
                body += chunk
            })
            req.on('end', () => {
                let parsedBody: any = null
                try {
                    parsedBody = body ? JSON.parse(body) : null
                }
                catch {}

                if (url.includes('/replace/export')) {
                    lastExportReq = { headers: req.headers }
                    const status = mockStatusOverrides.exportStatus ?? 200
                    res.writeHead(status, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify(status === 200 ? sampleSnapshot : { error: 'EXPORT_FAILED' }))
                    return
                }

                if (url.includes('/replace/plan')) {
                    lastPlanReq = { headers: req.headers, body: parsedBody }
                    const status = mockStatusOverrides.planStatus ?? 200
                    res.writeHead(status, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify(status === 200 ? sampleArtifact : { error: 'PLAN_FAILED' }))
                    return
                }

                if (url.includes('/replace/inspect')) {
                    lastInspectReq = { headers: req.headers, body: parsedBody }
                    const status = mockStatusOverrides.inspectStatus ?? 200
                    res.writeHead(status, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify(status === 200 ? { applied: {}, failed: [] } : { error: 'INSPECT_FAILED' }))
                    return
                }

                if (url.includes('/replace/apply')) {
                    lastApplyReq = { headers: req.headers, body: parsedBody }
                    const status = mockStatusOverrides.applyStatus ?? 200
                    res.writeHead(status, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify(status === 200 ? {
                        applied: { mcpCreated: 1 },
                        failed: [],
                        mcpCredentials: {
                            token: 'smoke-secret-mcp-token-live',
                            serverUrl: `${serverUrl}/api/v1/mcp`,
                        },
                    } : { error: 'APPLY_FAILED' }))
                    return
                }

                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'NOT_FOUND' }))
            })
        })

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                const address = server.address() as any
                serverUrl = `http://127.0.0.1:${address.port}`
                resolve()
            })
        })
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
        })
    })

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-smoke-'))
        lastExportReq = null
        lastPlanReq = null
        lastApplyReq = null
        lastInspectReq = null
        mockStatusOverrides = {}
    })

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
        catch {}
    })

    it('successfully completes export -> plan -> apply over real HTTP socket with provider mappings', async () => {
        const credsFile = path.join(tmpDir, 'creds.json')
        const logs: string[] = []
        let exitCode: number | undefined

        const code = await runProjectReplace(
            {
                sourceUrl: serverUrl,
                sourceToken: 'bearer-source-secret-123',
                sourceProject: 'src-proj-real',
                destUrl: serverUrl,
                destToken: 'bearer-dest-secret-456',
                destProject: 'dest-proj-real',
                providerMap: ['openai=anthropic', 'google=azure'],
                connectionMap: ['conn1=conn2'],
                rotateMcpToken: true,
                mcpCredentialsFile: credsFile,
            },
            {
                exitFn: (c) => { exitCode = c },
                logFn: (...args) => { logs.push(args.join(' ')) },
            },
        )

        expect(code).toBe(EXIT_SUCCESS)
        expect(exitCode).toBe(EXIT_SUCCESS)

        // Verify real network request headers
        expect(lastExportReq?.headers.authorization).toBe('Bearer bearer-source-secret-123')
        expect(lastPlanReq?.headers.authorization).toBe('Bearer bearer-dest-secret-456')
        expect(lastApplyReq?.headers.authorization).toBe('Bearer bearer-dest-secret-456')

        // Verify provider mappings transmitted over HTTP
        expect(lastPlanReq?.body.providerMappings).toEqual([
            { sourceProvider: 'openai', destProvider: 'anthropic' },
            { sourceProvider: 'google', destProvider: 'azure' },
        ])
        expect(lastApplyReq?.body.providerMappings).toEqual([
            { sourceProvider: 'openai', destProvider: 'anthropic' },
            { sourceProvider: 'google', destProvider: 'azure' },
        ])

        // Verify connection mappings transmitted over HTTP
        expect(lastPlanReq?.body.connectionMappings).toEqual([
            { sourceExternalId: 'conn1', destExternalId: 'conn2' },
        ])

        // Verify credentials file written with restricted mode
        expect(fs.existsSync(credsFile)).toBe(true)
        const savedCreds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'))
        expect(savedCreds.token).toBe('smoke-secret-mcp-token-live')

        // Verify no secrets in stdout
        const allOutput = logs.join('\n')
        expect(allOutput).not.toContain('smoke-secret-mcp-token-live')
        expect(allOutput).not.toContain('bearer-source-secret-123')
        expect(allOutput).not.toContain('bearer-dest-secret-456')
        expect(allOutput).toContain('[REDACTED]')
    })

    it('returns EXIT_AUTH (4) when destination rejects credentials with 401 over network', async () => {
        mockStatusOverrides.planStatus = 401
        let exitCode: number | undefined

        const code = await runProjectReplace(
            {
                sourceUrl: serverUrl,
                sourceToken: 'valid-src-token',
                sourceProject: 'src-proj-real',
                destUrl: serverUrl,
                destToken: 'bad-dest-token',
                destProject: 'dest-proj-real',
            },
            {
                exitFn: (c) => { exitCode = c },
                errFn: () => {},
            },
        )

        expect(code).toBe(EXIT_AUTH)
        expect(exitCode).toBe(EXIT_AUTH)
    })

    it('returns EXIT_DRIFT (3) when destination signals 409 conflict over network', async () => {
        mockStatusOverrides.applyStatus = 409
        let exitCode: number | undefined

        const code = await runProjectReplace(
            {
                sourceUrl: serverUrl,
                sourceToken: 'valid-src-token',
                sourceProject: 'src-proj-real',
                destUrl: serverUrl,
                destToken: 'valid-dest-token',
                destProject: 'dest-proj-real',
            },
            {
                exitFn: (c) => { exitCode = c },
                errFn: () => {},
            },
        )

        expect(code).toBe(EXIT_DRIFT)
        expect(exitCode).toBe(EXIT_DRIFT)
    })

    it('returns EXIT_SERVER (6) when destination returns 500 error over network', async () => {
        mockStatusOverrides.planStatus = 500
        let exitCode: number | undefined

        const code = await runProjectReplace(
            {
                sourceUrl: serverUrl,
                sourceToken: 'valid-src-token',
                sourceProject: 'src-proj-real',
                destUrl: serverUrl,
                destToken: 'valid-dest-token',
                destProject: 'dest-proj-real',
            },
            {
                exitFn: (c) => { exitCode = c },
                errFn: () => {},
            },
        )

        expect(code).toBe(EXIT_SERVER)
        expect(exitCode).toBe(EXIT_SERVER)
    })
})
