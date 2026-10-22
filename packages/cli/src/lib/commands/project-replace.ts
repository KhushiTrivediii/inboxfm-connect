import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import {
    ConnectionMappingSchema,
    ProjectReplaceApplyResult,
    ProjectReplaceArtifact,
    ProjectReplaceArtifactSchema,
    ProjectStateSnapshot,
    ProviderMappingSchema,
} from '@inboxfm-connect/shared'

export const EXIT_SUCCESS = 0
export const EXIT_PREFLIGHT = 1
export const EXIT_VALIDATION = 2
export const EXIT_DRIFT = 3
export const EXIT_AUTH = 4
export const EXIT_TRANSPORT = 5
export const EXIT_SERVER = 6
export const EXIT_APPLY_FAILED = 7
export const EXIT_PLAN_CHANGES = 8

export type ReplaceCliOptions = {
    sourceUrl?: string
    sourceToken?: string
    sourceProject?: string
    destUrl: string
    destToken: string
    destProject: string
    planFile?: string
    out?: string
    dryRun?: boolean
    force?: boolean
    deployIntegrations?: boolean
    inspectOnly?: boolean
    connectionMap?: string[]
    connectionMappingFile?: string
    connectionBootstrap?: string
    providerMap?: string[]
    providerMappingFile?: string
    rotateMcpToken?: boolean
    mcpCredentialsFile?: string
    json?: boolean
}

export function parseMappingContent(content: string, out: ConnectionMappingSchema[]): void {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) {
        for (const item of parsed) {
            if (item && item.sourceExternalId) {
                out.push(item)
            }
        }
    }
    else if (typeof parsed === 'object' && parsed !== null) {
        if (Array.isArray((parsed as Record<string, unknown>).mappings)) {
            for (const item of (parsed as Record<string, unknown>).mappings as unknown[]) {
                if (item && typeof item === 'object' && 'sourceExternalId' in item) {
                    out.push(item as ConnectionMappingSchema)
                }
            }
        }
        else {
            for (const [key, val] of Object.entries(parsed)) {
                if (typeof val === 'string') {
                    out.push({ sourceExternalId: key, destExternalId: val })
                }
                else if (typeof val === 'object' && val !== null) {
                    out.push({ sourceExternalId: key, ...(val as object) })
                }
            }
        }
    }
}

export function parseConnectionMappings(options: ReplaceCliOptions): ConnectionMappingSchema[] {
    const mappings: ConnectionMappingSchema[] = []

    const envVal = process.env.INBOXFM_CONNECTION_MAPPINGS
    if (envVal) {
        try {
            if (fs.existsSync(path.resolve(envVal))) {
                const content = fs.readFileSync(path.resolve(envVal), 'utf-8')
                parseMappingContent(content, mappings)
            }
            else {
                parseMappingContent(envVal, mappings)
            }
        }
        catch (err) {
            console.warn('Warning: Failed to parse INBOXFM_CONNECTION_MAPPINGS:', (err as Error).message)
        }
    }

    if (options.connectionMappingFile) {
        const filePath = path.resolve(options.connectionMappingFile)
        if (!fs.existsSync(filePath)) {
            throw new Error(`Connection mapping file not found: ${filePath}`)
        }
        const content = fs.readFileSync(filePath, 'utf-8')
        parseMappingContent(content, mappings)
    }

    if (options.connectionBootstrap) {
        parseMappingContent(options.connectionBootstrap, mappings)
    }

    if (options.connectionMap) {
        const rawList = Array.isArray(options.connectionMap) ? options.connectionMap : [options.connectionMap]
        for (const item of rawList) {
            for (const part of item.split(',')) {
                const trimmed = part.trim()
                if (!trimmed) continue
                const delimiterIndex = trimmed.indexOf('=') !== -1 ? trimmed.indexOf('=') : trimmed.indexOf(':')
                if (delimiterIndex === -1) {
                    throw new Error(`Invalid connection mapping "${trimmed}". Format must be sourceExternalId=destExternalId`)
                }
                const src = trimmed.slice(0, delimiterIndex).trim()
                const dest = trimmed.slice(delimiterIndex + 1).trim()
                mappings.push({
                    sourceExternalId: src,
                    destExternalId: dest,
                })
            }
        }
    }

    return mappings
}

