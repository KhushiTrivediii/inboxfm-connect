import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { FastifyBaseLogger } from 'fastify'

// Packs a built piece's dist folder into an npm-installable .tgz — ustar entries under a
// `package/` root, gzip-compressed, matching what `npm pack` emits for the folder. Dependency-free
// on purpose: the API package carries no tar library and the format subset needed (regular files
// and directories) is small. Symlinks and anything unexpected are skipped rather than packed.
export async function packDistToTarball({ distPath, log }: PackDistParams): Promise<Buffer> {
    const entries = await collectEntries({ dirPath: distPath, relativePath: '' })
    const blocks: Buffer[] = []
    for (const entry of entries) {
        const entryName = `${ROOT_PREFIX}/${entry.relativePath}`
        if (entry.type === 'directory') {
            blocks.push(headerBlock({ name: entryName, size: 0, isDirectory: true }))
            continue
        }
        let data = await readFile(entry.absolutePath)
        if (entry.relativePath === 'package.json') {
            data = rewriteManifestForTarball(data, log)
        }
        blocks.push(headerBlock({ name: entryName, size: data.length, isDirectory: false }))
        blocks.push(data)
        const padding = data.length % BLOCK_SIZE
        if (padding !== 0) {
            blocks.push(Buffer.alloc(BLOCK_SIZE - padding))
        }
    }
    blocks.push(Buffer.alloc(BLOCK_SIZE * 2))
    return gzipSync(Buffer.concat(blocks))
}

const collectEntries = async ({ dirPath, relativePath }: CollectEntriesParams): Promise<TarEntry[]> => {
    const children = await readdir(dirPath, { withFileTypes: true })
    const entries: TarEntry[] = [
        {
            type: 'directory',
            relativePath,
            absolutePath: dirPath,
        },
    ]
    const childEntries = await Promise.all(children
        .filter((child) => !IGNORED_DIRECTORIES.includes(child.name))
        .map(async (child): Promise<TarEntry[]> => {
            const childPath = join(dirPath, child.name)
            const childRelativePath = relativePath === '' ? child.name : `${relativePath}/${child.name}`
            if (child.isDirectory()) {
                return collectEntries({ dirPath: childPath, relativePath: childRelativePath })
            }
            if (child.isFile()) {
                return [
                    {
                        type: 'file',
                        relativePath: childRelativePath,
                        absolutePath: childPath,
                    },
                ]
            }
            return []
        }))
    return [...entries, ...childEntries.flat()]
}

const headerBlock = ({ name, size, isDirectory }: HeaderParams): Buffer => {
    const buffer = Buffer.alloc(BLOCK_SIZE)
    const { prefix, baseName } = splitTarName({ name })
    writeAscii({ buffer, offset: 0, value: baseName })
    writeOctal({ buffer, offset: 100, width: 8, value: isDirectory ? 0o755 : 0o644 })
    writeOctal({ buffer, offset: 108, width: 8, value: 0 })
    writeOctal({ buffer, offset: 116, width: 8, value: 0 })
    writeOctal({ buffer, offset: 124, width: 12, value: size })
    writeOctal({ buffer, offset: 136, width: 12, value: Math.floor(Date.now() / 1000) })
    // The checksum is computed over the header with the checksum field itself filled with spaces.
    buffer.fill(' ', CHECKSUM_OFFSET, CHECKSUM_OFFSET + 8)
    buffer.write(isDirectory ? '5' : '0', 156)
    buffer.write('ustar', 257)
    buffer.write('00', 263)
    if (prefix !== '') {
        writeAscii({ buffer, offset: 345, value: prefix })
    }
    const checksum = buffer.reduce((sum, byte) => sum + byte, 0)
    writeOctal({ buffer, offset: CHECKSUM_OFFSET, width: 7, value: checksum })
    buffer[CHECKSUM_OFFSET + 7] = 0x20
    return buffer
}

const splitTarName = ({ name }: SplitTarNameParams): { prefix: string, baseName: string } => {
    if (name.length <= MAX_NAME_LENGTH) {
        return { prefix: '', baseName: name }
    }
    for (let splitIndex = Math.min(name.length - 1, MAX_PREFIX_LENGTH); splitIndex > 0; splitIndex--) {
        if (name[splitIndex] !== '/') {
            continue
        }
        const prefix = name.slice(0, splitIndex)
        const baseName = name.slice(splitIndex + 1)
        if (prefix.length <= MAX_PREFIX_LENGTH && baseName.length <= MAX_NAME_LENGTH) {
            return { prefix, baseName }
        }
    }
    throw new Error(`Path exceeds ustar name limits: ${name}`)
}

const writeAscii = ({ buffer, offset, value }: WriteAsciiParams): void => {
    buffer.write(value, offset)
}

const writeOctal = ({ buffer, offset, width, value }: WriteOctalParams): void => {
    buffer.write(value.toString(8).padStart(width - 1, '0'), offset)
    buffer[offset + width - 1] = 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function rewriteManifestForTarball(rawContent: Buffer, log?: FastifyBaseLogger): Buffer {
    try {
        const text = rawContent.toString('utf-8')
        const parsed: unknown = JSON.parse(text)
        if (!isRecord(parsed)) {
            return rawContent
        }

        if (typeof parsed['main'] === 'string') {
            parsed['main'] = parsed['main'].replace(/^(\.\/)?dist\//, './')
        }
        else {
            parsed['main'] = './src/index.js'
        }

        if (typeof parsed['types'] === 'string') {
            parsed['types'] = parsed['types'].replace(/^(\.\/)?dist\//, './')
        }

        const dependencies: Record<string, string> = {}
        const rawDeps = parsed['dependencies']
        if (isRecord(rawDeps)) {
            for (const [dep, version] of Object.entries(rawDeps)) {
                const isWorkspace = typeof version === 'string' && version.startsWith('workspace:')
                const isInternal = dep.startsWith('@inboxfm-connect/')
                if (isInternal || typeof version !== 'string' || isWorkspace) {
                    continue
                }
                dependencies[dep] = version.replace(/^[\^~]/, '')
            }
        }
        parsed['dependencies'] = dependencies

        delete parsed['devDependencies']
        delete parsed['peerDependencies']
        delete parsed['scripts']
        delete parsed['bundleDeps']

        return Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf-8')
    }
    catch (error) {
        log?.debug({ error }, 'Failed to rewrite piece manifest for tarball, packing raw content')
        return rawContent
    }
}

const BLOCK_SIZE = 512
const MAX_NAME_LENGTH = 100
const MAX_PREFIX_LENGTH = 155
const CHECKSUM_OFFSET = 148
const ROOT_PREFIX = 'package'
const IGNORED_DIRECTORIES = ['node_modules']

type TarEntry = {
    type: 'file' | 'directory'
    relativePath: string
    absolutePath: string
}

type PackDistParams = {
    distPath: string
    log?: FastifyBaseLogger
}

type CollectEntriesParams = {
    dirPath: string
    relativePath: string
}

type HeaderParams = {
    name: string
    size: number
    isDirectory: boolean
}

type SplitTarNameParams = {
    name: string
}

type WriteAsciiParams = {
    buffer: Buffer
    offset: number
    value: string
}

type WriteOctalParams = {
    buffer: Buffer
    offset: number
    width: number
    value: number
}
