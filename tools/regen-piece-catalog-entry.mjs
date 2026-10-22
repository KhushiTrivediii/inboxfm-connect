#!/usr/bin/env node
// Regenerate catalog entries from the REAL piece modules (piece.metadata()) instead of
// stale hand-scraped exports. The catalog is the source MCP/AI tools read for action
// names and input schemas — an entry generated from module exports reports fake action
// names with empty props and poisons every consumer (see issue for the resend case).
//
// Usage:
//   node tools/regen-piece-catalog-entry.mjs <piece-folder> [--write]   # one piece, dry-run by default
//   node tools/regen-piece-catalog-entry.mjs --all [--write]           # every piece with a built dist
//
// --all requires each piece's dist to be built AND loadable from the repo root (bundled dists
// only; raw tsc dists that need per-package deps are skipped) — sweep in batches, it loads
// every piece module into one process.
//
// Requires the framework and the target piece(s) to be built first (dist/ present):
//   npx turbo run build --filter=@inboxfm-connect/piece-resend
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const CATALOG_PATH = path.join(REPO_ROOT, 'packages/server/api/src/assets/local-integrations-catalog.json')

// The framework ships as CJS dist; ESM tooling needs createRequire.
const { ToolBase, TriggerBase } = require(path.join(REPO_ROOT, 'packages/integrations/framework/dist/src/index.js'))

// Property.Array() keeps a live zod instance on the runtime object that JSON serialization
// drops, and never sets the `properties` record ToolBase demands of ARRAY props — pad both
// to the schema's own shape so array-carrying actions (resend `to`/`bcc`/`cc`) validate.
const padArrayProps = ({ props }) => {
    for (const prop of Object.values(props ?? {})) {
        if (prop?.type === 'ARRAY') {
            prop.properties ??= { item: { displayName: 'Item', description: 'Array item', required: false, type: 'SHORT_TEXT' } }
            prop.valueSchema = []
        }
    }
    return props
}

const collectValidated = ({ metadata, schema, kind }) => {
    const entries = {}
    const failures = []
    for (const [name, raw] of Object.entries(metadata[kind] ?? {})) {
        const serialized = JSON.parse(JSON.stringify(raw))
        serialized.props = padArrayProps({ props: serialized.props })
        const result = schema.safeParse(serialized)
        if (result.success) {
            entries[name] = serialized
        } else {
            failures.push(`${name}: ${result.error.issues[0].path.join('.')} ${result.error.issues[0].message}`)
        }
    }
    return { entries, failures }
}

const findPieceModulePath = ({ folder }) => {
    for (const group of ['community', 'core']) {
        const dir = path.join(REPO_ROOT, 'packages/integrations', group, folder)
        if (fs.existsSync(path.join(dir, 'dist/src/index.js'))) {
            return { dir, entry: path.join(dir, 'dist/src/index.js') }
        }
    }
    return null
}

const buildEntry = ({ piece, actions, triggers, existing, version }) => ({
    displayName: piece.displayName,
    logoUrl: piece.logoUrl,
    description: piece.description || existing.description,
    version,
    minimumSupportedRelease: piece.minimumSupportedRelease || '0.0.0',
    maximumSupportedRelease: piece.maximumSupportedRelease || '999.999.999',
    categories: Array.isArray(piece.categories) ? piece.categories : ['COMMUNICATION'],
    authors: Array.isArray(piece.authors) ? piece.authors : [],
    auth: { type: piece.auth?.type || 'SECRET_TEXT' },
    actions,
    triggers,
})

const regenPiece = ({ folder, catalog, write }) => {
    const modulePath = findPieceModulePath({ folder })
    if (!modulePath) {
        return { piece: folder, status: 'SKIPPED (no built dist)', failures: [] }
    }
    const piecePackage = JSON.parse(fs.readFileSync(path.join(modulePath.dir, 'package.json'), 'utf8'))
    let module = null
    let piece = null
    try {
        // A raw tsc dist may require runtime deps that only resolve from inside the piece
        // package — treat un-loadable dists as not-built rather than aborting the sweep.
        module = require(modulePath.entry)
        piece = Object.values(module).find((exported) => exported?.metadata && exported?.displayName)
    } catch {
        return { piece: piecePackage.name, status: 'SKIPPED (dist not loadable)', failures: [] }
    }
    if (!piece) {
        return { piece: piecePackage.name, status: 'SKIPPED (no Piece export)', failures: [] }
    }
    const metadata = piece.metadata()
    const { entries: actions, failures: actionFailures } = collectValidated({ metadata, schema: ToolBase, kind: 'actions' })
    const { entries: triggers, failures: triggerFailures } = collectValidated({ metadata, schema: TriggerBase, kind: 'triggers' })
    const index = catalog.findIndex((p) => p.name === piecePackage.name)
    if (index === -1) {
        return { piece: piecePackage.name, status: 'SKIPPED (not in catalog)', failures: [...actionFailures, ...triggerFailures] }
    }
    const entry = buildEntry({ piece, actions, triggers, existing: catalog[index], version: piecePackage.version })
    const merged = { ...catalog[index], ...entry }
    const current = { ...catalog[index] }
    delete current.updated
    const candidate = { ...merged }
    delete candidate.updated
    const changed = JSON.stringify(current) !== JSON.stringify(candidate)
    if (changed && write) {
        catalog[index] = { ...merged, updated: new Date().toISOString() }
    }
    return {
        piece: piecePackage.name,
        status: changed ? (write ? 'PATCHED' : 'CHANGED (dry-run)') : 'OK (no drift)',
        failures: [...actionFailures, ...triggerFailures],
    }
}

const main = () => {
    const args = process.argv.slice(2)
    const write = args.includes('--write')
    const all = args.includes('--all')
    const folders = all
        ? ['community', 'core'].flatMap((group) => fs.readdirSync(path.join(REPO_ROOT, 'packages/integrations', group)).map((folder) => folder))
        : args.filter((arg) => !arg.startsWith('--'))
    if (folders.length === 0) {
        console.error('usage: regen-piece-catalog-entry.mjs <piece-folder> [--write] | --all [--write]')
        process.exit(2)
    }
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
    const results = folders.map((folder) => regenPiece({ folder, catalog, write }))
    for (const result of results) {
        console.log(`${result.status.padEnd(22)} ${result.piece}${result.failures.length ? ` | failures: ${result.failures.join('; ')}` : ''}`)
    }
    const patched = results.filter((result) => result.status === 'PATCHED').length
    if (write && patched > 0) {
        fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2))
        console.log(`\ncatalog updated: ${patched} entr${patched === 1 ? 'y' : 'ies'} patched -> packages/server/api/src/assets/local-integrations-catalog.json`)
    }
    if (results.some((result) => result.failures.length > 0)) {
        process.exit(1)
    }
}

main()
