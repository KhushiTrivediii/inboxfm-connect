import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Guard against N+1 query patterns in the API server.
//
// `packages/server/AGENTS.md` documents the rule (never issue a query per row inside a
// loop), but until now it was documentation only - nothing failed if a new endpoint
// violated it. This is the same shape as check-license-boundaries.mjs: walk the tracked
// TypeScript with the compiler's own AST and report the pattern.
//
// A site is flagged when a `for`/`for...of`/`for await`/`while` loop body (at any depth)
// contains an `await` whose expression is a call on a repository or service accessor -
// `somethingRepo().findBy(...)`, `userService(log).getOne(...)`. A `Promise.all` over the
// same calls is NOT flagged: it is the batched form this rule is trying to push people
// towards, and rejecting it would be backwards.
//
// Why a site leaving the baseline is silent, while a site entering one is hard-reviewed
// (choksi2212 on #501). Deletion is the whole point of paying the debt down, so the gate
// must never be the thing that punishes it:
//
//   1. A removal complaint punishes exactly the PRs this gate exists to encourage. #104
//      was a debt-cleanup PR; the next one should not have to fight the gate while paying
//      the debt down. A rule that turns green cleanup PRs red gets switched off - that is
//      how gates like this die in practice.
//   2. A removal complaint has no operational response. The contributor replies "yes, I
//      removed it", re-runs --write-baseline, and the noise normalises touching the
//      baseline file for reasons other than "the tree changed".
//   3. Shrinkage is already visible without a complaint: the green run prints the debt
//      count every time, so a cleanup PR shows a lower number in its own CI log and the
//      baseline diff names exactly which keys went.
//
// The debt count is a headline, not a gate. Silence on removal; hard review on
// --write-baseline, which is the only command that can move the list.

// Existing sites are baselined in tools/ci/n-plus-one-baseline.json. New ones fail.

// Scope is packages/server/api/src/app only. packages/server/engine (BullMQ workers and
// flow execution) is NOT scanned, so this is not repo-wide coverage.
const SCAN_ROOTS = ['packages/server/api/src/app']
// An allowlist of known query method names went stale immediately: services legitimately
// call getOneWithPlanOrThrow, getOrCreateWithProject and getOneOrThrowById inside
// loops, and none of those names were on the list. Inverting it - treat every method on
// a repository or service accessor as a query except an explicit list of known
// non-query operations - keeps coverage broad without hand-maintaining a dictionary.
const NON_QUERY_METHODS = new Set([
    // cache and coordination verbs that do not hit the database
    'invalidate', 'clear', 'reset', 'disconnect', 'connect', 'ping', 'flush',
    // promise/value helpers, not persistence calls
    'withTransaction', 'run', 'wrap', 'toPromise',
])

// Match the accessor's *name*, never its argument list: a text match on the whole call
// only accepted `repo()` and `service(identifier)`, so a real accessor call like
// `userService(request.log)` was silently missed by the gate.
const ACCESSOR_NAME = /(?:Repo|Service)$/

function isAccessorCall(node) {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ACCESSOR_NAME.test(node.expression.text)
}

// A loop whose iteration count is driven by data - that is where a per-iteration
// query turns into N+1. `while (true)` / `do {} while` are control-flow constructs
// (drain loops in seeds and cleanup scripts); flagging them would be a false positive.
function isLoop(node) {
    return ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        (ts.isWhileStatement(node) && !isLiteralTrue(node.expression))
}

function isLiteralTrue(expr) {
    return expr.kind === ts.SyntaxKind.TrueKeyword ||
        (ts.isIdentifier(expr) && expr.text === 'true')
}

function isQueryCall(node) {
    if (!ts.isCallExpression(node)) return false
    const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression : null
    if (!callee) return false
    if (NON_QUERY_METHODS.has(callee.name.text)) return false
    const receiver = callee.expression
    // `thingRepo()` / `userService(log)` / `userService(request.log)` - an accessor
    // invoked at the call site.
    if (isAccessorCall(receiver)) return true
    // `const roleService = ...` then `roleService.getOneOrThrowById(...)` - the accessor
    // was bound earlier, but the call still reaches the database once per row.
    if (ts.isIdentifier(receiver) && ACCESSOR_NAME.test(receiver.text)) return true
    return false
}

