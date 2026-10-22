import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS_SITE_PREFIX = 'https://www.inboxfm-connect.com/docs/'

// Contributors and agents read these before touching the repo, so a link here that
// cannot be followed is a real blocker rather than cosmetic.
function collectContributorDocs() {
    const rootDocs = fs.readdirSync(REPO_ROOT)
        .filter((name) => name.endsWith('.md'))
        .map((name) => path.join(REPO_ROOT, name))

    const packageDocs = []
    for (const scope of ['packages', 'docs']) {
        const scopeDir = path.join(REPO_ROOT, scope)
        if (!fs.existsSync(scopeDir)) continue
        for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            for (const candidate of ['AGENTS.md', 'CLAUDE.md']) {
                const candidatePath = path.join(scopeDir, entry.name, candidate)
                if (fs.existsSync(candidatePath)) packageDocs.push(candidatePath)
            }
        }
    }
    // CLAUDE.md is a symlink to AGENTS.md, so dedupe on the resolved path to avoid
    // reporting one broken link twice.
    const seen = new Set()
    return [...rootDocs, ...packageDocs]
        .map((doc) => fs.realpathSync(doc))
        .filter((doc) => {
            if (seen.has(doc)) return false
            seen.add(doc)
            return true
        })
}

function toRepoRelative(absolutePath) {
    return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/')
}

function readLinks(absolutePath) {
    const contents = fs.readFileSync(absolutePath, 'utf8')
    return [...contents.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])
}

function resolveInRepoDocs(docsUrlPath) {
    const withoutAnchor = docsUrlPath.split('#')[0].replace(/\/$/, '')
    for (const extension of ['.mdx', '.md']) {
        const candidate = path.join(REPO_ROOT, 'docs', `${withoutAnchor}${extension}`)
        if (fs.existsSync(candidate)) return toRepoRelative(candidate)
    }
    return null
}

describe('contributor documentation links', () => {
    const docs = collectContributorDocs()

    it('finds the contributor docs it is meant to be checking', () => {
        assert.ok(docs.length > 0, 'expected at least one contributor doc to scan')
    })

    it('does not point at the docs site for pages that already exist in this repo', () => {
        const offenders = []
        for (const doc of docs) {
            for (const link of readLinks(doc)) {
                if (!link.startsWith(DOCS_SITE_PREFIX)) continue
                const inRepoCopy = resolveInRepoDocs(link.slice(DOCS_SITE_PREFIX.length))
                if (inRepoCopy === null) continue
                offenders.push(`${toRepoRelative(doc)} -> ${link} (in-repo copy: ${inRepoCopy})`)
            }
        }
        assert.deepEqual(
            offenders,
            [],
            `these docs link to the docs site for pages that exist in this repo, so the instruction breaks when the site is unreachable:\n  ${offenders.join('\n  ')}\nUse the in-repo path instead.`,
        )
    })

    it('resolves every relative link to a file that exists', () => {
        const broken = []
        for (const doc of docs) {
            for (const link of readLinks(doc)) {
                if (/^(https?:|mailto:|#)/.test(link)) continue
                const target = link.split('#')[0]
                if (target === '') continue
                const resolved = path.resolve(path.dirname(doc), target)
                if (!fs.existsSync(resolved)) broken.push(`${toRepoRelative(doc)} -> ${link}`)
            }
        }
        assert.deepEqual(broken, [], `relative links that do not resolve:\n  ${broken.join('\n  ')}`)
    })
})
