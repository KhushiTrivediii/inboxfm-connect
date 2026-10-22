import { ActivepiecesError, apId, assertNotNullOrUndefined, Cursor, ErrorCode, isNil, PlatformId, ProjectId, SeekPage, spreadIfDefined, UserId } from '@inboxfm-connect/core-utils'
import { ApEdition, PlatformRole, ProjectType, User, UserIdentity, UserStatus, UserWithMetaInformation } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { In, IsNull } from 'typeorm'
import { userIdentityRepository } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { distributedLock } from '../database/redis-connections'
import { projectMemberRepo } from '../ee/projects/project-role/project-role.service'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { system } from '../helper/system/system'
import { platformService } from '../platform/platform.service'
import { projectService } from '../project/project-service'
import { UserEntity, UserSchema } from './user-entity'


export const userRepo = repoFactory(UserEntity)

// Postgres surfaces a unique violation as SQLSTATE 23505 on `code`, and pglite puts it
// on `driverError.code` instead, so a matcher keyed on the message misses half the
// supported drivers. Same shape as the other services in this package.
const isUniqueViolation = (error: unknown): boolean => {
    const candidate = error as { code?: unknown, driverError?: { code?: unknown } } | null
    return candidate?.code === '23505' || candidate?.driverError?.code === '23505'
}