export function parseProviderMappingContent(content: string, out: ProviderMappingSchema[]): void {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) {
        for (const item of parsed) {
            if (item && typeof item === 'object' && typeof item.sourceProvider === 'string' && typeof item.destProvider === 'string') {
                out.push({
                    sourceProvider: item.sourceProvider,
                    destProvider: item.destProvider,
                })
            }
        }
    }
    else if (typeof parsed === 'object' && parsed !== null) {
        if (Array.isArray((parsed as Record<string, unknown>).mappings)) {
            for (const item of (parsed as Record<string, unknown>).mappings as unknown[]) {
                if (item && typeof item === 'object' && 'sourceProvider' in item && 'destProvider' in item) {
                    const sp = (item as Record<string, unknown>).sourceProvider
                    const dp = (item as Record<string, unknown>).destProvider
                    if (typeof sp === 'string' && typeof dp === 'string') {
                        out.push({ sourceProvider: sp, destProvider: dp })
                    }
                }
            }
        }
        else {
            for (const [key, val] of Object.entries(parsed)) {
                if (typeof val === 'string') {
                    out.push({ sourceProvider: key, destProvider: val })
                }
                else if (typeof val === 'object' && val !== null && 'destProvider' in val) {
                    const dp = (val as Record<string, unknown>).destProvider
                    if (typeof dp === 'string') {
                        out.push({ sourceProvider: key, destProvider: dp })
                    }
                }
            }
        }
    }
}

export function parseProviderMappings(options: ReplaceCliOptions): ProviderMappingSchema[] {
    const mappings: ProviderMappingSchema[] = []

    const envVal = process.env.INBOXFM_PROVIDER_MAPPINGS
    if (envVal) {
        try {
            if (fs.existsSync(path.resolve(envVal))) {
                const content = fs.readFileSync(path.resolve(envVal), 'utf-8')
                parseProviderMappingContent(content, mappings)
            }
            else {
                parseProviderMappingContent(envVal, mappings)
            }
        }
        catch (err) {
            console.warn('Warning: Failed to parse INBOXFM_PROVIDER_MAPPINGS:', (err as Error).message)
        }
    }

    if (options.providerMappingFile) {
        const filePath = path.resolve(options.providerMappingFile)
        if (!fs.existsSync(filePath)) {
            throw new Error(`Provider mapping file not found: ${filePath}`)
        }
        const content = fs.readFileSync(filePath, 'utf-8')
        parseProviderMappingContent(content, mappings)
    }

    if (options.providerMap) {
        const rawList = Array.isArray(options.providerMap) ? options.providerMap : [options.providerMap]
        for (const item of rawList) {
            for (const part of item.split(',')) {
                const trimmed = part.trim()
                if (!trimmed) continue
                const delimiterIndex = trimmed.indexOf('=') !== -1 ? trimmed.indexOf('=') : trimmed.indexOf(':')
                if (delimiterIndex === -1) {
                    throw new Error(`Invalid provider mapping "${trimmed}". Format must be sourceProvider=destProvider`)
                }
                const src = trimmed.slice(0, delimiterIndex).trim()
                const dest = trimmed.slice(delimiterIndex + 1).trim()
                mappings.push({
                    sourceProvider: src,
                    destProvider: dest,
                })
            }
        }
    }

    return mappings
}

async function fetchJson<T>(url: string, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean, status: number, data: T }> {
    try {
        const res = await fetchImpl(url, init)
        const text = await res.text()
        let parsed: unknown
        try {
            parsed = JSON.parse(text)
        }
        catch {
            parsed = text
        }
        return { ok: res.ok, status: res.status, data: parsed as T }
    }
    catch (err) {
        throw new Error(`Transport error calling ${url}: ${(err as Error).message}`)
    }
}

