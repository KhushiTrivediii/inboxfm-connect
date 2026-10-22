import { ActivepiecesError, apId, assertEqual, assertNotNullOrUndefined, ErrorCode, isNil, ProjectRole, SeekPage, spreadIfDefined, unique } from '@inboxfm-connect/core-utils'
import { InvitationStatus, InvitationType, PlatformRole, UserInvitation, UserInvitationWithLink } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { In, IsNull } from 'typeorm'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { distributedLock } from '../database/redis-connections'
import { projectMemberService } from '../ee/projects/project-members/project-member.service'
import { projectRoleRepo, projectRoleService } from '../ee/projects/project-role/project-role.service'
import { domainHelper } from '../helper/domain-helper'
import { emailService } from '../helper/email/email.service'
import { smtpEmailSender } from '../helper/email/smtp-email-sender'
import { JwtAudience, jwtUtils } from '../helper/jwt-utils'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { platformService } from '../platform/platform.service'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { UserInvitationEntity } from './user-invitation.entity'

const repo = repoFactory(UserInvitationEntity)

// Serialize overlapping create() calls for the same natural key. The previous
// shape was a single repo().upsert() with conflict paths (email, platformId,
// projectId), which fails two ways:
//   1. PLATFORM invitations store projectId = NULL, and a Postgres unique index
//      never matches on NULL - ON CONFLICT cannot fire, so every re-invite
//      INSERTED a duplicate row (each one sends another email; deleting one
//      leaves the others alive).
//   2. TypeORM's DO UPDATE column set is derived from the entity minus the
//      conflict paths, so it included the fresh id: on the paths where the
//      conflict DID fire (PROJECT invitations), the row's primary key was
//      rotated to the new id, stranding every invitation link already sent
//      (the JWT embeds the old id and the row is fetched by it).
// resolve-then-act under a lock (the app-connection upsert pattern) keeps the
// existing row and its id stable on re-invite. The unique index stays as the
// final guard: a lock-miss loser that races the winner's insert loses its own
// insert and re-reads the winner's row.
function buildInvitationUpsertLockKey({ email, platformId, projectId }: { email: string, platformId: string, projectId: string | null }): string {
    return ['user-invitation', 'upsert', platformId, email.toLowerCase().trim(), isNil(projectId) ? 'no-project' : projectId].join(':')
}

async function runUpsertExclusiveOrWithoutLock<T>({ email, platformId, projectId, fn, log }: {
    email: string
    platformId: string
    projectId: string | null
    fn: (params: { lockAcquired: boolean }) => Promise<T>
    log: FastifyBaseLogger
}): Promise<T> {
    const key = buildInvitationUpsertLockKey({ email, platformId, projectId })
    let fnSettled = false
    try {
        return await distributedLock(log).runExclusive({
            key,
            timeoutInSeconds: 60,
            fn: async () => {
                try {
                    return await fn({ lockAcquired: true })
                }
                finally {
                    // Mark settled on EVERY exit path (throw AND success) so a
                    // lock-infra error after a successful fn cannot fail open and
                    // run fn a second time.
                    fnSettled = true
                }
            },
        })
    }
    catch (error) {
        if (fnSettled) {
            throw error
        }
        log.warn({ error, lockKey: key }, 'User invitation upsert lock unavailable - failing open')
        return fn({ lockAcquired: false })
    }
}

// The natural key of an invitation is (email, platformId, projectId), but the
// email match must be case-insensitive: writes normalize the email to lowercase,
// so mixed-case rows can only come from outside this service - a raw-equality
// lookup would miss them and insert a logical duplicate. Same LOWER() shape the
// service already uses in provisionUserInvitation / hasAnyAcceptedInvitations.
async function findInvitationByNaturalKey({ email, platformId, projectId }: { email: string, platformId: string, projectId: string | null }): Promise<UserInvitation | null> {
    const queryBuilder = repo()
        .createQueryBuilder('user_invitation')
        .where('LOWER("user_invitation"."email") = :email', { email: email.toLowerCase().trim() })
        .andWhere('"user_invitation"."platformId" = :platformId', { platformId })
    if (isNil(projectId)) {
        // The row's projectId is NULL for PLATFORM invitations, so the lookup must
        // query NULL explicitly - an equality on undefined never matches.
        return queryBuilder.andWhere('"user_invitation"."projectId" IS NULL').getOne()
    }
    return queryBuilder.andWhere('"user_invitation"."projectId" = :projectId', { projectId }).getOne()
}