// Collect EVERY awaited query in the loop body, not just the first: one loop can make
// several per-row calls (user-invitation.service.ts makes four inside the same
// for-of over invitations) and reporting one of them understated the debt.
function awaitedQueriesInLoopBody(loop) {
    const found = []
    const visit = (node) => {
        // Do not descend into nested functions: a closure called later is not executed
        // per-iteration, and a nested loop is reported on its own.
        if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
            ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || isLoop(node)) {
            return
        }
        if (ts.isAwaitExpression(node) && isQueryCall(node.expression)) {
            found.push(node.expression)
        }
        ts.forEachChild(node, visit)
    }
    // Start at the body, never at the loop node itself: an initializer or condition of
    // `for (const x = await repo().findOne(); ...)` runs once, so a query there is not
    // an N+1 and reporting it would send a contributor to the wrong loop.
    //
    // Two asymmetries to keep in mind before changing this (choksi2212 on #501):
    //
    // 1. `while (true)` and `do {} while` are deliberately not loops here - they are the
    //    drain-loop control-flow exception (see isLoop). So a genuine per-row query inside
    //    a do-while drain loop stays unflagged by design.
    // 2. Because of that, do NOT extend this body-only rule to a do-while branch. There
    //    the body runs *before* the condition, so the semantics invert: skipping the
    //    condition there would be right, but for the opposite reason than it is here.
    //    Copying this rule across without inverting it would hide real work.
    visit(loop.statement)
    return found
}

export function findNPlusOneSites({ file, source }) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const sites = []
    const occurrences = new Map()
    const visit = (node) => {
        if (isLoop(node)) {
            for (const call of awaitedQueriesInLoopBody(node)) {
                const { line } = ast.getLineAndCharacterOfPosition(call.getStart(ast))
                const method = call.expression.name.text
                // Occurrence index within (file, method): keying on method alone made
                // a new loop invisible in any file that already had one - the 12
                // baselined findOne calls in project-replace.service.ts shared a key,
                // so a 13th passed the gate. Indexing the occurrence keeps the key
                // unique per site while still tolerating line drift.
                const n = occurrences.get(`${file}|${method}`) ?? 0
                occurrences.set(`${file}|${method}`, n + 1)
                sites.push({
                    file,
                    line: line + 1,
                    method,
                    occurrence: n,
                    snippet: call.getText(ast).replace(/\s+/g, ' ').slice(0, 120),
                })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(ast)
    return sites
}

function listTargets() {
    const files = execFileSync('git', ['ls-files', '-z', ...SCAN_ROOTS], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    }).split('\0').filter(Boolean)
    return files.filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file))
}

function main() {
    const baselinePath = path.join('tools', 'ci', 'n-plus-one-baseline.json')
    const sites = listTargets().flatMap((file) => findNPlusOneSites({ file, source: readFileSync(file, 'utf8') }))

    if (process.argv.includes('--write-baseline')) {
        writeFileSync(baselinePath, JSON.stringify({
            description: 'N+1 query sites found at the time this baseline was taken. Not a target - see packages/server/AGENTS.md. Batch with Promise.all, or hoist the lookup out of the loop.',
            sites: sites.map((s) => `${s.file}:${s.method}#${s.occurrence}`),
        }, null, 2) + '\n')
        console.log(`Recorded ${sites.length} N+1 site(s).`)
        // This is the only command that can move the debt list, so make the review
        // expectation visible at the moment someone reaches for it rather than leaving
        // it to be rediscovered in review.
        console.log('Treat this diff as load-bearing review material: justify every key')
        console.log('that changed in the PR body, not just the ones that were added.')
        return
    }

    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).sites
    const known = new Set(baseline)
    const introduced = sites.filter((s) => !known.has(`${s.file}:${s.method}#${s.occurrence}`))

    if (introduced.length === 0) {
        console.log(`No new N+1 sites. Existing debt: ${sites.length}; see packages/server/AGENTS.md.`)
        return
    }

    console.error('New N+1 query site(s) introduced:')
    for (const site of introduced) {
        console.error(`  ${site.file}:${site.line} (${site.method} #${site.occurrence})  ${site.snippet}`)
    }
    console.error('\nA query inside a loop runs once per row. Batch it:')
    console.error('  const rows = await repo().findBy({ id: In(ids) })   // one query')
    console.error('  await Promise.all(ids.map((id) => repo().findOne({ id })))')
    console.error('Removing a baselined site? Re-run with --write-baseline and include the diff.')
    process.exitCode = 1
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-n-plus-one.mjs') {
    main()
}
