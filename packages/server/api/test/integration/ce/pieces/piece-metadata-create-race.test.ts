import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import { PackageType, PieceMetadataSchema, PieceType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { pieceMetadataService } from '../../../../src/app/pieces/metadata/piece-metadata-service'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// choksi2212 on #496: the unit suite mocks `runExclusive` to invoke `fn()` directly, so it
// pins the lock key shape and the in-lock re-check but never runs two overlapping create()
// calls through a real RedLock mutex. This suite drives the real distributed lock against a
// real database, so the serialization itself - not just its key - is exercised.
//
// The bug being pinned (issue #475): create() was find-then-insert on
// idx_piece_metadata_name_platform_id_version with no lock and no unique-violation handling.
// Two concurrent installs of the same (name, version, platformId) both passed the existence
// check and both inserted, and the loser's 23505 propagated out as a raw driver error that
// the install path re-wrapped as ENGINE_OPERATION_FAILURE - blaming the engine for what was
// a plain duplicate request.
//
// What must hold after the fix: exactly one row survives, and every loser gets the clean
// piece_metadata_already_exists VALIDATION error instead of a constraint violation.

const PIECE_NAME = 'race-probe-piece'

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
    await databaseConnection()
        .getRepository('integration_metadata')
        .createQueryBuilder()
        .delete()
        .where('name = :name', { name: PIECE_NAME })
        .execute()
})

const isFulfilled = <T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> =>
    result.status === 'fulfilled'

const isRejected = <T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult =>
    result.status === 'rejected'

function rejectionCode(rejection: unknown): string | undefined {
    return rejection instanceof ActivepiecesError ? rejection.error.code : undefined
}

// `params` only exists on some arms of the ApErrorParams union, so narrow on the runtime
// shape rather than casting.
function rejectionMessage(rejection: unknown): string | undefined {
    if (!(rejection instanceof ActivepiecesError)) {
        return undefined
    }
    const { params } = rejection.error
    if (typeof params !== 'object' || params === null || !('message' in params)) {
        return undefined
    }
    const { message } = params
    return typeof message === 'string' ? message : undefined
}

async function installPiece({
    version,
    platformId,
}: {
    version: string
    platformId: string | undefined
}): Promise<PieceMetadataSchema> {
    return pieceMetadataService(app!.log).create({
        pieceMetadata: {
            name: PIECE_NAME,
            version,
            displayName: 'Race Probe Piece',
            logoUrl: 'https://cdn.activepieces.com/pieces/probe.png',
            description: 'a piece',
            categories: [],
            authors: [],
            minimumSupportedRelease: '0.0.0',
            maximumSupportedRelease: '999.999.999',
            actions: {},
            triggers: {},
            i18n: {},
        },
        packageType: PackageType.ARCHIVE,
        platformId,
        pieceType: PieceType.CUSTOM,
        // Deliberately no archiveId: the column carries a RESTRICT foreign key onto `file`,
        // and provisioning a real file row per install would exercise the upload path rather
        // than the natural-key serialization this suite is about.
        publishCacheRefresh: false,
    })
}

describe('pieceMetadataService.create() — overlapping installs on one natural key (#475)', () => {
    it('leaves exactly one row and gives the loser the clean validation error', async () => {
        // Two installs of the same (name, version, platformId) started together: the
        // double-clicked dashboard, the admin retry, or two replicas handling the same
        // provisioning action.
        const results = await Promise.allSettled([
            installPiece({ version: '1.0.0', platformId: ctx.platform.id }),
            installPiece({ version: '1.0.0', platformId: ctx.platform.id }),
        ])

        const winners = results.filter(isFulfilled)
        const losers = results.filter(isRejected)
        expect(winners).to.have.lengthOf(1)
        expect(losers).to.have.lengthOf(1)

        // The loser's failure is the designed validation error, not a raw unique-violation
        // driver error re-wrapped as ENGINE_OPERATION_FAILURE.
        expect(rejectionCode(losers[0]!.reason)).to.be.equal(ErrorCode.VALIDATION)
        expect(rejectionMessage(losers[0]!.reason)).to.contain('piece_metadata_already_exists')

        // One natural key, one row. Two rows here is the #475 bug itself.
        const rows = await db.findManyBy('integration_metadata', {
            name: PIECE_NAME,
            version: '1.0.0',
            platformId: ctx.platform.id,
        })
        expect(rows).to.have.lengthOf(1)

        // The surviving row is the winner's insert, not a merge of both.
        expect(rows[0]!.id).to.be.equal(winners[0]!.value.id)
    })

    it('serializes a burst of five overlapping installs down to a single row', async () => {
        // Same (name, version, platformId) for all five, so all five contend for one row.
        const results = await Promise.allSettled(
            Array.from({ length: 5 }, () =>
                installPiece({ version: '1.0.0', platformId: ctx.platform.id })),
        )

        expect(results.filter(isFulfilled)).to.have.lengthOf(1)
        expect(results.filter(isRejected)).to.have.lengthOf(4)

        // Every loser must have failed the same designed way. A raw 23505 escaping here would
        // mean the mutex let a second insert through before the re-check could see the first.
        for (const loser of results.filter(isRejected)) {
            expect(rejectionCode(loser.reason)).to.be.equal(ErrorCode.VALIDATION)
        }

        const rows = await db.findManyBy('integration_metadata', {
            name: PIECE_NAME,
            version: '1.0.0',
        })
        expect(rows).to.have.lengthOf(1)
    })

    it('does not serialize different versions of the same piece against each other', async () => {
        // The lock key includes the version, so two versions are two different rows and must
        // not queue behind one another. Both succeed and both rows survive.
        const results = await Promise.allSettled([
            installPiece({ version: '1.0.0', platformId: ctx.platform.id }),
            installPiece({ version: '2.0.0', platformId: ctx.platform.id }),
        ])

        expect(results.filter(isFulfilled)).to.have.lengthOf(2)

        const rows = await db.findManyBy('integration_metadata', {
            name: PIECE_NAME,
            platformId: ctx.platform.id,
        })
        expect(rows).to.have.lengthOf(2)
    })

    it('gives a platform-less community install the same clean error on a race', async () => {
        // platformId is null here, so idx_piece_metadata_name_platform_id_version cannot
        // arbitrate - Postgres treats NULLs as distinct, so two NULL rows never collide on the
        // index. The in-lock re-check is the only thing saving this path, which makes it the
        // case most worth proving end to end.
        const results = await Promise.allSettled([
            installPiece({ version: '1.0.0', platformId: undefined }),
            installPiece({ version: '1.0.0', platformId: undefined }),
        ])

        expect(results.filter(isFulfilled)).to.have.lengthOf(1)
        const losers = results.filter(isRejected)
        expect(losers).to.have.lengthOf(1)
        expect(rejectionCode(losers[0]!.reason)).to.be.equal(ErrorCode.VALIDATION)

        const rows = await db.findManyBy('integration_metadata', {
            name: PIECE_NAME,
            version: '1.0.0',
        })
        expect(rows).to.have.lengthOf(1)
    })
})