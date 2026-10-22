import { createHash } from 'crypto'
import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { AuthenticationResponse, PiecesFilterType, PlatformRole, PrincipalType, Project, ProjectType, User, UserIdentity, UserIdentityProvider } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { accessTokenManager } from '../../authentication/lib/access-token-manager'
import { userIdentityService } from '../../authentication/user-identity/user-identity-service'
import { distributedLock } from '../../database/redis-connections'
import { pieceTagService } from '../../pieces/tags/pieces/piece-tag.service'
import { platformService } from '../../platform/platform.service'
import { projectService } from '../../project/project-service'
import { userService } from '../../user/user-service'
import { concurrencyPoolService } from '../platform/concurrency-pool/concurrency-pool.service'
import { projectMemberService } from '../projects/project-members/project-member.service'
import { projectLimitsService } from '../projects/project-plan/project-plan.service'
import { externalTokenExtractor } from './lib/external-token-extractor'

export const managedAuthnService = (log: FastifyBaseLogger) => ({
    async externalToken({
        externalAccessToken,
    }: AuthenticateParams): Promise<AuthenticationResponse> {
        const externalPrincipal = await externalTokenExtractor(log).extract(
            externalAccessToken,
        )

        const { project } = await getOrCreateProject({
            platformId: externalPrincipal.platformId,
            externalProjectId: externalPrincipal.externalProjectId,
        }, log)

        if (!isNil(externalPrincipal.projectDisplayName)) {
            await projectService(log).update(project.id, {
                type: project.type,
                displayName: externalPrincipal.projectDisplayName,
            })
        }

        if (!isNil(externalPrincipal.concurrencyPoolKey) && !isNil(externalPrincipal.concurrencyPoolLimit)) {
            const { poolId } = await concurrencyPoolService(log).upsertPool({
                platformId: externalPrincipal.platformId,
                key: externalPrincipal.concurrencyPoolKey,
                maxConcurrentJobs: externalPrincipal.concurrencyPoolLimit,
            })
            await projectService(log).update(project.id, { type: project.type, poolId })
            await concurrencyPoolService(log).assignProject({ projectId: project.id, poolId })
        }

        await updateProjectLimits({
            platformId: project.platformId,
            projectId: project.id,
            piecesTags: externalPrincipal.pieces.tags,
            piecesFilterType: externalPrincipal.pieces.filterType,
            log,
        })

        const user = await getOrCreateUser(externalPrincipal, log)

        await projectMemberService(log).upsert({
            projectId: project.id,
            userId: user.id,
            projectRoleName: externalPrincipal.projectRole,
        })

        const identity = await userIdentityService(log).getOneOrFail({
            id: user.identityId,
        })

        const token = await accessTokenManager(log).generateToken({
            id: user.id,
            type: PrincipalType.USER,
            platform: {
                id: externalPrincipal.platformId,
            },
            tokenVersion: identity.tokenVersion,
        }, 7 * 24 * 60 * 60)
        return {
            id: user.id,
            platformRole: user.platformRole,
            status: user.status,
            externalId: user.externalId,
            platformId: user.platformId,
            firstName: identity.firstName,
            lastName: identity.lastName,
            email: identity.email,
            trackEvents: identity.trackEvents,
            newsLetter: identity.newsLetter,
            verified: identity.verified,
            token,
            projectId: project.id,
        }
    },
})

type UpdateProjectLimitsParams =
    {
        platformId: string
        projectId: string
        piecesTags: string[]
        piecesFilterType: PiecesFilterType
        log: FastifyBaseLogger
    }

const updateProjectLimits = async ({ platformId, projectId, piecesTags, piecesFilterType, log }: UpdateProjectLimitsParams): Promise<void> => {
    const pieces = await getPiecesList({
        platformId,
        projectId,
        piecesTags,
        piecesFilterType,
    })
    await projectLimitsService(log).upsert({
        nickname: 'default-embeddings-limit',
        pieces,
        piecesFilterType,
    }, projectId)
}

const getOrCreateUser = async (
    params: GetOrCreateUserParams,
    log: FastifyBaseLogger,
): Promise<User> => {
    return runGetOrCreateExclusiveOrWithoutLock({
        key: buildUserNaturalKey(params),
        log,
        fn: async () => {
            const existingUser = await userService(log).getByPlatformAndExternalId({
                platformId: params.platformId,
                externalId: params.externalUserId,
            })

            if (!isNil(existingUser)) {
                return existingUser
            }
            const identity = await getOrCreateUserIdentity(params, log)
            try {
                return await userService(log).create({
                    externalId: params.externalUserId,
                    platformId: params.platformId,
                    identityId: identity.id,
                    platformRole: PlatformRole.MEMBER,
                })
            }
            catch (error) {
                if (isUniqueConstraintViolation(error)) {
                    // Lost a concurrent first-write to the (platformId, externalId)
                    // unique index - converge on the winner's row.
                    const winner = await userService(log).getByPlatformAndExternalId({
                        platformId: params.platformId,
                        externalId: params.externalUserId,
                    })
                    if (isNil(winner)) {
                        throw error
                    }
                    return winner
                }
                throw error
            }
        },
    })
}

