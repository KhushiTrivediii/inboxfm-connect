import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApLogger } from '@inboxfm-connect/server-utils'
import { PackageType, PieceType } from '@inboxfm-connect/shared'
import type { OfficialPiecePackage, PrivatePiecePackage } from '@inboxfm-connect/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidPackageName, isValidPieceVersion, pieceInstaller } from '../../../../src/lib/cache/pieces/piece-installer'

// Module-level variable updated per test so the vi.mock factory can reference it
let testWorkspace = ''

const mockInstall = vi.fn()

vi.mock('../../../../src/lib/utils/bun-runner', () => ({
    bunRunner: () => ({
        install: mockInstall,
    }),
}))

vi.mock('../../../../src/lib/cache/cache-paths', () => ({
    cacheUtils: () => ({
        getGlobalCacheCommonPath: () => testWorkspace,
        getGlobalCachePathLatestVersion: () => testWorkspace,
    }),
}))

function makePiece(name: string, version = '1.0.0'): OfficialPiecePackage {
    return {
        packageType: PackageType.REGISTRY,
        pieceType: PieceType.OFFICIAL,
        pieceName: name,
        pieceVersion: version,
    }
}

function makeArchivePiece(name: string, version = '1.0.0'): PrivatePiecePackage {
    return {
        packageType: PackageType.ARCHIVE,
        pieceType: PieceType.CUSTOM,
        pieceName: name,
        pieceVersion: version,
        archiveId: randomUUID(),
        platformId: 'platform-1',
    }
}

function pieceDirPath(piece: OfficialPiecePackage | PrivatePiecePackage): string {
    return join(testWorkspace, 'pieces', `${piece.pieceName}-${piece.pieceVersion}`)
}

// Filters and folder names are built with node:path, which uses the platform
// separator — assertions must compare against the posix form or they only pass on Linux.
function toPosix(p: string): string {
    return p.split('\\').join('/')
}

function readyFilePath(piece: OfficialPiecePackage | PrivatePiecePackage): string {
    return join(pieceDirPath(piece), 'ready')
}

async function pathExists(p: string): Promise<boolean> {
    return access(p).then(() => true, () => false)
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise
        throw new Error('Expected promise to reject')
    }
    catch (e) {
        return e as Error
    }
}

const fakeLog = {
    level: 'silent',
    silent: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as ApLogger

// Every piece is installed from its bundle link; the dependency value is the engine bundle endpoint.
const bundleSource = { publicApiUrl: 'http://localhost:3000/api/', engineToken: 'test-token' }

const fakeGetSettings = () => ({
    EXECUTION_MODE: 'UNSANDBOXED',
    DEV_PIECES: [] as string[],
    ENVIRONMENT: 'production',
    REUSE_SANDBOX: undefined,
    FLOW_TIMEOUT_SECONDS: 600,
    MAX_FILE_SIZE_MB: 10,
    MAX_FLOW_RUN_LOG_SIZE_MB: 10,
    NETWORK_MODE: 'UNRESTRICTED' as never,
    SANDBOX_MEMORY_LIMIT: '1048576',
    SANDBOX_PROPAGATED_ENV_VARS: [] as string[],
    SSRF_ALLOW_LIST: [] as string[],
})

beforeEach(async () => {
    testWorkspace = join(tmpdir(), `piece-installer-test-${randomUUID()}`)
    await mkdir(testWorkspace, { recursive: true })
    vi.clearAllMocks()
    // The installer downloads each piece tarball from the bundle endpoint via fetch.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('tgz').buffer,
    }))
})

afterEach(() => {
    vi.unstubAllGlobals()
})

afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(testWorkspace, { recursive: true, force: true })
})

