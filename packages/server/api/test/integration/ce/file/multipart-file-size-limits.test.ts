import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// Issue #367: the multipart registration must carry limits.fileSize so an
// oversized part is aborted by @fastify/multipart BEFORE the onFile handler's
// part.toBuffer() buffers it into memory. AP_MAX_FILE_SIZE_MB defaults to 25.
describe('Multipart upload size limits (#367)', () => {
    it('rejects a multipart file larger than AP_MAX_FILE_SIZE_MB with 413 instead of buffering it', async () => {
        const ctx = await createTestContext(app!)

        const limitMb = Number(process.env.AP_MAX_FILE_SIZE_MB ?? 25)
        const oversized = Buffer.alloc(limitMb * 1024 * 1024 + 1024 * 1024, 1)

        const formData = new FormData()
        formData.append(
            'profilePicture',
            new Blob([oversized], { type: 'image/png' }),
            'oversized.png',
        )

        const response = await ctx.inject({
            method: 'POST',
            url: '/v1/users/me',
            payload: formData,
        })

        // @fastify/multipart aborts the stream once limits.fileSize is crossed:
        // the part never reaches part.toBuffer(), so the request dies with 413
        // (RequestFileTooLargeError) instead of allocating the full body.
        expect(response?.statusCode).toBe(StatusCodes.REQUEST_TOO_LONG)
    })

    it('still accepts a small multipart upload below the cap', async () => {
        const ctx = await createTestContext(app!)

        const small = Buffer.alloc(1024, 7)
        const formData = new FormData()
        formData.append(
            'profilePicture',
            new Blob([small], { type: 'image/png' }),
            'small.png',
        )

        const response = await ctx.inject({
            method: 'POST',
            url: '/v1/users/me',
            payload: formData,
        })

        // The upload proceeds past the multipart layer; the route's own
        // mime/size validations decide the outcome — the important part is
        // that it is NOT a 413 from the multipart limiter.
        expect(response?.statusCode).not.toBe(StatusCodes.REQUEST_TOO_LONG)
    })
})
