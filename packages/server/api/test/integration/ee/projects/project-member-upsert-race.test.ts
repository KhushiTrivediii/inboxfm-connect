import { DefaultProjectRole, ProjectRole } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { vi } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { projectMemberService } from '../../../../src/app/ee/projects/project-members/project-member.service'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

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
})

describe('projectMemberService.upsert() — concurrent first-writes', () => {
    it('resolves both concurrent upserts to the SAME member row (no PK flip)', async () => {
        const projectRole = await db.findOneByOrFail<ProjectRole>('project_role', {
            name: DefaultProjectRole.EDITOR,
        })
        expect(projectRole).toBeDefined()

        // Two concurrent first-writes for the same (projectId, userId, platformId).
        // Pre-fix: repo().upsert() DO UPDATE set includes `id` (TypeORM 0.3.x
        // derives overwrite columns from the entity minus the conflict paths),
        // so the loser's fresh apId OVERWRITES the winner's primary key and
        // both findOneOrFail read-backs hit the loser's phantom id -> 500.
        const results = await Promise.allSettled([
            projectMemberService(app!.log).upsert({
                userId: ctx.user.id,
                projectId: ctx.project.id,
                projectRoleName: DefaultProjectRole.EDITOR,
            }),
            projectMemberService(app!.log).upsert({
                userId: ctx.user.id,
                projectId: ctx.project.id,
                projectRoleName: DefaultProjectRole.EDITOR,
            }),
        ])

        // Both calls must resolve (no 500 from findOneOrFail on a phantom id).
        for (const result of results) {
            expect(result.status).to.be.equal('fulfilled', `upsert rejected: ${JSON.stringify(result)}`)
        }

        // Exactly one row exists and BOTH calls returned that same row id.
        const rows = await db.findManyBy('project_member', {
            projectId: ctx.project.id,
            userId: ctx.user.id,
            platformId: ctx.platform.id,
        })
        expect(rows).to.have.lengthOf(1)

        const rowId = rows[0]!.id
        for (const result of results) {
            if (result.status === 'fulfilled') {
                expect(result.value.id).to.be.equal(rowId)
            }
        }
    })

    it('deterministically exercises the unique-index conflict branch: insert against an existing row keeps the winner id', async () => {
        // Force the conflict path: upsert() must see "no existing member" so it
        // generates a fresh apId and inserts into a natural key that already
        // has a row — exactly what a racing loser does after the winner's
        // transaction landed between the loser's findOneBy and its insert.
        const winner = await projectMemberService(app!.log).upsert({
            userId: ctx.user.id,
            projectId: ctx.project.id,
            projectRoleName: DefaultProjectRole.EDITOR,
        })
        expect(winner.id).toBeDefined()

        const memberRepo = databaseConnection().getRepository('project_member')
        const originalFindOneBy = memberRepo.findOneBy.bind(memberRepo)
        let probeIntercepted = false
        vi.spyOn(memberRepo, 'findOneBy')
            .mockImplementation(async (where) => {
                const criteria = where as Record<string, string>
                // Intercept ONLY the first existence probe (projectId+userId+
                // platformId) — the upsert's read-back runs after the insert
                // and must see the real row.
                if (!probeIntercepted
                    && criteria.userId === ctx.user.id
                    && criteria.projectId === ctx.project.id
                    && criteria.platformId === ctx.platform.id) {
                    probeIntercepted = true
                    return null
                }
                return originalFindOneBy(where)
            })

        try {
            const loser = await projectMemberService(app!.log).upsert({
                userId: ctx.user.id,
                projectId: ctx.project.id,
                projectRoleName: DefaultProjectRole.EDITOR,
            })

            // The losing call resolves to the SAME surviving row — its fresh
            // apId was discarded, not written over the winner's primary key.
            expect(loser.id).to.be.equal(winner.id)

            const rows = await db.findManyBy('project_member', {
                projectId: ctx.project.id,
                userId: ctx.user.id,
            })
            expect(rows).to.have.lengthOf(1)
            expect(rows[0]!.id).to.be.equal(winner.id)
        }
        finally {
            vi.restoreAllMocks()
        }
    })

    it('second sequential upsert updates the existing row in place (id stable)', async () => {
        const first = await projectMemberService(app!.log).upsert({
            userId: ctx.user.id,
            projectId: ctx.project.id,
            projectRoleName: DefaultProjectRole.EDITOR,
        })

        const second = await projectMemberService(app!.log).upsert({
            userId: ctx.user.id,
            projectId: ctx.project.id,
            projectRoleName: DefaultProjectRole.EDITOR,
        })

        expect(first.id).to.be.equal(second.id)

        const rows = await db.findManyBy('project_member', {
            projectId: ctx.project.id,
            userId: ctx.user.id,
        })
        expect(rows).to.have.lengthOf(1)
        expect(rows[0]!.id).to.be.equal(second.id)
    })
})