export type ReplaceCliDeps = {
    exitFn?: (code: number) => void
    fetchFn?: typeof fetch
    logFn?: (...args: unknown[]) => void
    errFn?: (...args: unknown[]) => void
    warnFn?: (...args: unknown[]) => void
}

export async function runProjectReplace(
    options: ReplaceCliOptions,
    deps: ReplaceCliDeps = {},
): Promise<number> {
    const exit = deps.exitFn ?? ((code: number) => process.exit(code))
    const log = deps.logFn ?? console.log
    const errLog = deps.errFn ?? console.error
    const warnLog = deps.warnFn ?? console.warn
    const fetchImpl = deps.fetchFn ?? fetch

    try {
        const destBase = options.destUrl.replace(/\/$/, '')

        let snapshot: ProjectStateSnapshot
        let artifact: ProjectReplaceArtifact | null = null

        const connectionMappings = parseConnectionMappings(options)
        const providerMappings = parseProviderMappings(options)

        if (!options.json && (connectionMappings.length > 0 || providerMappings.length > 0)) {
            const bootstrapCount = connectionMappings.filter((m) => !!m.value).length
            const remapCount = connectionMappings.length - bootstrapCount
            if (connectionMappings.length > 0) {
                log(`Connection mappings loaded: ${connectionMappings.length} (${remapCount} alias, ${bootstrapCount} credentials [REDACTED])`)
            }
            if (providerMappings.length > 0) {
                log(`Provider mappings loaded: ${providerMappings.length} (${providerMappings.map((p) => `${p.sourceProvider}->${p.destProvider}`).join(', ')})`)
            }
        }

        // 1. If --plan-file is supplied, load and validate it with Zod schema
        if (options.planFile) {
            const raw = fs.readFileSync(path.resolve(options.planFile), 'utf-8')
            let parsedJson: unknown
            try {
                parsedJson = JSON.parse(raw)
            }
            catch (e) {
                errLog('Invalid JSON in plan file:', (e as Error).message)
                exit(EXIT_VALIDATION)
                return EXIT_VALIDATION
            }

            const parsed = ProjectReplaceArtifactSchema.safeParse(parsedJson)
            if (!parsed.success) {
                errLog('Invalid plan file schema:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '))
                exit(EXIT_VALIDATION)
                return EXIT_VALIDATION
            }
            artifact = parsed.data
            snapshot = artifact.snapshot

            // If --dry-run or --inspect-only is passed with --plan-file, verify signature & drift with destination /inspect
            if (options.dryRun || options.inspectOnly) {
                // No providerMappings here: /inspect takes only plan, snapshot and
                // connectionMappings, and verifies the already-signed plan. The mappings
                // were folded into plan.preflight when the plan was generated, so sending
                // them again is dropped by the endpoint's schema and cannot change the verdict.
                const inspectRes = await fetchJson<{ applied: Record<string, number>, failed: Array<{ error: string }>, error?: string }>(
                    `${destBase}/api/v1/projects/${options.destProject}/replace/inspect`,
                    {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${options.destToken}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            plan: artifact.plan,
                            snapshot,
                            connectionMappings: connectionMappings.length > 0 ? connectionMappings : undefined,
                        }),
                    },
                    fetchImpl,
                )

                if (inspectRes.status === 409) {
                    errLog('Error: Destination state has drifted since the plan was created. Re-run plan.')
                    exit(EXIT_DRIFT)
                    return EXIT_DRIFT
                }

                if (inspectRes.status === 401 || inspectRes.status === 403) {
                    errLog('Error: Unauthorized on destination:', inspectRes.data)
                    exit(EXIT_AUTH)
                    return EXIT_AUTH
                }

                if (!inspectRes.ok) {
                    errLog(`Error: Plan verification failed on destination (${inspectRes.status}):`, inspectRes.data)
                    const code = inspectRes.status >= 500 ? EXIT_SERVER : EXIT_VALIDATION
                    exit(code)
                    return code
                }

                if (options.dryRun) {
                if (options.json) {
                    const sanitized = {
                        ...artifact,
                        snapshot: undefined,
                    }
                    log(JSON.stringify(sanitized, null, 2))
                }
                else {
                    log(`Plan ID: ${artifact.plan.planId}`)
                    log(`Checksum: ${artifact.plan.checksum}`)
                    log(`Signature: ${artifact.plan.signature} (Verified)`)
                    log('\nPlanned Changes:')
                    log(`  Creates:   ${artifact.plan.summary.created}`)
                    log(`  Updates:   ${artifact.plan.summary.updated}`)
                    log(`  Deletes:   ${artifact.plan.summary.deleted}`)
                    log(`  Unchanged: ${artifact.plan.summary.unchanged}`)
                    if (artifact.plan.preflight.connections) {
                        const cp = artifact.plan.preflight.connections
                        log('\nConnections:')
                        log(`  Required:   ${cp.required.length}`)
                        log(`  Matched:    ${cp.matched.length}`)
                        log(`  Missing:    ${cp.missing.length}`)
                        log(`  Mapped:     ${cp.mapped.length}`)
                    }
                }
                    const totalChanges = artifact.plan.summary.created + artifact.plan.summary.updated + artifact.plan.summary.deleted
                    const code = totalChanges > 0 ? EXIT_PLAN_CHANGES : EXIT_SUCCESS
                    exit(code)
                    return code
                }

                if (options.inspectOnly) {
                    if (options.json) {
                        log(JSON.stringify(artifact, null, 2))
                    }
                    else {
                        log('Inspect-only mode: plan verified, no mutations applied.')
                        if (artifact.plan.preflight.customIntegrations) {
                            const ci = artifact.plan.preflight.customIntegrations
                            log(`Required integrations:   ${ci.required.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
                            log(`Missing integrations:    ${ci.missing.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
                        }
                        if (artifact.plan.preflight.connections) {
                            const cp = artifact.plan.preflight.connections
                            log(`Required connections:    ${cp.required.map((c) => `${c.externalId} (${c.pieceName})`).join(', ') || 'none'}`)
                            log(`Matched connections:     ${cp.matched.map((c) => `${c.sourceExternalId} -> ${c.destExternalId}`).join(', ') || 'none'}`)
                            log(`Missing connections:     ${cp.missing.map((c) => `${c.externalId} (${c.pieceName})`).join(', ') || 'none'}`)
                        }
                    }
                    exit(EXIT_SUCCESS)
                    return EXIT_SUCCESS
                }
            }
        }
        else {
            // Otherwise source details are required to fetch snapshot
            if (!options.sourceUrl || !options.sourceToken || !options.sourceProject) {
                errLog('Error: --source-url, --source-token, and --source-project are required when --plan-file is not provided.')
                exit(EXIT_AUTH)
                return EXIT_AUTH
            }

            const sourceBase = options.sourceUrl.replace(/\/$/, '')
            const exportRes = await fetchJson<ProjectStateSnapshot>(
                `${sourceBase}/api/v1/projects/${options.sourceProject}/replace/export`,
                {
                    headers: {
                        Authorization: `Bearer ${options.sourceToken}`,
                        'Content-Type': 'application/json',
                    },
                },
                fetchImpl,
            )

            if (!exportRes.ok) {
                errLog(`Error: Failed to export snapshot from source (${exportRes.status}):`, exportRes.data)
                if (exportRes.status >= 500) {
                    exit(EXIT_SERVER)
                    return EXIT_SERVER
                }
                const code = exportRes.status === 401 || exportRes.status === 403 ? EXIT_AUTH : EXIT_TRANSPORT
                exit(code)
                return code
            }
            snapshot = exportRes.data
        }

        // 2. Plan generation (if no plan file is provided)
        if (!artifact) {
            const planRes = await fetchJson<ProjectReplaceArtifact>(
                `${destBase}/api/v1/projects/${options.destProject}/replace/plan`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${options.destToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        snapshot,
                        connectionMappings: connectionMappings.length > 0 ? connectionMappings : undefined,
                        providerMappings: providerMappings.length > 0 ? providerMappings : undefined,
                    }),
                },
                fetchImpl,
            )

            if (planRes.status === 400) {
                if (planRes.data && (planRes.data as unknown as { plan?: { preflight?: { passed?: boolean, errors: Array<{ kind: string, message: string }> } } }).plan) {
                    const planBody = (planRes.data as unknown as { plan: { preflight: { passed: boolean, errors: Array<{ kind: string, message: string }> } } }).plan
                    if (!options.force && !options.inspectOnly) {
                        if (options.json) {
                            log(JSON.stringify(planRes.data, null, 2))
                        }
                        else {
                            errLog('Preflight checks failed on destination:')
                            for (const err of planBody.preflight.errors) {
                                errLog(`  - [${err.kind}]: ${err.message}`)
                            }
                        }
                        exit(EXIT_PREFLIGHT)
                        return EXIT_PREFLIGHT
                    }
                    else {
                        artifact = planRes.data
                    }
                }
                else {
                    errLog(`Error: Validation failed on destination (${planRes.status}):`, planRes.data)
                    exit(EXIT_VALIDATION)
                    return EXIT_VALIDATION
                }
            }
            else if (planRes.status === 401 || planRes.status === 403) {
                errLog(`Error: Auth failed on destination (${planRes.status}):`, planRes.data)
                exit(EXIT_AUTH)
                return EXIT_AUTH
            }
            else if (planRes.status === 409) {
                errLog(`Error: Drift detected (${planRes.status}):`, planRes.data)
                exit(EXIT_DRIFT)
                return EXIT_DRIFT
            }
            else if (planRes.status >= 500) {
                errLog(`Error: Server error on destination (${planRes.status}):`, planRes.data)
                exit(EXIT_SERVER)
                return EXIT_SERVER
            }
            else if (!planRes.ok) {
                errLog(`Error: Failed to generate plan on destination (${planRes.status}):`, planRes.data)
                exit(EXIT_TRANSPORT)
                return EXIT_TRANSPORT
            }
            else {
                artifact = planRes.data
            }

            if (options.out && artifact) {
                const outPath = path.resolve(options.out)
                fs.mkdirSync(path.dirname(outPath), { recursive: true })
                fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf-8')
            }

            if (options.dryRun && artifact) {
                if (options.json) {
                    const sanitized = {
                        ...artifact,
                        snapshot: undefined,
                    }
                    log(JSON.stringify(sanitized, null, 2))
                }
                else {
                    log(`Plan ID: ${artifact.plan.planId}`)
                    log(`Checksum: ${artifact.plan.checksum}`)
                    log(`Signature: ${artifact.plan.signature}`)
                    log('\nPlanned Changes:')
                    log(`  Creates:   ${artifact.plan.summary.created}`)
                    log(`  Updates:   ${artifact.plan.summary.updated}`)
                    log(`  Deletes:   ${artifact.plan.summary.deleted}`)
                    log(`  Unchanged: ${artifact.plan.summary.unchanged}`)
                    if (artifact.plan.preflight.customIntegrations) {
                        const ci = artifact.plan.preflight.customIntegrations
                        log('\nCustom Integrations:')
                        log(`  Required:   ${ci.required.length}`)
                        log(`  Missing:    ${ci.missing.length}`)
                        log(`  Deployable: ${ci.deployable.length}`)
                    }
                    if (artifact.plan.preflight.connections) {
                        const cp = artifact.plan.preflight.connections
                        log('\nConnections:')
                        log(`  Required:   ${cp.required.length}`)
                        log(`  Matched:    ${cp.matched.length}`)
                        log(`  Missing:    ${cp.missing.length}`)
                        log(`  Mapped:     ${cp.mapped.length}`)
                    }
                    if (artifact.plan.preflight.warnings && artifact.plan.preflight.warnings.length > 0) {
                        log('\nPreflight Warnings:')
                        for (const warn of artifact.plan.preflight.warnings) {
                            log(`  - [${warn.kind}]: ${warn.message}`)
                        }
                    }
                }
                if (artifact.plan.changes) {
                    const mcpCreates = artifact.plan.changes.creates.filter(c => c.kind === 'mcp_server').length
                    const mcpUpdates = artifact.plan.changes.updates.filter(c => c.kind === 'mcp_server').length
                    const mcpDeletes = artifact.plan.changes.deletes.filter(c => c.kind === 'mcp_server').length
                    const mcpUnchanged = artifact.plan.changes.unchanged.filter(c => c.kind === 'mcp_server').length
                    if (mcpCreates + mcpUpdates + mcpDeletes + mcpUnchanged > 0) {
                        log('\nMCP Server Configuration:')
                        log(`  Creates:   ${mcpCreates}`)
                        log(`  Updates:   ${mcpUpdates}`)
                        log(`  Deletes:   ${mcpDeletes}`)
                        log(`  Unchanged: ${mcpUnchanged}`)
                    }
                }
                const totalChanges = artifact.plan.summary.created + artifact.plan.summary.updated + artifact.plan.summary.deleted
                const code = totalChanges > 0 ? EXIT_PLAN_CHANGES : EXIT_SUCCESS
                exit(code)
                return code
            }

            if (options.inspectOnly && artifact) {
                if (options.json) {
                    const sanitized = {
                        ...artifact,
                        snapshot: undefined,
                    }
                    log(JSON.stringify(sanitized, null, 2))
                }
                else {
                    log('Inspect-only mode: no mutations applied.')
                    if (artifact.plan.preflight.customIntegrations) {
                        const ci = artifact.plan.preflight.customIntegrations
                        log(`Required integrations:   ${ci.required.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
                        log(`Missing integrations:    ${ci.missing.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
                        log(`Deployable integrations: ${ci.deployable.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
                        log(`Compatible integrations: ${ci.compatible.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
                    }
                    if (artifact.plan.preflight.connections) {
                        const cp = artifact.plan.preflight.connections
                        log(`Required connections:    ${cp.required.map((c) => `${c.externalId} (${c.pieceName})`).join(', ') || 'none'}`)
                        log(`Matched connections:     ${cp.matched.map((c) => `${c.sourceExternalId} -> ${c.destExternalId}`).join(', ') || 'none'}`)
                        log(`Missing connections:     ${cp.missing.map((c) => `${c.externalId} (${c.pieceName})`).join(', ') || 'none'}`)
                    }
                    if (!artifact.plan.preflight.passed) {
                        log('\nPreflight checks:')
                        for (const err of artifact.plan.preflight.errors) {
                            log(`  - [${err.kind}]: ${err.message}`)
                        }
                    }
                }
                const code = artifact.plan.preflight.passed ? EXIT_SUCCESS : EXIT_PREFLIGHT
                exit(code)
                return code
            }
        }

        // 3. Apply phase
        const applyRes = await fetchJson<ProjectReplaceApplyResult>(
            `${destBase}/api/v1/projects/${options.destProject}/replace/apply`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${options.destToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    plan: artifact!.plan,
                    snapshot,
                    force: options.force,
                    deployCustomIntegrations: options.deployIntegrations,
                    inspectOnly: options.inspectOnly,
                    connectionMappings: connectionMappings.length > 0 ? connectionMappings : undefined,
                    providerMappings: providerMappings.length > 0 ? providerMappings : undefined,
                    rotateMcpToken: options.rotateMcpToken,
                }),
            },
            fetchImpl,
        )

        if (applyRes.status === 409) {
            errLog('Error: Destination state has drifted since the plan was created. Re-run plan or recreate plan artifact.')
            exit(EXIT_DRIFT)
            return EXIT_DRIFT
        }

        if (applyRes.status === 401 || applyRes.status === 403) {
            errLog('Error: Unauthorized on destination:', applyRes.data)
            exit(EXIT_AUTH)
            return EXIT_AUTH
        }

        if (!applyRes.ok && applyRes.status !== 207) {
            errLog(`Error: Apply failed on destination (${applyRes.status}):`, applyRes.data)
            const code = applyRes.status >= 500 ? EXIT_SERVER : EXIT_TRANSPORT
            exit(code)
            return code
        }

        // Persist rotated credentials before the output branch so `--json` consumers keep a
        // secure retrieval path; the token is redacted on stdout in both output modes.
        const mcpCreds = applyRes.data.mcpCredentials
        const credPath = options.mcpCredentialsFile ? path.resolve(options.mcpCredentialsFile) : undefined
        if (mcpCreds?.token && credPath) {
            fs.mkdirSync(path.dirname(credPath), { recursive: true })
            fs.writeFileSync(credPath, JSON.stringify(mcpCreds, null, 2), {
                encoding: 'utf-8',
                mode: 0o600,
            })
        }

        if (options.json) {
            const sanitized = {
                ...applyRes.data,
                mcpCredentials: mcpCreds
                    ? { ...mcpCreds, token: '[REDACTED — use --mcp-credentials-file]' }
                    : undefined,
                mcpCredentialsFile: credPath,
            }
            log(JSON.stringify(sanitized, null, 2))
        }
        else {
            log('Project replacement apply finished:')
            log(JSON.stringify(applyRes.data.applied, null, 2))
            if (mcpCreds?.token) {
                log('\nDestination MCP Server Credentials:')
                if (credPath) {
                    log(`  Token: [REDACTED] (saved with 0600 permissions to ${options.mcpCredentialsFile})`)
                }
                else {
                    log('  Token: [REDACTED] (use --mcp-credentials-file <path> to save securely)')
                }
                if (mcpCreds.serverUrl) {
                    log(`  Server URL: ${mcpCreds.serverUrl}`)
                }
            }
            if (applyRes.data.failed.length > 0) {
                warnLog(`Warnings: ${applyRes.data.failed.length} items failed to apply.`)
            }
        }

        const code = applyRes.data.failed.length > 0 ? EXIT_APPLY_FAILED : EXIT_SUCCESS
        exit(code)
        return code
    }
    catch (err) {
        errLog('Fatal CLI Error:', (err as Error).message)
        if ((err as Error).message.startsWith('Transport error')) {
            exit(EXIT_TRANSPORT)
            return EXIT_TRANSPORT
        }
        exit(EXIT_VALIDATION)
        return EXIT_VALIDATION
    }
}