describe('pieceInstaller', () => {
    it('batch install succeeds — all pieces marked ready', async () => {
        const piece1 = makePiece('@inboxfm-connect/piece-a')
        const piece2 = makePiece('@inboxfm-connect/piece-b')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall.mockResolvedValueOnce({ output: '' })

        await installer.install({ pieces: [piece1, piece2], includeFilters: true, ...bundleSource })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(await pathExists(readyFilePath(piece1))).toBe(true)
        expect(await pathExists(readyFilePath(piece2))).toBe(true)
    })

    it('batch fails with good and bad piece — good piece marked ready, bad piece rolled back', async () => {
        const good = makePiece('@inboxfm-connect/piece-good')
        const bad = makePiece('@inboxfm-connect/piece-bad')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // batch attempt
            .mockResolvedValueOnce({ output: '' })                           // good individual
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // bad individual

        const error = await captureError(installer.install({ pieces: [good, bad], includeFilters: false, ...bundleSource }))

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain('@inboxfm-connect/piece-bad@1.0.0')
        expect(error.message).not.toContain('@inboxfm-connect/piece-good@1.0.0')
        expect(mockInstall).toHaveBeenCalledTimes(3)

        expect(await pathExists(readyFilePath(good))).toBe(true)
        expect(await pathExists(pieceDirPath(bad))).toBe(false)
    })

    it('batch fails with both pieces bad — both rolled back, error names both', async () => {
        const piece1 = makePiece('@inboxfm-connect/piece-x')
        const piece2 = makePiece('@inboxfm-connect/piece-y')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // batch
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // piece-x individual
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // piece-y individual

        const error = await captureError(installer.install({ pieces: [piece1, piece2], includeFilters: false, ...bundleSource }))

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain('@inboxfm-connect/piece-x@1.0.0')
        expect(error.message).toContain('@inboxfm-connect/piece-y@1.0.0')
        expect(mockInstall).toHaveBeenCalledTimes(3)

        expect(await pathExists(pieceDirPath(piece1))).toBe(false)
        expect(await pathExists(pieceDirPath(piece2))).toBe(false)
    })

    it('single piece fails — rolled back immediately, no individual retry', async () => {
        const piece = makePiece('@inboxfm-connect/piece-solo')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall.mockRejectedValueOnce(new Error('install failure'))

        await expect(installer.install({ pieces: [piece], includeFilters: true, ...bundleSource })).rejects.toThrow('install failure')

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(await pathExists(pieceDirPath(piece))).toBe(false)
    })

    it('piece already installed — bun install never called', async () => {
        const piece = makePiece('@inboxfm-connect/piece-cached')
        const pieceDir = pieceDirPath(piece)

        await mkdir(join(pieceDir, 'node_modules'), { recursive: true })
        await writeFile(join(pieceDir, 'ready'), 'true')

        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)
        await installer.install({ pieces: [piece], includeFilters: true, ...bundleSource })

        expect(mockInstall).not.toHaveBeenCalled()
    })

    it('archive piece installs through bun with a unique suffixed workspace name pointing at its bundle link', async () => {
        const piece = makeArchivePiece('@acme/piece-sample', '0.3.3')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall.mockResolvedValueOnce({ output: '' })

        await installer.install({ pieces: [piece], includeFilters: true, ...bundleSource })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(await pathExists(readyFilePath(piece))).toBe(true)

        // The folder's package.json carries the unique `<pieceName>-<pieceVersion>` workspace name
        // (never the raw piece name) and depends on the locally downloaded bundle.tgz — so multiple
        // cached versions of the same piece can never collide on a bun workspace name.
        const manifest = JSON.parse(await readFile(join(pieceDirPath(piece), 'package.json'), 'utf8'))
        expect(manifest.name).toBe('@acme/piece-sample-0.3.3')
        expect(manifest.dependencies['@acme/piece-sample']).toContain('bundle.tgz')
    })

    it('skips pieces whose name is a relative path — they never reach the shared bun workspace', async () => {
        const good = makePiece('@inboxfm-connect/piece-good')
        // Stale `usedPieces` data from a since-reverted build can carry a relative path as the
        // pieceName. Writing it as a workspace member corrupts the shared bun.lock and breaks every
        // other piece (and cache pre-warm / deploy), so it must be dropped before any member is built.
        const poison = makePiece('../../../common/pieces/@inboxfm-connect/piece-algolia', '0.0.3')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall.mockResolvedValueOnce({ output: '' })

        await installer.install({ pieces: [good, poison], includeFilters: true, ...bundleSource })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect((mockInstall.mock.calls[0]?.[0].filtersPath as string[]).map(toPosix)).toEqual([
            `pieces/${good.pieceName}-${good.pieceVersion}`,
        ])
        expect(await pathExists(readyFilePath(good))).toBe(true)
    })

    it('install made up only of invalid-named pieces is a no-op — bun never runs', async () => {
        const poison = makePiece('../../../common/pieces/@inboxfm-connect/piece-algolia', '0.0.3')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        await installer.install({ pieces: [poison], includeFilters: true, ...bundleSource })

        expect(mockInstall).not.toHaveBeenCalled()
    })

    it('mixes valid and invalid pieces — only valid ones reach bun, both filters present for valid', async () => {
        const goodA = makePiece('@inboxfm-connect/piece-a')
        const goodB = makePiece('piece-b-unscoped')
        const poison1 = makePiece('../../../common/pieces/@inboxfm-connect/piece-x', '0.0.3')
        const poison2 = makePiece('@inboxfm-connect/piece-y/extra', '1.2.3')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall.mockResolvedValueOnce({ output: '' })

        await installer.install({ pieces: [goodA, poison1, goodB, poison2], includeFilters: true, ...bundleSource })

        expect(mockInstall).toHaveBeenCalledOnce()
        const filtersPath = mockInstall.mock.calls[0]?.[0].filtersPath as string[]
        expect(filtersPath).toHaveLength(2)
        expect(filtersPath.some(f => toPosix(f).includes('@inboxfm-connect/piece-a-1.0.0'))).toBe(true)
        expect(filtersPath.some(f => toPosix(f).includes('piece-b-unscoped-1.0.0'))).toBe(true)
        expect(filtersPath.some(f => toPosix(f).includes('piece-x'))).toBe(false)
        expect(filtersPath.some(f => toPosix(f).includes('piece-y'))).toBe(false)
    })

    it('skips pieces whose version escapes the workspace — a poisoned version never reaches bun', async () => {
        // path.join(workspace, 'pieces', `name-<version>`) normalizes `..`/`/` segments in the
        // version just like in the name, so these would land the piece folder outside the
        // workspace (or overwrite the root package.json) if they were not skipped.
        const good = makePiece('@inboxfm-connect/piece-ok', '1.2.3')
        const versionEscape = makePiece('@inboxfm-connect/piece-evil', '1.0.0/../../..')
        const versionTraversal = makePiece('@inboxfm-connect/piece-evil-2', '1.0.0/..')
        const versionAbsolutePath = makePiece('@inboxfm-connect/piece-evil-3', '/opt/critical')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall.mockResolvedValueOnce({ output: '' })

        await installer.install({ pieces: [good, versionEscape, versionTraversal, versionAbsolutePath], includeFilters: true, ...bundleSource })

        expect(mockInstall).toHaveBeenCalledOnce()
        const filtersPath = mockInstall.mock.calls[0]?.[0].filtersPath as string[]
        expect(filtersPath).toHaveLength(1)
        expect(toPosix(filtersPath[0])).toContain('@inboxfm-connect/piece-ok-1.2.3')
        // The poisoned versions never even trigger a bundle fetch.
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
        expect(await pathExists(join(testWorkspace, 'pieces', 'piece-evil-1.0.0'))).toBe(false)
        expect(await pathExists(join(testWorkspace, 'package.json'))).toBe(true)
    })

    it('individual fallback always passes --filter path regardless of includeFilters', async () => {
        const piece1 = makePiece('@inboxfm-connect/piece-filter-a')
        const piece2 = makePiece('@inboxfm-connect/piece-filter-b')
        const installer = pieceInstaller(fakeLog, testWorkspace, fakeGetSettings)

        mockInstall
            .mockRejectedValueOnce(new Error('batch error'))
            .mockResolvedValueOnce({ output: '' })
            .mockResolvedValueOnce({ output: '' })

        // Use includeFilters: false so the batch call has no filters
        await installer.install({ pieces: [piece1, piece2], includeFilters: false, ...bundleSource })

        expect(mockInstall).toHaveBeenCalledTimes(3)

        // Batch call uses empty filtersPath because includeFilters is false
        expect(mockInstall.mock.calls[0]?.[0]).toMatchObject({ filtersPath: [] })

        // Individual calls must always include the --filter path (sequential order)
        expect((mockInstall.mock.calls[1]?.[0].filtersPath as string[]).map(toPosix))
            .toEqual([`pieces/${piece1.pieceName}-${piece1.pieceVersion}`])
        expect((mockInstall.mock.calls[2]?.[0].filtersPath as string[]).map(toPosix))
            .toEqual([`pieces/${piece2.pieceName}-${piece2.pieceVersion}`])
    })
})

