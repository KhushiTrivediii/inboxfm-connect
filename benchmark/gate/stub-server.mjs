import { createServer } from 'node:http'

// Hermetic target for self-tests: proves the gate end to end (load -> compare) without a live
// stack, and lets a known slowdown be injected to confirm the gate actually fails on it.
async function start({ delayMs = 0, errorEvery = 0 }) {
    let served = 0
    const server = createServer((req, res) => {
        served++
        const fail = errorEvery > 0 && served % errorEvery === 0
        setTimeout(() => {
            res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: !fail }))
        }, delayMs)
    })
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const { port } = server.address()
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
    }
}

export const stubServer = { start }
