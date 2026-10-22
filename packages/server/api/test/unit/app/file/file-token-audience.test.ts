import { ErrorCode } from '@inboxfm-connect/core-utils'
import { File, FileCompression, FileType, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileService } from '../../../../src/app/file/file.service'
import { JwtAudience, JwtSignAlgorithm, jwtUtils } from '../../../../src/app/helper/jwt-utils'

const mockLog: FastifyBaseLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    silent: vi.fn(),
} as unknown as FastifyBaseLogger

describe('fileService.getFileByToken audience enforcement (Issue #165)', () => {
    const SECRET = 'test-file-token-secret-1234567890'

    beforeEach(() => {
        vi.restoreAllMocks()
        vi.spyOn(jwtUtils, 'getJwtSecret').mockResolvedValue(SECRET)
    })

    it('successfully decodes and returns file when token has JwtAudience.FILE_READ', async () => {
        const fileId = 'file_123'
        const validToken = await jwtUtils.sign({
            payload: {
                fileId,
                fileType: FileType.FLOW_STEP_FILE,
            },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            audience: JwtAudience.FILE_READ,
            expiresInSeconds: 300,
        })

        const decoded = jwtUtils.decode<{ aud?: string }>({ jwt: validToken })
        expect(decoded.payload.aud).toBe(JwtAudience.FILE_READ)

        const mockFile: File = {
            id: fileId,
            projectId: 'proj_123',
            platformId: 'plat_123',
            type: FileType.FLOW_STEP_FILE,
            fileName: 'step_result.json',
            compression: FileCompression.NONE,
            size: 100,
            metadata: {},
            created: '2026-09-27T00:00:00.000Z',
            updated: '2026-09-27T00:00:00.000Z',
            data: Buffer.from('test data'),
        }

        const service = fileService(mockLog)
        const getFileOrThrowSpy = vi.spyOn(service, 'getFileOrThrow').mockResolvedValue(mockFile)
        const result = await service.getFileByToken(validToken)

        expect(result.id).toBe(fileId)
        expect(result.type).toBe(FileType.FLOW_STEP_FILE)
        expect(getFileOrThrowSpy).toHaveBeenCalledWith({ fileId, type: FileType.FLOW_STEP_FILE })
    })

    it('successfully handles compressed GZIP files with valid FILE_READ token', async () => {
        const fileId = 'file_gzip_123'
        const validToken = await jwtUtils.sign({
            payload: {
                fileId,
                fileType: FileType.FLOW_STEP_FILE,
            },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            audience: JwtAudience.FILE_READ,
            expiresInSeconds: 300,
        })

        const mockGzipFile: File = {
            id: fileId,
            projectId: 'proj_123',
            platformId: 'plat_123',
            type: FileType.FLOW_STEP_FILE,
            fileName: 'step_result_compressed.json',
            compression: FileCompression.GZIP,
            size: 250,
            metadata: {},
            created: '2026-09-27T00:00:00.000Z',
            updated: '2026-09-27T00:00:00.000Z',
            data: Buffer.from('gzip compressed payload'),
        }

        const service = fileService(mockLog)
        const getFileOrThrowSpy = vi.spyOn(service, 'getFileOrThrow').mockResolvedValue(mockGzipFile)
        const result = await service.getFileByToken(validToken)

        expect(result.id).toBe(fileId)
        expect(result.compression).toBe(FileCompression.GZIP)
        expect(getFileOrThrowSpy).toHaveBeenCalledWith({ fileId, type: FileType.FLOW_STEP_FILE })
    })

    it('rejects token without audience with INVALID_BEARER_TOKEN', async () => {
        const tokenWithoutAudience = await jwtUtils.sign({
            payload: {
                fileId: 'file_123',
                fileType: FileType.FLOW_STEP_FILE,
            },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            expiresInSeconds: 300,
        })

        const service = fileService(mockLog)
        await expect(service.getFileByToken(tokenWithoutAudience)).rejects.toMatchObject({
            error: {
                code: ErrorCode.INVALID_BEARER_TOKEN,
            },
        })
    })

    it('rejects token signed with foreign audience with INVALID_BEARER_TOKEN', async () => {
        const foreignAudienceToken = await jwtUtils.sign({
            payload: {
                fileId: 'file_123',
                fileType: FileType.FLOW_STEP_FILE,
            },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            audience: JwtAudience.USER_INVITATION,
            expiresInSeconds: 300,
        })

        const service = fileService(mockLog)
        await expect(service.getFileByToken(foreignAudienceToken)).rejects.toMatchObject({
            error: {
                code: ErrorCode.INVALID_BEARER_TOKEN,
            },
        })
    })

    it('rejects token signed with MCP OAuth audience with INVALID_BEARER_TOKEN', async () => {
        const mcpToken = await jwtUtils.sign({
            payload: {
                fileId: 'file_123',
                fileType: FileType.FLOW_STEP_FILE,
            },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            audience: JwtAudience.MCP_OAUTH_ACCESS,
            expiresInSeconds: 300,
        })

        const service = fileService(mockLog)
        await expect(service.getFileByToken(mcpToken)).rejects.toMatchObject({
            error: {
                code: ErrorCode.INVALID_BEARER_TOKEN,
            },
        })
    })

    it('rejects real session principal token without audience with INVALID_BEARER_TOKEN', async () => {
        const sessionPrincipalToken = await jwtUtils.sign({
            payload: {
                id: 'user_456',
                type: PrincipalType.USER,
                projectId: 'proj_123',
            },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            expiresInSeconds: 300,
        })

        const service = fileService(mockLog)
        await expect(service.getFileByToken(sessionPrincipalToken)).rejects.toMatchObject({
            error: {
                code: ErrorCode.INVALID_BEARER_TOKEN,
            },
        })
    })
})
