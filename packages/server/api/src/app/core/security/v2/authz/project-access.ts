import { ActivepiecesError, ApId, ErrorCode, isNil, Permission, ProjectId, ProjectRole, RoleType, spreadIfDefined, UserId } from '@inboxfm-connect/core-utils'
import { DefaultProjectRole, PlatformRole, Principal, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { Brackets } from 'typeorm'
import { ProjectRoleEntity } from '../../../../project/project-role/project-role.entity'
import { projectService } from '../../../../project/project-service'
import { userService } from '../../../../user/user-service'
import { repoFactory } from '../../../db/repo-factory'

const projectRoleRepo = repoFactory(ProjectRoleEntity)

// Community edition non-ee equivalent of ee/authentication/project-role/rbac-service.ts and
// ee/projects/project-members/project-member.service.ts. CE has no invited-member concept, so
// project access here is derived only from project ownership and platform role — never from a
// project_member table, which is an ee-only entity CE code must not import (see
// .claude/rules/edition-safety.md).
export const communityProjectAccess = {
    async assertPrincipalAccessToProject({ principal, permission, projectId, log }: AssertPrincipalAccessToProjectParams): Promise<void> {
        switch (principal.type) {
            case PrincipalType.UNKNOWN:
            case PrincipalType.WORKER:
            case PrincipalType.ONBOARDING:
                throw new ActivepiecesError({
                    code: ErrorCode.AUTHORIZATION,
                    params: {
                        message: 'Principal is not allowed to access this project',
                        projectId,
                    },
                })

            case PrincipalType.USER: {
                const role = await getRoleForUser({ userId: principal.id, projectId, log })
                if (isNil(role)) {
                    throw new ActivepiecesError({
                        code: ErrorCode.AUTHORIZATION,
                        params: {
                            message: 'No role found for the user',
                            userId: principal.id,
                            projectId,
                        },
                    })
                }
                if (!isNil(permission) && !role.permissions?.includes(permission)) {
                    throw new ActivepiecesError({
                        code: ErrorCode.PERMISSION_DENIED,
                        params: {
                            userId: principal.id,
                            projectId,
                            projectRole: role,
                            permission,
                        },
                    })
                }
                break
            }
            case PrincipalType.ENGINE: {
                if (principal.projectId !== projectId) {
                    throw new ActivepiecesError({
                        code: ErrorCode.AUTHORIZATION,
                        params: {
                            message: 'Engine is not allowed to access this project',
                            projectId,
                            ...spreadIfDefined('engineProjectId', principal.projectId),
                        },
                    })
                }
                break
            }
            case PrincipalType.SERVICE: {
                const project = await projectService(log).getOneOrThrow(projectId)
                if (project.platformId !== principal.platform.id) {
                    throw new ActivepiecesError({
                        code: ErrorCode.AUTHORIZATION,
                        params: {
                            message: 'Service is not allowed to access this project',
                            projectId,
                            platformId: principal.platform.id,
                        },
                    })
                }
                break
            }
        }
    },

    async getRoleForUser({ userId, projectId, log }: GetRoleForUserParams): Promise<ProjectRole | null> {
        return getRoleForUser({ userId, projectId, log })
    },

    // Community edition has no cross-project membership concept: the only project-independent
    // grant is PlatformRole.ADMIN, and callers of this check already short-circuit on that role
    // before reaching it (see assertNonEmbedOrAdmin in authorize.ts).
    async hasPermissionOnAnyProject(): Promise<boolean> {
        return false
    },
}

const getRoleForUser = async ({ userId, projectId, log }: GetRoleForUserParams): Promise<ProjectRole | null> => {
    const project = await projectService(log).getOneOrThrow(projectId)
    const user = await userService(log).getOneOrFail({ id: userId })

    if (user.id === project.ownerId) {
        return getDefaultRoleOrThrow({ name: DefaultProjectRole.ADMIN, platformId: project.platformId })
    }
    if (project.platformId === user.platformId && user.platformRole === PlatformRole.ADMIN) {
        return getDefaultRoleOrThrow({ name: DefaultProjectRole.ADMIN, platformId: project.platformId })
    }
    if (project.platformId === user.platformId && user.platformRole === PlatformRole.OPERATOR) {
        return getDefaultRoleOrThrow({ name: DefaultProjectRole.EDITOR, platformId: project.platformId })
    }
    return null
}

const getDefaultRoleOrThrow = async ({ name, platformId }: GetDefaultRoleParams): Promise<ProjectRole> => {
    const role = await projectRoleRepo().createQueryBuilder('projectRole')
        .where('LOWER(projectRole.name) = LOWER(:name)', { name })
        .andWhere(new Brackets(qb => qb.where({ platformId }).orWhere({ type: RoleType.DEFAULT })))
        .getOne()

    if (isNil(role)) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityType: 'project_role', entityId: name, message: 'Project Role by name and platformId not found' },
        })
    }
    return role
}

type AssertPrincipalAccessToProjectParams = {
    principal: Principal
    permission: Permission | undefined
    projectId: ProjectId
    log: FastifyBaseLogger
}

type GetRoleForUserParams = {
    userId: UserId
    projectId: ProjectId
    log: FastifyBaseLogger
}

type GetDefaultRoleParams = {
    name: DefaultProjectRole
    platformId: ApId
}
