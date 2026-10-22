import { zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import { FileCompression } from '@inboxfm-connect/shared'
import { describe, expect, it, vi } from 'vitest'
import { fileCompressor } from '../../../src/app/file/file-compressor'

const compress = promisify(zstdCompress)

describe('file compressor decompression-bomb cap (#360)', () => {
    it('round-trips a normal zstd payload under the cap', async () => {
        const data = Buffer.from('hello world'.repeat(100))
        const compressed = await fileCompressor.compress({ data, compression: FileCompression.ZSTD })
        const decompressed = await fileCompressor.decompress({ data: compressed, compression: FileCompression.ZSTD })
        expect(decompressed.equals(data)).toBe(true)
    })

    it('refuses to expand a zstd bomb past the cap instead of allocating it', async () => {
        // 60MB of zeros compresses to a few KB; the cap is 25MB
        const bomb = Buffer.alloc(60 * 1024 * 1024, 0)
        const compressed = await compress(bomb)
        expect(compressed.length).toBeLessThan(100 * 1024)

        await expect(fileCompressor.decompress({ data: compressed, compression: FileCompression.ZSTD }))
            .rejects
            .toThrow()
    })

    it('also caps NONE-marked files that secretly carry zstd bytes', async () => {
        const bomb = Buffer.alloc(60 * 1024 * 1024, 0)
        const compressed = await compress(bomb)

        await expect(fileCompressor.decompress({ data: compressed, compression: FileCompression.NONE }))
            .rejects
            .toThrow()
    })

    it('honors MAX_FILE_SIZE_MB when capping, so operators can raise the ceiling (#362 review)', async () => {
        // The module reads the prop once at import time; vi.resetModules + dynamic
        // import re-evaluates it with the env var set.
        vi.resetModules()
        process.env.AP_MAX_FILE_SIZE_MB = '50'
        try {
            const { fileCompressor: fresh } = await import('../../../src/app/file/file-compressor')
            // 60MB of zeros passes a 50MB... wait, no: 60 > 50. Use a payload under 50MB.
            const payload = Buffer.alloc(45 * 1024 * 1024, 0)
            const compressed = await compress(payload)
            const decompressed = await fresh.decompress({ data: compressed, compression: FileCompression.ZSTD })
            expect(decompressed.length).toBe(45 * 1024 * 1024)
        } finally {
            delete process.env.AP_MAX_FILE_SIZE_MB
        }
    })

    it('falls back to 25MB when MAX_FILE_SIZE_MB is unset (#362 review)', async () => {
        vi.resetModules()
        delete process.env.AP_MAX_FILE_SIZE_MB
        const { fileCompressor: fresh } = await import('../../../src/app/file/file-compressor')
        const bomb = Buffer.alloc(60 * 1024 * 1024, 0)
        const compressed = await compress(bomb)
        await expect(fresh.decompress({ data: compressed, compression: FileCompression.ZSTD }))
            .rejects
            .toThrow()
    })
})