export const userService = (log: FastifyBaseLogger) => ({
    async create(params: CreateParams): Promise<User> {
        const isActive = params.isActive ?? true
        const user: NewUser = {
            id: apId(),
            identityId: params.identityId,
            platformRole: params.platformRole,
            status: isActive ? UserStatus.ACTIVE : UserStatus.INACTIVE,
            externalId: params.externalId,
            platformId: params.platformId,
        }
        return userRepo().save(user)
    },
    async getOrCreateWithProject({ identity, platformId }: GetOrCreateWithProjectParams): Promise<User> {
        // Two sign-ins for the same identity on the same platform can both observe "no
        // user" and provision concurrently. Both inserts then target
        // idx_user_platform_id_email (platformId, identityId) and the loser surfaced a
        // raw unique violation out of a sign-in path - or, when the user insert did land,
        // a second personal project for the same person. Serialize on the natural key and
        // re-check inside the lock; the out-of-lock read stays so a warm call never
        // touches Redis.
        const existing = await this.getOneByIdentityAndPlatform({ identityId: identity.id, platformId })
        if (!isNil(existing)) {
            return existing
        }

        const key = `user:get-or-create:${platformId}:${identity.id}`
        try {
            return await distributedLock(log).runExclusive({
                key,
                timeoutInSeconds: 60,
                fn: async () => {
                    // Re-check under the lock: the winner of a race has already committed.
                    const user = await this.getOneByIdentityAndPlatform({ identityId: identity.id, platformId })
                    if (!isNil(user)) {
                        return user
                    }
                    const newUser = await this.create({
                        identityId: identity.id,
                        platformId,
                        platformRole: PlatformRole.MEMBER,
                    })

                    await projectService(log).create({
                        displayName: identity.firstName + '\'s Project',
                        ownerId: newUser.id,
                        platformId,
                        type: ProjectType.PERSONAL,
                    })
                    return newUser
                },
            })
        }
        catch (error) {
            // The lock is an optimisation, not the correctness boundary: if it is
            // unavailable, or the insert lost the race anyway, converge on the
            // committed row rather than failing a sign-in.
            if (isUniqueViolation(error) || await this.getOneByIdentityAndPlatform({ identityId: identity.id, platformId })) {
                const winner = await this.getOneByIdentityAndPlatform({ identityId: identity.id, platformId })
                if (!isNil(winner)) {
                    return winner
                }
            }
            throw error
        }
    },
    async updateLastActiveDate({ id }: UpdateLastActiveDateParams): Promise<void> {
        await userRepo().update({ id }, { lastActiveDate: dayjs().toISOString() })
    },
    async update({ id, status, platformId, platformRole, externalId }: UpdateParams): Promise<UserWithMetaInformation> {
        const user = await this.getOrThrow({ id })
        assertNotNullOrUndefined(user.platformId, 'platformId')

        if (user.platformId !== platformId) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'user',
                    entityId: id,
                },
            })
        }

        const platform = await platformService(log).getOneOrThrow(user.platformId)
        if (platform.ownerId === user.id && status === UserStatus.INACTIVE) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'Admin cannot be deactivated',
                },
            })
        }

        await userRepo().update({
            id,
            platformId,
        }, {
            ...spreadIfDefined('status', status),
            ...spreadIfDefined('platformRole', platformRole),
            ...spreadIfDefined('externalId', externalId),
        })

        return this.getMetaInformation({ id })
    },
    async getUsersByIdentityId({ identityId }: GetUsersByIdentityIdParams): Promise<Pick<User, 'id' | 'platformId'>[]> {
        return userRepo().find({ where: { identityId } }).then((users) => users.map((user) => ({ id: user.id, platformId: user.platformId })))
    },
    async list({ platformId, externalId, cursorRequest, limit }: ListParams): Promise<SeekPage<UserWithMetaInformation>> {
        const decodedCursor = paginationHelper.decodeCursor(cursorRequest)
        const paginator = buildPaginator({
            entity: UserEntity,
            query: {
                limit,
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const { data, cursor } = await paginator.paginate(userRepo().createQueryBuilder('user')
            .leftJoinAndSelect('user.identity', 'identity')
            .where({
                platformId,
                ...spreadIfDefined('externalId', externalId),
            }))

        const usersWithMetaInformation = data.map(toUserWithMetaInformation)
        return paginationHelper.createPage<UserWithMetaInformation>(usersWithMetaInformation, cursor)
    },
    async getByIdentityId({ identityId }: GetByIdentityId): Promise<UserSchema[]> {
        return userRepo().find({ where: { identityId } })
    },
    async getOneByIdentityAndPlatform({ identityId, platformId }: GetOneByIdentityIdParams): Promise<User | null> {
        return userRepo().findOneBy({ identityId, platformId: isNil(platformId) ? IsNull() : platformId })
    },
    async get({ id }: IdParams): Promise<User | null> {
        return userRepo().findOneBy({ id })
    },
    async getOrThrow({ id }: IdParams): Promise<User> {
        const user = await userRepo().findOneBy({ id })
        if (isNil(user)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'user', entityId: id },
            })
        }
        return user
    },
    async getOneOrFail({ id }: IdParams): Promise<User> {
        return userRepo().findOneOrFail({ where: { id } })
    },
    async getOneByIdAndPlatformIdOrThrow({ id, platformId }: GetOneByIdAndPlatformIdParams): Promise<UserWithMetaInformation> {
        const user = await userRepo().findOne({ where: { id, platformId } })
        if (isNil(user)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'user', entityId: id },
            })
        }
        return this.getMetaInformation({ id })
    },
    async delete({ id, platformId }: DeleteParams): Promise<void> {
        await assertNotPlatformOwner({ id, platformId, log })
        await projectService(log).deletePersonalProjectForUser({
            userId: id,
            platformId,
        })
        await userRepo().delete({
            id,
            platformId,
        })
    },
    async removeFromPlatform({ id, platformId }: DeleteParams): Promise<void> {
        await assertNotPlatformOwner({ id, platformId, log })
        const user = await this.getOneOrFail({ id })
        await projectService(log).deletePersonalProjectForUser({
            userId: id,
            platformId,
        })
        await userRepo().update({
            id,
            platformId,
        }, {
            platformId: null,
        })
        await userIdentityRepository().update(user.identityId, {
            tokenVersion: nanoid(),
        })
        await userIdentityRepository().update({
            id: user.identityId,
            lastLoggedInPlatformId: platformId,
        }, {
            lastLoggedInPlatformId: null,
        })
    },

    async getByPlatformRole(id: PlatformId, role: PlatformRole): Promise<UserSchema[]> {
        return userRepo().find({ where: { platformId: id, platformRole: role }, relations: { identity: true } })
    },
    async listProjectUsers({ platformId, projectId }: ListUsersForProjectParams): Promise<UserWithMetaInformation[]> {
        const users = await getUsersForProject(platformId, projectId)
        const usersWithIdentity = await userRepo().find({ where: { platformId, id: In(users) }, relations: { identity: true } })
        return usersWithIdentity.map(toUserWithMetaInformation)
    },
    async getByPlatformAndExternalId({
        platformId,
        externalId,
    }: GetByPlatformAndExternalIdParams): Promise<User | null> {
        return userRepo().findOneBy({
            platformId,
            externalId,
        })
    },
    async getMetaInformation({ id }: IdParams): Promise<UserWithMetaInformation> {
        const user = await userRepo().findOneOrFail({ where: { id }, relations: { identity: true } })
        return toUserWithMetaInformation(user)
    },
    async getMetaInformationBatch({ ids }: GetMetaInformationBatchParams): Promise<Map<UserId, UserWithMetaInformation>> {
        if (ids.length === 0) {
            return new Map()
        }
        const users = await userRepo().find({ where: { id: In(ids) }, relations: { identity: true } })
        return new Map(users.map((user) => [user.id, toUserWithMetaInformation(user)]))
    },

    async addOwnerToPlatform({
        id,
        platformId,
    }: UpdatePlatformIdParams): Promise<void> {
        await userRepo().update(id, {
            updated: dayjs().toISOString(),
            platformRole: PlatformRole.ADMIN,
            platformId,
        })
    },

    isUserPrivileged(user: User): boolean {
        return user.platformRole === PlatformRole.ADMIN || user.platformRole === PlatformRole.OPERATOR
    },
})