function isUniqueConstraintViolation(error: unknown): boolean {
    // Postgres unique-violation driver code (SQLSTATE 23505), gated on the driver
    // code the same way as the approved #460 helper: the two drivers pinned in
    // this repo (pg 8.11.3, @electric-sql/pglite 0.3.14) do not always surface
    // the code on the same property, so match both the top-level error and the
    // wrapped driverError. Any other failure must propagate raw.
    const candidate = error as { code?: string, driverError?: { code?: string } } | null | undefined
    return candidate?.code === '23505' || candidate?.driverError?.code === '23505'
}

export const userInvitationsService = (log: FastifyBaseLogger) => ({
    async getOneByInvitationTokenOrThrow(invitationToken: string): Promise<UserInvitation> {
        const decodedToken = await jwtUtils.decodeAndVerify<UserInvitationToken>({
            jwt: invitationToken,
            key: await jwtUtils.getJwtSecret(),
            audience: JwtAudience.USER_INVITATION,
        })
        const invitation = await repo().findOneBy({
            id: decodedToken.id,
        })
        if (isNil(invitation)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: `id=${decodedToken.id}`,
                    entityType: 'UserInvitation',
                },
            })
        }
        return invitation
    },
    async provisionUserInvitation({ email }: ProvisionUserInvitationParams): Promise<void> {
        const invitations = await repo().createQueryBuilder('user_invitation')
            .where('LOWER("user_invitation"."email") = :email', { email: email.toLowerCase().trim() })
            .andWhere({
                status: InvitationStatus.ACCEPTED,
            })
            .getMany()

        if (invitations.length === 0) return

        const identity = await userIdentityService(log).getIdentityByEmail(email)
        if (isNil(identity)) return

        log.info({ count: invitations.length }, '[provisionUserInvitation] list invitations')
        for (const invitation of invitations) {
            log.info({ invitation }, '[provisionUserInvitation] provision')
            const user = await userService(log).getOrCreateWithProject({
                identity,
                platformId: invitation.platformId,
            })
            switch (invitation.type) {
                case InvitationType.PLATFORM: {
                    assertNotNullOrUndefined(invitation.platformRole, 'platformRole')
                    await userService(log).update({
                        id: user.id,
                        platformId: invitation.platformId,
                        platformRole: invitation.platformRole,
                    })
                    break
                }
                case InvitationType.PROJECT: {
                    const { projectId, projectRoleId } = invitation
                    assertNotNullOrUndefined(projectId, 'projectId')
                    assertNotNullOrUndefined(projectRoleId, 'projectRoleId')
                    const platform = await platformService(log).getOneWithPlanOrThrow(invitation.platformId)
                    assertEqual(platform.plan.projectRolesEnabled, true, 'Project roles are not enabled', 'PROJECT_ROLES_NOT_ENABLED')

                    const projectRole = await projectRoleService.getOneOrThrowById({
                        id: projectRoleId,
                    })

                    const project = await projectService(log).exists({
                        projectId,
                        isSoftDeleted: false,
                    })
                    if (!isNil(project)) {
                        await projectMemberService(log).upsert({
                            projectId,
                            userId: user.id,
                            projectRoleName: projectRole.name,
                        })
                    }
                    break
                }
            }
            await repo().delete({
                id: invitation.id,
            })
        }
    },
    async create({
        email,
        platformId,
        projectId,
        type,
        projectRoleId,
        platformRole,
        invitationExpirySeconds,
        status,
    }: CreateParams): Promise<UserInvitationWithLink> {
        const normalizedEmail = email.toLowerCase().trim()
        // PLATFORM invitations carry no project; normalize to an explicit null so
        // every natural-key lookup below queries NULL instead of skipping the
        // column (an equality on undefined never matches a NULL row).
        const naturalProjectId = type === InvitationType.PLATFORM ? null : projectId
        // The route contract guarantees role payloads per type; null is the
        // correct stored value for the other type's column (the natural key
        // (email, platformId, projectId) pins the type of every row in it).
        const platformRoleToUpdate = type === InvitationType.PLATFORM ? platformRole : null
        const projectRoleIdToUpdate = type === InvitationType.PROJECT ? projectRoleId : null

        const userInvitation = await runUpsertExclusiveOrWithoutLock({
            email: normalizedEmail,
            platformId,
            projectId: naturalProjectId,
            log,
            fn: async ({ lockAcquired }) => {
                const existing = await findInvitationByNaturalKey({ email: normalizedEmail, platformId, projectId: naturalProjectId })

                if (!isNil(existing)) {
                    // Re-invite: update the existing row IN PLACE. The id is never
                    // touched, so every invitation link already emailed (the JWT
                    // embeds this id) keeps resolving, and no duplicate row is
                    // created. Re-read afterwards so the response and the
                    // invitation email carry the fresh values, not the pre-update
                    // snapshot.
                    await repo().update(existing.id, {
                        status,
                        type,
                        platformRole: platformRoleToUpdate,
                        projectRoleId: projectRoleIdToUpdate,
                        projectId: naturalProjectId,
                    })
                    return this.getOneOrThrow({ id: existing.id, platformId })
                }

                const id = apId()
                try {
                    await repo().save({
                        id,
                        status,
                        type,
                        email: normalizedEmail,
                        platformId,
                        projectRoleId: projectRoleIdToUpdate ?? undefined,
                        platformRole: platformRoleToUpdate ?? undefined,
                        projectId: naturalProjectId ?? undefined,
                    })
                }
                catch (error) {
                    // Lost a concurrent first-write race (lock miss): the unique
                    // index picked the winner. Fall back to updating the winner's
                    // row in place so both callers converge on one row.
                    if (isUniqueConstraintViolation(error)) {
                        const winner = await findInvitationByNaturalKey({ email: normalizedEmail, platformId, projectId: naturalProjectId })
                        if (!isNil(winner)) {
                            await repo().update(winner.id, {
                                status,
                                type,
                                platformRole: platformRoleToUpdate,
                                projectRoleId: projectRoleIdToUpdate,
                                projectId: naturalProjectId,
                            })
                            return this.getOneOrThrow({ id: winner.id, platformId })
                        }
                    }
                    throw error
                }

                // Fail-open convergence: when the lock was NOT acquired (Redis
                // unavailable), two concurrent creates can both reach this insert
                // for a PLATFORM invitation - the NULL projectId means the unique
                // index never arbitrates, so both inserts succeed. Prune to the
                // earliest row so the pair converges exactly like the locked path.
                if (!lockAcquired && isNil(naturalProjectId)) {
                    const duplicates = await repo()
                        .createQueryBuilder('user_invitation')
                        .where('LOWER("user_invitation"."email") = :email', { email: normalizedEmail })
                        .andWhere('"user_invitation"."platformId" = :platformId', { platformId })
                        .andWhere('"user_invitation"."projectId" IS NULL')
                        .orderBy('"user_invitation"."created"', 'ASC')
                        .addOrderBy('"user_invitation"."id"', 'ASC')
                        .getMany()
                    if (duplicates.length > 1) {
                        const [keep, ...fold] = duplicates
                        await repo().delete(fold.map((row) => row.id))
                        await repo().update(keep.id, {
                            status,
                            type,
                            platformRole: platformRoleToUpdate,
                            projectRoleId: projectRoleIdToUpdate,
                            projectId: naturalProjectId,
                        })
                        return this.getOneOrThrow({ id: keep.id, platformId })
                    }
                }

                return this.getOneOrThrow({ id, platformId })
            },
        })

        if (status === InvitationStatus.ACCEPTED) {
            await this.accept({
                invitationId: userInvitation.id,
                platformId,
            })
            if (smtpEmailSender(log).isSmtpConfigured()) {
                await emailService(log).sendProjectMemberAdded({
                    userInvitation,
                })
            }
            return userInvitation
        }
        return enrichWithInvitationLink(userInvitation, invitationExpirySeconds, log)
    },
    async list(params: ListUserParams): Promise<SeekPage<UserInvitation>> {
        const decodedCursor = paginationHelper.decodeCursor(params.cursor ?? null)
        const paginator = buildPaginator({
            entity: UserInvitationEntity,
            query: {
                limit: params.limit,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const queryBuilder = repo().createQueryBuilder('user_invitation')
            .where({
                platformId: params.platformId,
                ...spreadIfDefined('projectId', params.projectId),
                ...spreadIfDefined('status', params.status),
                ...spreadIfDefined('type', params.type),
            })
        const { data, cursor } = await paginator.paginate(queryBuilder)
        const projectRoleIds = unique(data.map((invitation) => invitation.projectRoleId).filter((id): id is string => !isNil(id)))
        const projectRoleById = await getProjectRolesByIds(projectRoleIds)
        const enrichedData = data.map((invitation) => ({
            projectRole: !isNil(invitation.projectRoleId) ? projectRoleById.get(invitation.projectRoleId) ?? null : null,
            ...invitation,
        }))
        return paginationHelper.createPage<UserInvitation>(enrichedData, cursor)
    },
    async delete({ id, platformId }: PlatformAndIdParams): Promise<void> {
        const invitation = await this.getOneOrThrow({ id, platformId })
        await repo().delete({
            id: invitation.id,
            platformId,
        })
    },
    async getOneOrThrow({ id, platformId }: PlatformAndIdParams): Promise<UserInvitation> {
        const invitation = await repo().findOne({
            where: {
                id,
                platformId,
            },
        })
        if (isNil(invitation)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: `id=${id}`,
                    entityType: 'UserInvitation',
                },
            })
        }
        return invitation
    },
    async accept({ invitationId, platformId }: AcceptParams): Promise<void> {
        const invitation = await this.getOneOrThrow({ id: invitationId, platformId })
        await repo().update(invitation.id, {
            status: InvitationStatus.ACCEPTED,
        })
        const identity = await userIdentityService(log).getIdentityByEmail(invitation.email)
        if (isNil(identity)) {
            return
        }
        await this.provisionUserInvitation({
            email: invitation.email,
        })
    },
    async hasAnyAcceptedInvitationsForEmail({ email }: { email: string }): Promise<boolean> {
        const count = await repo().createQueryBuilder('user_invitation')
            .where('LOWER("user_invitation"."email") = :email', { email: email.toLowerCase().trim() })
            .andWhere({ status: InvitationStatus.ACCEPTED })
            .getCount()
        return count > 0
    },
    async hasAnyAcceptedInvitations({
        email,
        platformId,
    }: HasAnyAcceptedInvitationsParams): Promise<boolean> {
        const invitations = await repo().createQueryBuilder().where({
            platformId,
            status: InvitationStatus.ACCEPTED,
        }).andWhere('LOWER(user_invitation.email) = :email', { email: email.toLowerCase().trim() })
            .getMany()
        return invitations.length > 0
    },
    async getByEmailAndPlatformIdOrThrow({
        email,
        platformId,
        projectId,
    }: GetOneByPlatformIdAndEmailParams): Promise<UserInvitation | null> {
        return repo().findOneBy({
            email,
            platformId,
            projectId: isNil(projectId) ? IsNull() : projectId,
        })
    },
})