const getOrCreateUserIdentity = async (
    params: GetOrCreateUserParams,
    log: FastifyBaseLogger,
): Promise<UserIdentity> => {
    const cleanedEmail = generateEmailHash(params)
    return runGetOrCreateExclusiveOrWithoutLock({
        key: buildIdentityNaturalKey(cleanedEmail),
        log,
        fn: async () => {
            const existingIdentity = await userIdentityService(log).getIdentityByEmail(cleanedEmail)
            if (!isNil(existingIdentity)) {
                return existingIdentity
            }
            try {
                return await userIdentityService(log).create({
                    email: cleanedEmail,
                    password: await cryptoUtils.generateRandomPassword(),
                    firstName: params.externalFirstName,
                    lastName: params.externalLastName,
                    trackEvents: true,
                    newsLetter: false,
                    provider: UserIdentityProvider.JWT,
                    verified: true,
                })
            }
            catch (error) {
                // userIdentityService.create throws EXISTING_USER when its own
                // pre-insert check loses a race, and the email unique index throws
                // 23505 when even that check loses. Both mean "lost the race" for
                // this get-or-create flow - converge on the winner's row.
                if (isExistingUserError(error) || isUniqueConstraintViolation(error)) {
                    const winner = await userIdentityService(log).getIdentityByEmail(cleanedEmail)
                    if (isNil(winner)) {
                        throw error
                    }
                    return winner
                }
                throw error
            }
        },
    })
}
const getOrCreateProject = async ({
    platformId,
    externalProjectId,
}: GetOrCreateProjectParams, log: FastifyBaseLogger): Promise<{ project: Project, isNewProject: boolean }> => {
    const result = await runGetOrCreateExclusiveOrWithoutLock({
        key: buildProjectNaturalKey({ platformId, externalProjectId }),
        log,
        fn: async () => {
            const existingProject = await projectService(log).getByPlatformIdAndExternalId({
                platformId,
                externalId: externalProjectId,
            })

            if (!isNil(existingProject)) {
                return { project: existingProject, isNewProject: false }
            }

            const platform = await platformService(log).getOneOrThrow(platformId)

            try {
                const project = await projectService(log).create({
                    displayName: externalProjectId,
                    ownerId: platform.ownerId,
                    platformId,
                    externalId: externalProjectId,
                    type: ProjectType.TEAM,
                })

                return { project, isNewProject: true }
            }
            catch (error) {
                if (isUniqueConstraintViolation(error)) {
                    // Lost a concurrent first-write to the (platformId, externalId)
                    // unique index - converge on the winner's row.
                    const winner = await projectService(log).getByPlatformIdAndExternalId({
                        platformId,
                        externalId: externalProjectId,
                    })
                    if (isNil(winner)) {
                        throw error
                    }
                    return { project: winner, isNewProject: false }
                }
                throw error
            }
        },
    })
    return result
}

const getPiecesList = async ({
    piecesFilterType,
    piecesTags,
    platformId,
}: UpdateProjectLimits): Promise<string[]> => {
    switch (piecesFilterType) {
        case PiecesFilterType.ALLOWED: {
            return pieceTagService.findByPlatformAndTags(
                platformId,
                piecesTags,
            )
        }
        case PiecesFilterType.NONE: {
            return []
        }
    }
}

function generateEmailHash(params: { platformId: string, externalUserId: string }): string {
    const inputString = `managed_${params.platformId}_${params.externalUserId}`
    return cleanEmailOtherwiseCompareFails(createHash('sha256').update(inputString).digest('hex'))
}

function cleanEmailOtherwiseCompareFails(email: string): string {
    return email.trim().toLowerCase()
}

// The three get-or-create legs of the external-token flow run without any
// serialization and each writes a row guarded by a unique index on its natural
// key, so two concurrent sign-ins with the same external principal race the
// SELECT-then-INSERT gap and the loser surfaces a raw driver error as a 500 on
// a public auth endpoint. Serializing each leg on its natural key removes the
// race in-process and cross-process (Redis-backed lock); the fail-open path
// keeps sign-in working when the lock infrastructure itself is unavailable.
async function runGetOrCreateExclusiveOrWithoutLock<T>({ key, fn, log }: {
    key: string
    fn: () => Promise<T>
    log: FastifyBaseLogger
}): Promise<T> {
    let fnSettled = false
    try {
        return await distributedLock(log).runExclusive({
            key,
            timeoutInSeconds: 60,
            fn: async () => {
                try {
                    return await fn()
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
        log.warn({ error, lockKey: key }, 'Managed authn get-or-create lock unavailable - failing open')
        return fn()
    }
}

function buildProjectNaturalKey({ platformId, externalProjectId }: { platformId: string, externalProjectId: string }): string {
    return ['managed-authn', 'get-or-create', 'project', platformId, externalProjectId].join(':')
}

function buildUserNaturalKey({ platformId, externalUserId }: { platformId: string, externalUserId: string }): string {
    return ['managed-authn', 'get-or-create', 'user', platformId, externalUserId].join(':')
}

function buildIdentityNaturalKey(email: string): string {
    return ['managed-authn', 'get-or-create', 'identity', email].join(':')
}

function isUniqueConstraintViolation(error: unknown): boolean {
    // Postgres unique-violation driver code (SQLSTATE 23505), gated on the driver
    // code the same way as the approved #460/#466 helpers: the two drivers pinned
    // in this repo (pg 8.11.3, @electric-sql/pglite 0.3.14) do not always surface
    // the code on the same property, so match both the top-level error and the
    // wrapped driverError. Any other failure must propagate raw.
    const candidate = error as { code?: string, driverError?: { code?: string } } | null | undefined
    return candidate?.code === '23505' || candidate?.driverError?.code === '23505'
}

function isExistingUserError(error: unknown): boolean {
    return error instanceof ActivepiecesError && error.error.code === ErrorCode.EXISTING_USER
}

type AuthenticateParams = {
    externalAccessToken: string
}

type GetOrCreateUserParams = {
    platformId: string
    externalUserId: string
    externalProjectId: string
    externalFirstName: string
    externalLastName: string
}

type GetOrCreateProjectParams = {
    platformId: string
    externalProjectId: string
}

type UpdateProjectLimits = {
    platformId: string
    projectId: string
    piecesTags: string[]
    piecesFilterType: PiecesFilterType
}