async function assertNotPlatformOwner({ id, platformId, log }: DeleteParams & { log: FastifyBaseLogger }): Promise<void> {
    const platform = await platformService(log).getOneOrThrow(platformId)
    if (platform.ownerId === id) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: 'Platform owner cannot be deleted',
            },
        })
    }
}

function toUserWithMetaInformation(user: UserSchema): UserWithMetaInformation {
    return {
        id: user.id,
        email: user.identity.email,
        firstName: user.identity.firstName,
        lastName: user.identity.lastName,
        platformId: user.platformId,
        platformRole: user.platformRole,
        status: user.status,
        externalId: user.externalId,
        created: user.created,
        updated: user.updated,
        lastActiveDate: user.lastActiveDate,
        imageUrl: user.identity.imageUrl,
    }
}

async function getUsersForProject(platformId: PlatformId, projectId: string): Promise<UserId[]> {
    const platformAdmins = await userRepo().find({ where: { platformId, platformRole: PlatformRole.ADMIN } }).then((users) => users.map((user) => user.id))
    const edition = system.getEdition()
    if (edition === ApEdition.COMMUNITY) {
        return platformAdmins
    }
    const projectMembers = await projectMemberRepo().find({ where: { projectId, platformId } }).then((members) => members.map((member) => member.userId))
    return [...platformAdmins, ...projectMembers]
}

type UpdateLastActiveDateParams = {
    id: UserId
}

type GetOneByIdAndPlatformIdParams = {
    id: UserId
    platformId: PlatformId
}
type ListUsersForProjectParams = {
    projectId: ProjectId
    platformId: PlatformId
}

type GetMetaInformationBatchParams = {
    ids: UserId[]
}

type DeleteParams = {
    id: UserId
    platformId: PlatformId
}


type ListParams = {
    platformId: PlatformId
    externalId?: string
    cursorRequest: Cursor
    limit?: number
}

type GetByIdentityId = {
    identityId: string
}


type GetOneByIdentityIdParams = {
    identityId: string
    platformId: PlatformId | null
}

type UpdateParams = {
    id: UserId
    status?: UserStatus
    platformId: PlatformId
    platformRole?: PlatformRole
    externalId?: string
}

type CreateParams = {
    identityId: string
    platformId: string | null
    externalId?: string
    platformRole: PlatformRole
    isActive?: boolean
}
type GetUsersByIdentityIdParams = {
    identityId: string
}

type NewUser = Omit<User, 'created' | 'updated'>

type GetByPlatformAndExternalIdParams = {
    platformId: string
    externalId: string
}

type IdParams = {
    id: UserId
}

type UpdatePlatformIdParams = {
    id: UserId
    platformId: string
}

type GetOrCreateWithProjectParams = {
    identity: UserIdentity
    platformId: string
}
