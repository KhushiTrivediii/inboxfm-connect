import { apId, ErrorCode } from '@inboxfm-connect/core-utils'
import { FileCompression, FileLocation, FileType, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fileRepo } from '../../../../src/app/file/file.service'
import { generateMockToken } from '../../../helpers/auth'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function engineToken(projectId: string, platformId: string): Promise<string> {
    return generateMockToken({
        type: PrincipalType.ENGINE,
        id: apId(),
        projectId,
        platform: { id: platformId },
    })
}

function putFile(token: string, fileId: string, fileName: string, content: string) {
    return app!.inject({
        method: 'PUT',
        url: `/api/v1/files/${fileId}`,
        query: { token },
        headers: {
            'content-type': 'application/octet-stream',
            'x-ap-file-type': FileType.FLOW_STEP_FILE,
            'x-ap-file-name': fileName,
        },
        payload: Buffer.from(content),
    })
}

async function seedPlatformScopedFile(fileId: string, platformId: string, fileName: string): Promise<void> {
    await fileRepo().save({
        id: fileId,
        projectId: null,
        platformId,
        type: FileType.FLOW_STEP_FILE,
        compression: FileCompression.NONE,
        location: FileLocation.DB,
        fileName,
        size: 22,
        data: Buffer.from('platform-shared bytes'),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
    })
}

