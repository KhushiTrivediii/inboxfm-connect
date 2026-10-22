import { describe, it, expect } from 'vitest'
import {
    FileType,
    FileCompression,
    CONTENT_ENCODING_ZSTD,
    isZstdCompressed,
    FileLocation,
    File,
    maxSocketHttpBufferSizeBytes,
} from '../../src/lib/core/file'

describe('File contracts and utilities', () => {
    describe('FileType enum', () => {
        it('should define expected file types with correct enum values', () => {
            expect(FileType.UNKNOWN).toBe('UNKNOWN')
            expect(FileType.FLOW_RUN_LOG).toBe('FLOW_RUN_LOG')
            expect(FileType.FLOW_RUN_LOG_SLICE).toBe('FLOW_RUN_LOG_SLICE')
            expect(FileType.PACKAGE_ARCHIVE).toBe('PACKAGE_ARCHIVE')
            expect(FileType.FLOW_STEP_FILE).toBe('FLOW_STEP_FILE')
            expect(FileType.SAMPLE_DATA).toBe('SAMPLE_DATA')
            expect(FileType.SAMPLE_DATA_INPUT).toBe('SAMPLE_DATA_INPUT')
            expect(FileType.TRIGGER_EVENT_FILE).toBe('TRIGGER_EVENT_FILE')
            expect(FileType.PROJECT_RELEASE).toBe('PROJECT_RELEASE')
            expect(FileType.FLOW_VERSION_BACKUP).toBe('FLOW_VERSION_BACKUP')
            expect(FileType.PLATFORM_ASSET).toBe('PLATFORM_ASSET')
            expect(FileType.USER_PROFILE_PICTURE).toBe('USER_PROFILE_PICTURE')
            expect(FileType.WEBHOOK_PAYLOAD).toBe('WEBHOOK_PAYLOAD')
            expect(FileType.KNOWLEDGE_BASE).toBe('KNOWLEDGE_BASE')
            expect(FileType.FLOW_BUNDLE).toBe('FLOW_BUNDLE')
        })
    })

    describe('FileCompression and encoding constants', () => {
        it('should export correct compression modes', () => {
            expect(FileCompression.NONE).toBe('NONE')
            expect(FileCompression.ZSTD).toBe('ZSTD')
            expect(CONTENT_ENCODING_ZSTD).toBe('zstd')
        })
    })

    describe('isZstdCompressed', () => {
        it('should return false for data with length less than 4 bytes', () => {
            expect(isZstdCompressed(Buffer.from([]))).toBe(false)
            expect(isZstdCompressed(Buffer.from([0x28]))).toBe(false)
            expect(isZstdCompressed(Buffer.from([0x28, 0xb5]))).toBe(false)
            expect(isZstdCompressed(Buffer.from([0x28, 0xb5, 0x2f]))).toBe(false)

            const emptyUint8 = new Uint8Array([])
            const shortUint8 = new Uint8Array([0x28, 0xb5, 0x2f])
            expect(isZstdCompressed(emptyUint8)).toBe(false)
            expect(isZstdCompressed(shortUint8)).toBe(false)
        })

        it('should identify valid ZSTD magic header (0xFD2FB528 in little-endian)', () => {
            // Little-endian layout: 0x28, 0xB5, 0x2F, 0xFD
            const zstdHeader = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02])
            expect(isZstdCompressed(zstdHeader)).toBe(true)

            const zstdUint8 = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])
            expect(isZstdCompressed(zstdUint8)).toBe(true)
        })

        it('should identify valid skippable frame headers (0x184D2A50 to 0x184D2A5F)', () => {
            // 0x184D2A50 in little-endian: 0x50, 0x2A, 0x4D, 0x18
            const skippableStart = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x04, 0x00, 0x00, 0x00])
            expect(isZstdCompressed(skippableStart)).toBe(true)

            // 0x184D2A5F in little-endian: 0x5F, 0x2A, 0x4D, 0x18
            const skippableEnd = new Uint8Array([0x5f, 0x2a, 0x4d, 0x18, 0x00, 0x00])
            expect(isZstdCompressed(skippableEnd)).toBe(true)

            // Intermediate skippable frame: 0x184D2A55 -> 0x55, 0x2A, 0x4D, 0x18
            const skippableMid = Buffer.from([0x55, 0x2a, 0x4d, 0x18])
            expect(isZstdCompressed(skippableMid)).toBe(true)
        })

        it('should return false for arbitrary or other format magic bytes', () => {
            // Gzip magic: 0x1F, 0x8B
            const gzip = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
            expect(isZstdCompressed(gzip)).toBe(false)

            // Zip magic: PK (0x50, 0x4B, 0x03, 0x04)
            const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04])
            expect(isZstdCompressed(zip)).toBe(false)

            // Random bytes
            const arbitrary = Buffer.from([0x01, 0x02, 0x03, 0x04])
            expect(isZstdCompressed(arbitrary)).toBe(false)
        })
    })

    describe('FileLocation enum', () => {
        it('should define S3 and DB storage locations', () => {
            expect(FileLocation.S3).toBe('S3')
            expect(FileLocation.DB).toBe('DB')
        })
    })

    describe('File zod schema validation', () => {
        const baseValidFile = {
            id: 'file_123',
            created: '2026-10-01T00:00:00.000Z',
            updated: '2026-10-01T00:00:00.000Z',
            projectId: 'proj_456',
            platformId: 'plat_789',
            type: FileType.PACKAGE_ARCHIVE,
            compression: FileCompression.ZSTD,
            location: FileLocation.S3,
            size: 1048576,
            fileName: 'archive.tar.zst',
            s3Key: 'projects/proj_456/archive.tar.zst',
            metadata: { sha256: 'abc123def456' },
        }

        it('should parse a complete valid file object', () => {
            const parsed = File.safeParse(baseValidFile)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.id).toBe('file_123')
                expect(parsed.data.type).toBe(FileType.PACKAGE_ARCHIVE)
                expect(parsed.data.compression).toBe(FileCompression.ZSTD)
                expect(parsed.data.location).toBe(FileLocation.S3)
                expect(parsed.data.metadata).toEqual({ sha256: 'abc123def456' })
            }
        })

        it('should accept null for nullable fields', () => {
            const nullableFile = {
                ...baseValidFile,
                projectId: null,
                platformId: null,
                size: null,
                fileName: null,
                s3Key: null,
                metadata: null,
            }

            const parsed = File.safeParse(nullableFile)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.projectId).toBeNull()
                expect(parsed.data.platformId).toBeNull()
                expect(parsed.data.size).toBeNull()
                expect(parsed.data.fileName).toBeNull()
                expect(parsed.data.s3Key).toBeNull()
                expect(parsed.data.metadata).toBeNull()
            }
        })

        it('should reject invalid file types or missing mandatory fields', () => {
            const invalidType = {
                ...baseValidFile,
                type: 'UNSUPPORTED_TYPE',
            }
            expect(File.safeParse(invalidType).success).toBe(false)

            const invalidLocation = {
                ...baseValidFile,
                location: 'LOCAL_DISK',
            }
            expect(File.safeParse(invalidLocation).success).toBe(false)

            const missingCompression = {
                ...baseValidFile,
                compression: undefined,
            }
            expect(File.safeParse(missingCompression).success).toBe(false)
        })
    })

    describe('maxSocketHttpBufferSizeBytes calculation', () => {
        it('should return floor buffer size (100MB) when requested max size plus overhead is below 100MB', () => {
            const expectedFloorBytes = 100 * 1024 * 1024
            expect(maxSocketHttpBufferSizeBytes(10)).toBe(expectedFloorBytes)
            expect(maxSocketHttpBufferSizeBytes(50)).toBe(expectedFloorBytes)
            expect(maxSocketHttpBufferSizeBytes(95)).toBe(expectedFloorBytes)
            // 96 + 4 overhead = 100
            expect(maxSocketHttpBufferSizeBytes(96)).toBe(expectedFloorBytes)
        })

        it('should add 4MB overhead when requested max size exceeds the 100MB floor', () => {
            // 97 + 4 = 101 MB
            expect(maxSocketHttpBufferSizeBytes(97)).toBe(101 * 1024 * 1024)
            // 120 + 4 = 124 MB
            expect(maxSocketHttpBufferSizeBytes(120)).toBe(124 * 1024 * 1024)
            // 200 + 4 = 204 MB
            expect(maxSocketHttpBufferSizeBytes(200)).toBe(204 * 1024 * 1024)
        })
    })
})
