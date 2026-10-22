import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

// Email copy is user-facing and ships as a build asset, so nothing else in the repo checks it.
// The first two tests reproduce defects that were actually present: a subject/body
// contradiction in the SCIM welcome, and a missing article in the invitation subject.
// The remaining two guard invariants that were already true, to keep the first two from
// creeping back.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const EMAILS_DIR = path.join(REPO_ROOT, 'packages/server/api/src/assets/emails')

function template(name) {
    return fs.readFileSync(path.join(EMAILS_DIR, `${name}.html`), 'utf8')
}

function visibleText(html) {
    return html
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        // <title> is the subject, not body copy, so it is excluded from the visible text.
        .replace(/<title>[\s\S]*?<\/title>/g, ' ')
        .replace(/<[^>]*>/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
}

function titleOf(html) {
    return /<title>([\s\S]*?)<\/title>/.exec(html)?.[1].trim() ?? null
}

describe('transactional email copy', () => {
    it('keeps the SCIM welcome consistent with how the account was actually created', () => {
        const html = template('scim-user-welcome')
        const text = visibleText(html).join(' ')

        // SCIM provisions an account from the identity provider; nothing is "invited".
        assert.ok(
            !/\binvited\b/i.test(text),
            'scim-user-welcome tells a provisioned user they were "invited", which contradicts the subject "Your account has been created"',
        )
        assert.match(text, /account has been created/i)
    })

    it('leads each email with a heading that adds information beyond the subject', () => {
        // project-member-used to lead with "Welcome to <project> 🎉", identical to the subject,
        // and only then state that you had been added and to which role. The heading now
        // carries the role so the body is not restating it.
        const html = template('project-member-added')
        const text = visibleText(html)
        const heading = text.find((line) => line.includes('been added to'))
        const lead = text.find((line) => /start building/i.test(line))

        assert.ok(heading, 'expected a heading naming what happened')
        assert.ok(lead, 'expected a body line describing what to do next')
        assert.notEqual(
            heading.toLowerCase(),
            lead.toLowerCase(),
            'the heading and the body should not say the same thing',
        )
        assert.match(heading, /\{\{role\}\}/, 'the heading should surface the role, the one fact the subject omits')
    })

    it('uses the article in "the <project> project" in the invitation subject', () => {
        const title = titleOf(template('invitation-email'))
        assert.ok(title, 'expected invitation-email to declare a <title> used as the subject')
        assert.match(
            title,
            /invited to the "\{\{projectName\}\}" project ✉️$/,
            'invitation subject should read `invited to the "<project>" project`, not `invited to "<project>" project`',
        )
    })

    it('keeps the invitation <title> and heading in sync', () => {
        const html = template('invitation-email')
        const title = titleOf(html)
        const heading = visibleText(html).find((line) => line.includes('invited to'))
        assert.equal(heading, title, 'the visible heading and the <title> used as the subject have drifted apart')
    })
})