describe('Files Controller — cross-project PUT ownership', () => {
    it('rejects an engine PUT over a file id owned by another project with 403 AUTHORIZATION', async () => {
        // Project A (victim) saves a step file with its own engine token.
        const victimSetup = await mockAndSaveBasicSetup()
        const victimToken = await engineToken(victimSetup.mockProject.id, victimSetup.mockPlatform.id)
        const fileId = apId()

        const firstPut = await putFile(victimToken, fileId, 'victim.txt', 'victim-owned content')
        expect(firstPut?.statusCode).toBe(StatusCodes.OK)

        const saved = await fileRepo().findOneByOrFail({ id: fileId })
        expect(saved.projectId).toBe(victimSetup.mockProject.id)

        // Project B (attacker, same platform) tries to overwrite the same file id.
        const attackerSetup = await mockAndSaveBasicSetup({ platform: victimSetup.mockPlatform })
        const attackerToken = await engineToken(attackerSetup.mockProject.id, attackerSetup.mockPlatform.id)

        const secondPut = await putFile(attackerToken, fileId, 'attacker.txt', 'attacker overwrite')

        // Must be denied: the file id belongs to another project.
        expect(secondPut?.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(secondPut?.json<{ code?: string }>()?.code).toBe(ErrorCode.AUTHORIZATION)

        // And the victim row is untouched.
        const after = await fileRepo().findOneByOrFail({ id: fileId })
        expect(after.projectId).toBe(victimSetup.mockProject.id)
        expect(after.fileName).toBe('victim.txt')
    })

    it('arbitrates concurrent first writes of the same fresh id: exactly one 200, one 403, row stays the winner\'s', async () => {
        // No mocks and no barriers: the primary key arbitrates inside the database.
        // The conditional claim matches nothing for a fresh id, so both writers race
        // to INSERT the same primary key — exactly one wins, the loser's insert
        // conflicts and the caller must hear 403. The pre-claim check-then-write
        // code let both writers pass an absent-row check, so both PUTs answered 200
        // and the later save silently re-owned the row. Five rounds make the
        // regression loud.
        const setupA = await mockAndSaveBasicSetup()
        const tokenA = await engineToken(setupA.mockProject.id, setupA.mockPlatform.id)
        const setupB = await mockAndSaveBasicSetup()
        const tokenB = await engineToken(setupB.mockProject.id, setupB.mockPlatform.id)

        for (let attempt = 1; attempt <= 5; attempt++) {
            const contestedId = apId()
            const [resA, resB] = await Promise.all([
                putFile(tokenA, contestedId, `a-${attempt}.txt`, `A-writes-${attempt}`),
                putFile(tokenB, contestedId, `b-${attempt}.txt`, `B-writes-${attempt}`),
            ])

            const statuses = [resA?.statusCode, resB?.statusCode].sort()
            expect(statuses, `attempt ${attempt}: both writers must not both succeed`).toEqual([StatusCodes.OK, StatusCodes.FORBIDDEN])

            // The 200 responder is the winner; the row must be theirs and only theirs.
            const winnerIsA = resA?.statusCode === StatusCodes.OK
            const row = await fileRepo().findOneByOrFail({ id: contestedId })
            expect(row.projectId, `attempt ${attempt}: row must keep the winner's project`).toBe(winnerIsA ? setupA.mockProject.id : setupB.mockProject.id)
            expect(row.fileName, `attempt ${attempt}: row must keep the winner's content`).toBe(winnerIsA ? `a-${attempt}.txt` : `b-${attempt}.txt`)
        }
    })

    it('forced interleave: the writer parked mid-request cannot be overwritten by the loser', async () => {
        // Deterministic proof of the concurrent-first-write invariant, independent
        // of scheduler timing. The first request to WIN its claim is parked after
        // winning (at its post-claim read-back) until the OTHER request has fully
        // settled (or a 2s bound lapses so the suite can never hang). A
        // check-then-write implementation lets the other request pass its
        // absent-row check while this winner is parked mid-request, so both PUTs
        // answer 200 and the parked writer's later save clobbers the loser's row —
        // exactly the interleaving the ownership claim must make impossible. (At
        // the pre-claim head c72b1719 this test failed with statuses [200, 200].)
        const setupA = await mockAndSaveBasicSetup()
        const tokenA = await engineToken(setupA.mockProject.id, setupA.mockPlatform.id)
        const setupB = await mockAndSaveBasicSetup()
        const tokenB = await engineToken(setupB.mockProject.id, setupB.mockPlatform.id)
        const contestedId = apId()

        let firstWriterParked = false
        let releaseFirstWriter: (() => void) | undefined
        const firstWriterGate = new Promise<void>(resolve => {
            releaseFirstWriter = resolve
        })
        const realFindOneByOrFail = fileRepo().findOneByOrFail.bind(fileRepo())
        vi.spyOn(fileRepo(), 'findOneByOrFail').mockImplementation(async (...args) => {
            // Park only the request whose claim won the fresh id (its read-back
            // looks up the contested id); the loser's claim never reaches a
            // read-back because it is rejected with 403 first.
            const looksUpContestedId = (args[0] as { id?: string })?.id === contestedId
            if (looksUpContestedId && !firstWriterParked) {
                firstWriterParked = true
                await Promise.race([
                    firstWriterGate,
                    new Promise<void>(resolve => setTimeout(resolve, 2_000)),
                ])
            }
            return realFindOneByOrFail(...(args as Parameters<typeof realFindOneByOrFail>))
        })

        try {
            const requestA = putFile(tokenA, contestedId, 'a.txt', 'A-writes')
            const requestB = putFile(tokenB, contestedId, 'b.txt', 'B-writes')
            // Whichever request LOST its claim settles without a park: it answered
            // 403 without ever writing. The winner stays parked until then.
            const [resA, resB] = await Promise.all([requestA, requestB])
            releaseFirstWriter?.()

            const statuses = [resA?.statusCode, resB?.statusCode].sort()
            expect(statuses, 'both writers must not both succeed under a forced interleave').toEqual([StatusCodes.OK, StatusCodes.FORBIDDEN])

            const winnerIsA = resA?.statusCode === StatusCodes.OK
            const row = await fileRepo().findOneByOrFail({ id: contestedId })
            expect(row.projectId).toBe(winnerIsA ? setupA.mockProject.id : setupB.mockProject.id)
            expect(row.fileName).toBe(winnerIsA ? 'a.txt' : 'b.txt')
        }
        finally {
            vi.restoreAllMocks()
        }
    })

    it('still allows the owning project to re-PUT its own file id (retry path)', async () => {
        const setup = await mockAndSaveBasicSetup()
        const token = await engineToken(setup.mockProject.id, setup.mockPlatform.id)
        const fileId = apId()

        const first = await putFile(token, fileId, 'first.txt', 'first write')
        expect(first?.statusCode).toBe(StatusCodes.OK)

        const second = await putFile(token, fileId, 'retry.txt', 'retry write')
        expect(second?.statusCode).toBe(StatusCodes.OK)

        const after = await fileRepo().findOneByOrFail({ id: fileId })
        expect(after.projectId).toBe(setup.mockProject.id)
        expect(after.fileName).toBe('retry.txt')
    })

    it('rejects an engine PUT from another platform over a platform-scoped file row', async () => {
        const victimSetup = await mockAndSaveBasicSetup()
        const fileId = apId()
        await seedPlatformScopedFile(fileId, victimSetup.mockPlatform.id, 'platform-shared.txt')

        // Attacker project lives on a DIFFERENT platform: the platform leg of the
        // ownership predicate must fail even though the row's projectId is NULL.
        const attackerSetup = await mockAndSaveBasicSetup()
        const attackerToken = await engineToken(attackerSetup.mockProject.id, attackerSetup.mockPlatform.id)

        const res = await putFile(attackerToken, fileId, 'attacker.txt', 'attacker overwrite')

        expect(res?.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(res?.json<{ code?: string }>()?.code).toBe(ErrorCode.AUTHORIZATION)

        const after = await fileRepo().findOneByOrFail({ id: fileId })
        expect(after.projectId).toBeNull()
        expect(after.platformId).toBe(victimSetup.mockPlatform.id)
        expect(after.fileName).toBe('platform-shared.txt')
    })

    it('allows a same-platform project to PUT over a platform-scoped (projectId NULL) file row', async () => {
        // Pins the intentional semantics: rows with a NULL projectId are
        // platform-shared assets — any project on that platform may rewrite them.
        // This is deliberate; do not tighten the predicate.
        const victimSetup = await mockAndSaveBasicSetup()
        const fileId = apId()
        await seedPlatformScopedFile(fileId, victimSetup.mockPlatform.id, 'platform-shared.txt')

        const samePlatformSetup = await mockAndSaveBasicSetup({ platform: victimSetup.mockPlatform })
        const token = await engineToken(samePlatformSetup.mockProject.id, samePlatformSetup.mockPlatform.id)

        const res = await putFile(token, fileId, 'same-platform.txt', 'same-platform rewrite')

        expect(res?.statusCode).toBe(StatusCodes.OK)
        const after = await fileRepo().findOneByOrFail({ id: fileId })
        expect(after.projectId).toBe(samePlatformSetup.mockProject.id)
        expect(after.fileName).toBe('same-platform.txt')
    })
})
