import { spawnSync } from 'node:child_process'

function resolve({ candidate = process.env.CI_BASE_SHA || 'origin/dev', cwd, env = process.env } = {}) {
    const head = commit({ ref: 'HEAD', cwd, env })
    const preferred = commit({ ref: candidate, cwd, env })
    if (preferred) return preferred
    for (const ref of ['origin/main', 'HEAD^']) {
        const fallback = commit({ ref, cwd, env })
        if (fallback && fallback !== head) {
            console.log(`CI base ${candidate} is unavailable; comparing against ${ref}.`)
            return fallback
        }
    }
    if (!head) throw new Error('CI checks require a Git checkout with a HEAD commit.')
    console.log('No earlier CI base is available; checking the initial repository snapshot.')
    return null
}

function commit({ ref, cwd, env }) {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, env, encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : null
}

export const ciBase = { resolve }