export const projectReplaceCommand = new Command('replace')
    .description('Mirror a project configuration from source to destination, or review dry-run plan')
    .option('--source-url <url>', 'Source Activepieces API URL')
    .option('--source-token <token>', 'Source authorization token')
    .option('--source-project <id>', 'Source project ID')
    .requiredOption('--dest-url <url>', 'Destination Activepieces API URL')
    .requiredOption('--dest-token <token>', 'Destination authorization token')
    .requiredOption('--dest-project <id>', 'Destination project ID')
    .option('--plan-file <path>', 'Path to a signed plan artifact JSON file to apply')
    .option('--out <path>', 'Path to write generated plan artifact JSON')
    .option('--dry-run', 'Generate reviewable plan artifact without mutating destination', false)
    .option('--deploy-integrations', 'Deploy missing custom integrations automatically during replace', false)
    .option('--inspect-only', 'Inspect and report missing integrations without applying any changes', false)
    .option('--connection-map <mapping...>', 'Map source connection externalId to destination externalId (e.g. source=dest)')
    .option('--connection-mapping-file <path>', 'Path to file containing connection mappings or bootstrap secrets')
    .option('--connection-bootstrap <json>', 'JSON string of connection bootstrap credentials')
    .option('--provider-map <mapping...>', 'Map source AI provider to destination AI provider (e.g. source=dest)')
    .option('--provider-mapping-file <path>', 'Path to file containing provider mappings')
    .option('--force', 'Bypass preflight warnings', false)
    .option('--rotate-mcp-token', 'Rotate destination MCP server token during apply and output one-time credential', false)
    .option('--mcp-credentials-file <path>', 'Path to write destination MCP credentials file with 0600 permissions')
    .option('--json', 'Output machine-readable JSON', false)
    .action(async (options: ReplaceCliOptions) => {
        await runProjectReplace(options)
    })