describe('isValidPackageName', () => {
    it.each([
        '@inboxfm-connect/piece-algolia',
        '@inboxfm-connect/piece-add-event',
        '@acme/piece-sample',
        // the `<name>-<version>` workspace-member form is itself a single-slash scoped name
        '@inboxfm-connect/piece-algolia-0.0.3',
        'tslib',
        'piece-b-unscoped',
        'lodash.merge',
        '@a/b',
        'a',
    ])('accepts valid package name %j', (name) => {
        expect(isValidPackageName(name)).toBe(true)
    })

    it.each([
        // the production poison: a relative path masquerading as a piece name
        '../../../common/pieces/@inboxfm-connect/piece-algolia',
        '../../../common/pieces/@inboxfm-connect/piece-algolia-0.0.3',
        '..',
        '../foo',
        './foo',
        'foo/..',
        '@inboxfm-connect/..',
        // more than one path segment (scoped names allow exactly one slash)
        '@inboxfm-connect/piece-y/extra',
        'a/b/c',
        'foo/bar',
        // malformed scopes
        '@/name',
        '@scope/',
        // empty
        '',
    ])('rejects invalid package name %j', (name) => {
        expect(isValidPackageName(name)).toBe(false)
    })
})

describe('isValidPieceVersion', () => {
    it.each([
        '1.0.0',
        '0.0.3',
        'latest',
        '^1.2.3',
        '~2.0.0',
        '1.0.0-beta.1',
    ])('accepts valid piece version %j', (version) => {
        expect(isValidPieceVersion(version)).toBe(true)
    })

    it.each([
        // path segments that escape the on-disk piece folder
        '1.0.0/../../..',
        '1.0.0/..',
        '..',
        '../1.0.0',
        'a/b',
        // absolute path in a version key
        '/opt/critical',
        // windows separators
        '1.0.0\\..\\..',
        // empty
        '',
    ])('rejects invalid piece version %j', (version) => {
        expect(isValidPieceVersion(version)).toBe(false)
    })
})