async function generateInvitationLink(userInvitation: UserInvitation, expireyInSeconds: number): Promise<string> {
    const token = await jwtUtils.sign({
        payload: {
            id: userInvitation.id,
        },
        expiresInSeconds: expireyInSeconds,
        key: await jwtUtils.getJwtSecret(),
        audience: JwtAudience.USER_INVITATION,
    })

    return domainHelper.getPublicUrl({
        path: `invitation?token=${token}&email=${encodeURIComponent(userInvitation.email)}`,
    })
}
async function getProjectRolesByIds(ids: string[]): Promise<Map<string, ProjectRole>> {
    if (ids.length === 0) {
        return new Map()
    }
    const projectRoles = await projectRoleRepo().find({ where: { id: In(ids) } })
    return new Map(projectRoles.map((projectRole) => [projectRole.id, projectRole]))
}

const enrichWithInvitationLink = async (userInvitation: UserInvitation, expireyInSeconds: number, log: FastifyBaseLogger) => {
    const invitationLink = await generateInvitationLink(userInvitation, expireyInSeconds)
    if (!smtpEmailSender(log).isSmtpConfigured()) {
        return {
            ...userInvitation,
            link: invitationLink,
        }
    }
    await emailService(log).sendInvitation({
        userInvitation,
        invitationLink,
    })
    return userInvitation
}
type ListUserParams = {
    platformId: string
    type: InvitationType
    projectId: string | null
    status?: InvitationStatus
    limit: number
    cursor: string | null
}

type HasAnyAcceptedInvitationsParams = {
    email: string
    platformId: string
}
type ProvisionUserInvitationParams = {
    email: string
}

type PlatformAndIdParams = {
    id: string
    platformId: string
}
export type UserInvitationToken = {
    id: string
}

type AcceptParams = {
    invitationId: string
    platformId: string
}

type CreateParams = {
    email: string
    platformId: string
    platformRole: PlatformRole | null
    projectId: string | null
    status: InvitationStatus
    type: InvitationType
    projectRoleId: string | null
    invitationExpirySeconds: number
}


type GetOneByPlatformIdAndEmailParams = {
    email: string
    platformId: string
    projectId: string | null
}
