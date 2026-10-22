import { ActivepiecesError, apId, ApId, ErrorCode, isNil, PlatformId, ProjectRole, RoleType, SeekPage, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { CreateProjectRoleRequestBody } from '@inboxfm-connect/shared'
import { Brackets, Equal } from 'typeorm'
import { repoFactory } from '../../../core/db/repo-factory'
import { distributedLock } from '../../../database/redis-connections'
import { system } from '../../../helper/system/system'
import { ProjectRoleEntity } from '../../../project/project-role/project-role.entity'
import { ProjectMemberEntity } from '../project-members/project-member.entity'


export const projectRoleRepo = repoFactory(ProjectRoleEntity)
export const projectMemberRepo = repoFactory(ProjectMemberEntity)

export const projectRoleService = {

    async getOneOrThrowById({ id }: GetOneIdParams): Promise<ProjectRole> {
        const projectRole = await projectRoleRepo().findOneBy({ id })
        if (isNil(projectRole)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'project_role', entityId: id, message: 'Project Role by id not found' },
            })
        }
        return projectRole
    },

    async getOne({ name, platformId }: GetOneByNameParams): Promise<ProjectRole | null> {
        return projectRoleRepo().createQueryBuilder('projectRole')
            .where('LOWER(projectRole.name) = LOWER(:name)', { name })
            .andWhere(new Brackets(qb => qb.where({ platformId }).orWhere({ type: RoleType.DEFAULT })))
            .getOne()
    },
    async getOneOrThrow({ name, platformId }: GetOneByNameParams): Promise<ProjectRole> {
        const projectRole = await this.getOne({ name, platformId })
        if (isNil(projectRole)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'project_role', entityId: name, message: 'Project Role by name and platformId not found' },
            })
        }
        return projectRole
    },
    async list({ platformId }: ListParams): Promise<SeekPage<ProjectRole>> {
        const projectRoles = await projectRoleRepo().find({
            where: [
                {
                    platformId: Equal(platformId),
                },
                {
                    type: RoleType.DEFAULT,
                },
            ],
            order: {
                created: 'ASC',
            },
        })

        const userCountByRoleId = await getUserCountByProjectRoleId({
            platformId,
            projectRoleIds: projectRoles.map((projectRole) => projectRole.id),
        })

        return {
            data: projectRoles.map((projectRole) => ({
                ...projectRole,
                userCount: userCountByRoleId.get(projectRole.id) ?? 0,
            })),
            next: null,
            previous: null,
        }
    },

    async create(platformId: string, params: CreateProjectRoleRequestBody): Promise<ProjectRole> {
        // Role names are unique per platform by convention only - the entity carries no
        // unique index - so two admins creating the same name concurrently both passed
        // the getOne() check and both inserted. getOne() compares with LOWER() on both
        // sides, so the key is the lower-cased name: the lock has to use it too, or
        // "Admin" and "admin" would take different locks and still race.
        const key = `project-role:create:${platformId}:${params.name.toLowerCase()}`
        return distributedLock(system.globalLogger()).runExclusive({
            key,
            timeoutInSeconds: 60,
            fn: async () => {
                // Re-check inside the lock: the winner of a race has already committed.
                const projectRoleExists = await this.getOne({
                    name: params.name,
                    platformId,
                })
                if (projectRoleExists) {
                    throw new ActivepiecesError({
                        code: ErrorCode.VALIDATION,
                        params: {
                            message: `Project Role with name "${params.name}" already exists`,
                        },
                    })
                }

                return projectRoleRepo().save({
                    id: apId(),
                    platformId,
                    ...params,
                })
            },
        })
    },

    async update(params: UpdateParams): Promise<ProjectRole> {
        await projectRoleRepo().update({
            id: params.id,
            platformId: params.platformId,
        }, {
            ...spreadIfDefined('name', params.name),
            ...spreadIfDefined('permissions', params.permissions),
        })
        return projectRoleRepo().findOneByOrFail({ id: params.id, platformId: params.platformId })
    },

    async delete({ name, platformId }: DeleteParams): Promise<void> {
        await projectRoleRepo().delete({ name, platformId })
    },
}

async function getUserCountByProjectRoleId({ platformId, projectRoleIds }: GetUserCountByProjectRoleIdParams): Promise<Map<ApId, number>> {
    if (projectRoleIds.length === 0) {
        return new Map()
    }
    const rows = await projectMemberRepo()
        .createQueryBuilder('project_member')
        .select('project_member.projectRoleId', 'projectRoleId')
        .addSelect('COUNT(*)', 'count')
        .where('project_member.platformId = :platformId', { platformId })
        .andWhere('project_member.projectRoleId IN (:...projectRoleIds)', { projectRoleIds })
        .groupBy('project_member.projectRoleId')
        .getRawMany<{ projectRoleId: ApId, count: string }>()
    return new Map(rows.map((row) => [row.projectRoleId, Number(row.count)]))
}

type GetUserCountByProjectRoleIdParams = {
    platformId: PlatformId
    projectRoleIds: ApId[]
}

type UpdateParams = {
    id: ApId
    name: string | undefined
    platformId: PlatformId
    permissions: string[] | undefined
}

type ListParams = {
    platformId: PlatformId
}

type DeleteParams = {
    name: ApId
    platformId: PlatformId
}

type GetOneByNameParams = {
    name: string
    platformId: PlatformId
}

type GetOneIdParams = {
    id: ApId
}