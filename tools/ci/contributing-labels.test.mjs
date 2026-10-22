import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

// CONTRIBUTING.md told contributors to label PRs with `area/frontend`, `area/backend`,
// `refactor`, `chore` and `docs`. None of those labels exist in this repository - the
// real ones are colon-prefixed (`area:server`, `area:web`) and the real types are
// `documentation`, `enhancement` and `testing`. A contributor following the guide
// verbatim was filing labels that could never be applied.
//
// The label set lives in GitHub rather than the repo, so this test pins the two things
// that actually went wrong and are stable to assert without network access:
//
//   1. no slash-form `area/...` label is documented - the repository uses `area:`.
//      If the project ever adds slash-form areas this test needs revisiting, which is
//      the point: it forces the decision rather than letting the list rot again.
//   2. every label the guide names in its PR Labels section is drawn from the repo's
//      committed taxonomy, recorded in tools/ci/label-taxonomy.json. Update that file
//      from `gh label list --repo Mihir-Rabari/inboxfm-connect` when labels change.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUIDE = path.join(REPO_ROOT, 'CONTRIBUTING.md')
const TAXONOMY = path.join(REPO_ROOT, 'tools', 'ci', 'label-taxonomy.json')

const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY, 'utf8'))
const known = new Set(Object.values(taxonomy).flat())

function guide() {
    return fs.readFileSync(GUIDE, 'utf8')
}

function labelsSection(md) {
    const start = md.indexOf('**PR Labels**')
    assert.notEqual(start, -1, 'CONTRIBUTING.md no longer has a **PR Labels** section')
    const rest = md.slice(start)
    // Stop at the next top-level bullet or heading so the section does not bleed
    // into unrelated content that happens to mention labels.
    const end = rest.slice(1).search(/\n(?:- \*\*|## )/)
    return end === -1 ? rest : rest.slice(0, end + 1)
}

function documentedLabels(md) {
    const section = labelsSection(md)
    // Every inline code span in the section is a candidate label. An earlier version
    // required a `:` or `/` inside the span, which silently skipped plain-word labels
    // like `chore`, `refactor` and `docs` - precisely the drift this test exists to
    // catch, so a mutation restoring the old Types line still passed 4/4.
    //
    // Bare `area:` / `category:` spans are prefix explanations in prose rather than
    // label names, so drop a span that is only a known prefix with nothing after it.
    return [...section.matchAll(/`([^`\s]+)`/g)]
        .map((m) => m[1])
        .filter((token) => /^\w/.test(token))
        .filter((token) => !/^(area|category|size|depth):?$/.test(token))
}

describe('CONTRIBUTING.md PR labels', () => {
    it('documents no label that does not exist', () => {
        const documented = documentedLabels(guide())
        assert.ok(documented.length > 0, 'no labels parsed - the section format changed')
        const unknown = documented.filter((label) => !known.has(label))
        assert.deepEqual(unknown, [],
            `CONTRIBUTING.md documents labels this repository does not have: ${unknown.join(', ')}`)
    })

    it('uses the colon form for areas, not the slash form', () => {
        const slashAreas = documentedLabels(guide()).filter((l) => l.startsWith('area/'))
        assert.deepEqual(slashAreas, [],
            'area labels are `area:server` style in this repository, not `area/frontend`')
    })

    it('does not document the commit-type names as PR labels', () => {
        // `fix(...)`/`feat(...)` are commit scopes, not labels - they were previously
        // listed as label types, which is how `chore` and `refactor` got in there.
        const commitScopes = ['chore', 'refactor', 'docs']
        const present = documentedLabels(guide()).filter((l) => commitScopes.includes(l))
        assert.deepEqual(present, [],
            'commit scopes are not PR labels; use the repository taxonomy instead')
    })

    it('points readers at the live label list', () => {
        assert.match(guide(), /gh label list --repo Mihir-Rabari\/inboxfm-connect/,
            'the guide should tell contributors how to check the live label set')
    })
})