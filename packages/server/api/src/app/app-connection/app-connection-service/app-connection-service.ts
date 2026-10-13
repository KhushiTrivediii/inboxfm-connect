import { ActivepiecesError, apId, Cursor, ErrorCode, isNil, Metadata, PlatformId, ProjectId, SeekPage, spreadIfDefined, unique } from '@inboxfm-connect/core-utils'
import { ApEdition, ApEnvironment, AppConnection, AppConnectionId, AppConnectionOwners, AppConnectionScope, AppConnectionStatus, AppConnectionType, AppConnectionValue, AppConnectionWithoutSensitiveData, EngineResponse, EngineResponseStatus, ExecuteValidateAuthResponse, MAX_PLATFORM_APP_CONNECTION_OWNERS, OAuth2GrantType, PlatformAppConnectionOwner, PlatformAppConnectionOwnersResponse, PlatformAppConnectionProjectInfo, PlatformAppConnectionsListItem, PlatformRole, UpsertAppConnectionRequestBody, User, UserIdentity, UserWithMetaInformation, WorkerJobType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import semver from 'semver'
import { ArrayContains, Equal, FindOperator, FindOptionsWhere, ILike, In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { distributedLock } from '../../database/redis-connections'
import { projectMemberService } from '../../ee/projects/project-members/project-member.service'
import { containsSecretManagerReference, secretManagersService } from '../../ee/secret-managers/secret-managers.service'
import { encryptUtils } from '../../helper/encryption'
import { exceptionHandler } from '../../helper/exception-handler'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { userInteractionWatcher } from '../../helper/user-interaction/user-interaction-watcher'
import {
    getPiecePackageWithoutArchive,
    pieceMetadataService,
} from '../../pieces/metadata/piece-metadata-service'
import { projectRepo } from '../../project/project-service'
import { userService } from '../../user/user-service'
import {
    AppConnectionEntity,
    AppConnectionSchema,
} from '../app-connection.entity'
import { appConnectionHandler } from './app-connection.handler'
import type { TestConnectionOutcome } from './app-connection.handler'
import { oauth2Handler } from './oauth2'
import { oauth2Util } from './oauth2/oauth2-util'
export const appConnectionsRepo = repoFactory(AppConnectionEntity)

// Upsert race guard (issue F29): app_connection has no unique index on
// (platformId, externalId, scope), so two overlapping upserts of the same
// connection both read "no existing row" and insert two rows with different
// ids. Serialize the whole read-modify-write behind the distributed lock
// (RedLock runExclusive - the same mutex app-connection.handler already
// uses for token refresh). Unlike a bare SET NX + re-read, runExclusive
// makes the loser's lookup happen strictly after the winner's commit, and
// it releases the lock when the winner finishes instead of holding it for
// the full TTL. Fail-open on lock unavailability so a Redis outage never
// blocks connection creation.
function buildUpsertLockKey({ externalId, scope, platformId, projectIds }: { externalId: string, scope: string, platformId: string, projectIds: string[] | null }): string {
    // ArrayContains semantics are order-insensitive, so the lock key must be
    // too: ['p1','p2'] and ['p2','p1'] address the same row and must share one
    // mutex. Sort + dedupe to get one canonical key per connection.
    const canonicalProjectIds = isNil(projectIds) ? 'no-projects' : [...new Set(projectIds)].sort().join(',')
    return ['app-connection', 'upsert', platformId, externalId, scope, canonicalProjectIds].join(':')
}

async function runUpsertExclusiveOrWithoutLock<T>({ externalId, scope, platformId, projectIds, fn, log }: {
    externalId: string
    scope: string
    platformId: string
    projectIds: string[] | null
    fn: () => Promise<T>
    log: FastifyBaseLogger
}): Promise<T> {
    const key = buildUpsertLockKey({ externalId, scope, platformId, projectIds })
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
                    // Mark settled on EVERY exit path (throw AND success), not
                    // just the throw path: a lock-infra error surfacing after a
                    // successful fn (e.g. a release failure propagating out of
                    // RedLock's using()) must not take the fail-open branch and
                    // run fn a second time. (Reviewer hardening, #410 round 2.)
                    fnSettled = true
                }
            },
        })
    }
    catch (error) {
        if (fnSettled) {
            throw error
        }
        log.warn({ error, lockKey: key }, 'App connection upsert lock unavailable - failing open')
        return fn()
    }
}

export const appConnectionService = (log: FastifyBaseLogger) => ({
    async upsert(params: UpsertParams): Promise<AppConnectionWithoutSensitiveData> {
        const { projectIds, externalId, value, displayName, pieceName, ownerId, platformId, scope, type, status, metadata, preSelectForNewProjects } = params
        const pieceVersion = params.pieceVersion ?? ( await pieceMetadataService(log).getOrThrow({
            name: pieceName,
            platformId,
        })).version
        validatePieceVersion(pieceVersion)
        await assertProjectIds(projectIds, platformId)

        if (status === AppConnectionStatus.MISSING) {
            const existingForPlaceholder = await appConnectionsRepo().findOneBy({
                externalId,
                scope,
                platformId,
                ...(projectIds ? { projectIds: ArrayContains(projectIds) } : {}),
            })
            if (!isNil(existingForPlaceholder) && existingForPlaceholder.status !== AppConnectionStatus.MISSING) {
                log.info({ connection: { id: existingForPlaceholder.id }, piece: { name: pieceName }, platform: { id: platformId }, existingStatus: existingForPlaceholder.status }, 'Placeholder upsert skipped — non-missing connection already exists')
                return this.removeSensitiveData(existingForPlaceholder)
            }
        }

        const validatedConnectionValue = await validateConnectionValue({
            value: await secretManagersService(log).resolveObject({ value, platformId, projectIds }),
            pieceName,
            pieceVersion,
            projectId: projectIds[0],
            platformId,
        }, log)

        const encryptedConnectionValue = await encryptUtils.encryptObject({
            ...validatedConnectionValue,
            ...value,
        })

        // Serialize overlapping upserts of the same connection (issue F29).
        // runExclusive releases the lock when the winner's upsert commits, so
        // the loser's lookup below happens strictly after that commit and
        // finds the winner's row instead of inserting a duplicate.
        return runUpsertExclusiveOrWithoutLock({
            externalId,
            scope,
            platformId,
            projectIds,
            log,
            fn: async () => {
                const existingConnection = await appConnectionsRepo().findOneBy({
                    externalId,
                    scope,
                    platformId,
                    ...(projectIds ? { projectIds: ArrayContains(projectIds) } : {}),
                })

                const newId = existingConnection?.id ?? apId()
                const connection = {
                    displayName,
                    ...spreadIfDefined('ownerId', ownerId),
                    status: status ?? AppConnectionStatus.ACTIVE,
                    value: encryptedConnectionValue,
                    externalId,
                    pieceName,
                    type,
                    id: newId,
                    scope,
                    projectIds,
                    platformId,
                    ...spreadIfDefined('metadata', metadata),
                    ...spreadIfDefined('preSelectForNewProjects', preSelectForNewProjects),
                    pieceVersion,
                }

                await appConnectionsRepo().upsert(connection, ['id'])

                const updatedConnection = await appConnectionsRepo().findOneByOrFail({
                    id: newId,
                    platformId,
                    ...(projectIds ? { projectIds: ArrayContains(projectIds) } : {}),
                    scope,
                })
                log.info({ connection: { id: newId }, piece: { name: pieceName }, platform: { id: platformId }, isNew: isNil(existingConnection) }, 'App connection upserted')
                return this.removeSensitiveData(updatedConnection)
            },
        })
    },
    async update(params: UpdateParams): Promise<AppConnectionWithoutSensitiveData> {
        const { projectIds, id, request, scope, platformId } = params

        if (!isNil(request.projectIds)) {
            await assertProjectIds(request.projectIds, platformId)
        }

        const filter: FindOptionsWhere<AppConnectionSchema> = {
            id,
            scope,
            platformId,
            ...(projectIds ? { projectIds: ArrayContains(projectIds) } : {}),
        }

        const existingConnection = await appConnectionsRepo().findOneBy(filter)
        if (isNil(existingConnection)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'AppConnection',
                    entityId: id,
                },
            })
        }

        await appConnectionsRepo().update(filter, {
            displayName: request.displayName,
            ...spreadIfDefined('projectIds', request.projectIds),
            ...spreadIfDefined('metadata', request.metadata),
            ...spreadIfDefined('preSelectForNewProjects', request.preSelectForNewProjects),
        })

        const updatedConnection = await appConnectionsRepo().findOneBy(filter)
        if (isNil(updatedConnection)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'AppConnection',
                    entityId: id,
                },
            })
        }
        return this.removeSensitiveData(updatedConnection)
    },
    async testConnection({ id, projectId, platformId }: TestConnectionParams): Promise<TestConnectionResult> {
        const encryptedAppConnection = await appConnectionsRepo().findOne({
            where: {
                id,
                platformId,
                projectIds: ArrayContains([projectId]),
            },
        })
        if (isNil(encryptedAppConnection)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'AppConnection',
                    entityId: id,
                },
            })
        }
        const testedAt = new Date().toISOString()
        let outcome: TestConnectionOutcome
        try {
            outcome = await appConnectionHandler(log).lockAndTestConnection({
                platformId,
                projectId,
                externalId: encryptedAppConnection.externalId,
                log,
            })
        }
        catch (error) {
            // Infra failures (lock unavailable, db write error) must not 500 the
            // route — the check failed, but the connection is not proven bad.
            exceptionHandler.handle(error, log)
            outcome = {
                ok: false,
                markRowError: false,
                message: 'The connection could not be tested. Try again in a moment.',
            }
        }
        log.info({ connection: { id }, ok: outcome.ok, markRowError: outcome.markRowError }, 'App connection health check finished')
        return markConnectionTested({
            id,
            testedAt,
            rowStatus: outcome.ok
                ? AppConnectionStatus.ACTIVE
                : (outcome.markRowError ? AppConnectionStatus.ERROR : null),
            verdict: outcome.ok ? AppConnectionStatus.ACTIVE : AppConnectionStatus.ERROR,
            message: outcome.message,
        })
    },
    async getOne({
        projectId,
        platformId,
        externalId,
    }: GetOneByName): Promise<AppConnection | null> {
        const encryptedAppConnection = await appConnectionsRepo().findOne({
            where: {
                projectIds: ArrayContains([projectId]),
                externalId,
                platformId,
            },
        })

        if (isNil(encryptedAppConnection)) {
            return null
        }
        const connection = await this.decryptAndRefreshConnection(encryptedAppConnection, projectId, log)

        if (isNil(connection)) {
            return null
        }

        const owner = isNil(connection.ownerId) ? null : await userService(log).getMetaInformation({
            id: connection.ownerId,
        })
        return {
            ...connection,
            owner,
        }
    },

    async getOneOrThrowWithoutValue(params: GetOneParams): Promise<AppConnectionWithoutSensitiveData> {
        const connectionById = await appConnectionsRepo().findOneBy({
            id: params.id,
            platformId: params.platformId,
            ...(params.projectId ? { projectIds: ArrayContains([params.projectId]) } : {}),
        })
        if (isNil(connectionById)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'AppConnection',
                    entityId: params.id,
                },
            })
        }
        return this.removeSensitiveData(connectionById)
    },

    async getOnePublicOrThrow(params: GetOneParams): Promise<AppConnectionWithoutSensitiveData> {
        return this.getOneOrThrowWithoutValue(params)
    },

    async getManyConnectionStates(params: GetManyParams): Promise<{ externalId: string, pieceName: string, displayName: string }[]> {
        const connections = await appConnectionsRepo().find({
            where: {
                projectIds: ArrayContains([params.projectId]),
            },
        })
        return connections.map((connection) => ({
            externalId: connection.externalId,
            pieceName: connection.pieceName,
            displayName: connection.displayName,
        }))
    },

    async delete(params: DeleteParams): Promise<void> {
        await appConnectionsRepo().delete({
            id: params.id,
            platformId: params.platformId,
            scope: params.scope,
            ...(params.projectId ? { projectIds: ArrayContains([params.projectId]) } : {}),
        })
        log.info({ connection: { id: params.id }, platform: { id: params.platformId } }, 'App connection deleted')
    },

    async list({
        projectId,
        projectIds,
        ownerIds,
        pieceName,
        cursorRequest,
        displayName,
        status,
        limit,
        scope,
        platformId,
        externalIds,
    }: ListParams): Promise<SeekPage<AppConnection>> {
        const decodedCursor = paginationHelper.decodeCursor(cursorRequest)
        const paginator = buildPaginator({
            entity: AppConnectionEntity,
            query: {
                limit,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })

        const querySelector: Record<string, string | FindOperator<string>> = {
            ...(projectId ? { projectIds: ArrayContains([projectId]) } : {}),
            ...spreadIfDefined('scope', scope),
            platformId,
        }
        if (!isNil(pieceName)) {
            querySelector.pieceName = Equal(pieceName)
        }
        if (!isNil(displayName)) {
            querySelector.displayName = ILike(`%${displayName}%`)
        }
        if (!isNil(status)) {
            querySelector.status = In(status)
        }
        if (!isNil(externalIds)) {
            querySelector.externalId = In(externalIds)
        }
        if (!isNil(ownerIds) && ownerIds.length > 0) {
            querySelector.ownerId = In(ownerIds)
        }
        const queryBuilder = appConnectionsRepo()
            .createQueryBuilder('app_connection')
            .leftJoinAndSelect('app_connection.owner', 'owner')
            .leftJoinAndSelect('owner.identity', 'owner_identity')
            .where(querySelector)
        if (!isNil(projectIds) && projectIds.length > 0) {
            queryBuilder.andWhere('app_connection."projectIds" && :projectIds::varchar[]', { projectIds })
        }
        const { data, cursor } = await paginator.paginate(queryBuilder)

        const promises = data.map(async (encryptedConnection) => {
            const apConnection: AppConnection = await appConnectionHandler(log).decryptConnection(encryptedConnection)
            const owner = mapToUserWithMetaInformation(encryptedConnection.owner)

            return {
                ...apConnection,
                owner,
            }
        })
        const refreshConnections = await Promise.all(promises)

        return paginationHelper.createPage<AppConnection>(
            refreshConnections,
            cursor,
        )
    },
    removeSensitiveData: (
        appConnection: AppConnection | AppConnectionSchema,
    ): AppConnectionWithoutSensitiveData => {
        const { value, ...appConnectionWithoutSensitiveData } = appConnection
        return {
            ...appConnectionWithoutSensitiveData,
            usingSecretManager: containsSecretManagerReference(value),
        }
    },

    async decryptAndRefreshConnection(
        encryptedAppConnection: AppConnectionSchema,
        projectId: ProjectId,
        log: FastifyBaseLogger,
    ): Promise<AppConnection | null> {
        const appConnection = await appConnectionHandler(log).decryptConnection(encryptedAppConnection)
        if (!await appConnectionHandler(log).needRefresh(appConnection, log)) {
            return oauth2Util(log).removeRefreshTokenAndClientSecret(appConnection)
        }

        const refreshedConnection = await appConnectionHandler(log).lockAndRefreshConnection({ platformId: appConnection.platformId, projectId, externalId: appConnection.externalId, log })
        if (isNil(refreshedConnection)) {
            return null
        }
        return oauth2Util(log).removeRefreshTokenAndClientSecret(refreshedConnection)
    },
    async deleteAllProjectConnections(projectId: string) {
        await appConnectionsRepo().delete({
            scope: AppConnectionScope.PROJECT,
            projectIds: ArrayContains([projectId]),
        })
    },

    async getOwners({ projectId, platformId }: { projectId: ProjectId, platformId: PlatformId }): Promise<AppConnectionOwners[]> {
        const platformAdmins = (await userService(log).getByPlatformRole(platformId, PlatformRole.ADMIN)).map(user => ({
            firstName: user.identity.firstName,
            lastName: user.identity.lastName,
            email: user.identity.email,
        }))
        const edition = system.getOrThrow(AppSystemProp.EDITION)
        if (edition === ApEdition.COMMUNITY) {
            return platformAdmins
        }
        const projectMembers = await projectMemberService(log).list({
            platformId,
            projectId,
            cursorRequest: null,
            limit: 1000,
            projectRoleId: undefined,
        })
        const projectMembersDetails = projectMembers.data.map(pm => ({
            firstName: pm.user.firstName,
            lastName: pm.user.lastName,
            email: pm.user.email,
        }))
        return [...platformAdmins, ...projectMembersDetails]
    },

    async listForPlatform(params: ListForPlatformParams): Promise<SeekPage<PlatformAppConnectionsListItem>> {
        const service = appConnectionService(log)
        const page = await service.list({
            pieceName: params.pieceName,
            displayName: params.displayName,
            status: params.status,
            scope: params.scope,
            platformId: params.platformId,
            projectId: null,
            projectIds: params.projectIds,
            ownerIds: params.ownerIds,
            cursorRequest: params.cursorRequest,
            limit: params.limit,
            externalIds: undefined,
        })

        const projectIdsToLookUp = unique(page.data.flatMap((connection) => connection.projectIds))
        const projectsById = await fetchProjectsForPlatform(projectIdsToLookUp, params.platformId)

        const data: PlatformAppConnectionsListItem[] = page.data.map((connection) => {
            const sanitized = service.removeSensitiveData(connection)
            const projects: PlatformAppConnectionProjectInfo[] = connection.projectIds
                .map((id) => projectsById.get(id))
                .filter((project): project is PlatformAppConnectionProjectInfo => project !== undefined)
            return { ...sanitized, projects }
        })

        return { ...page, data }
    },

    async listOwnersForPlatform({ platformId }: { platformId: PlatformId }): Promise<PlatformAppConnectionOwnersResponse> {
        const rows = await appConnectionsRepo()
            .createQueryBuilder('app_connection')
            .innerJoin('app_connection.owner', 'owner')
            .innerJoin('owner.identity', 'identity')
            .where('app_connection.platformId = :platformId', { platformId })
            .select('owner.id', 'id')
            .addSelect('identity.firstName', 'firstName')
            .addSelect('identity.lastName', 'lastName')
            .addSelect('identity.email', 'email')
            .distinct(true)
            .orderBy('identity.email', 'ASC')
            .limit(MAX_PLATFORM_APP_CONNECTION_OWNERS + 1)
            .getRawMany<PlatformAppConnectionOwner>()

        const truncated = rows.length > MAX_PLATFORM_APP_CONNECTION_OWNERS
        const data = truncated ? rows.slice(0, MAX_PLATFORM_APP_CONNECTION_OWNERS) : rows
        return { data, truncated }
    },

})

const fetchProjectsForPlatform = async (projectIds: string[], platformId: string): Promise<Map<string, PlatformAppConnectionProjectInfo>> => {
    if (projectIds.length === 0) {
        return new Map()
    }
    const projects = await projectRepo().find({
        where: { id: In(projectIds), platformId },
        select: ['id', 'displayName', 'type'],
    })
    return new Map(projects.map((project) => [project.id, { id: project.id, displayName: project.displayName, type: project.type }]))
}

async function markConnectionTested({ id, testedAt, rowStatus, verdict, message }: {
    id: AppConnectionId
    testedAt: string
    // The row's health status to write, or null to leave it alone — a transient
    // failure (network blip, lock outage) is not evidence the connection is bad,
    // so it must not stop executions from retrying a refresh.
    rowStatus: AppConnectionStatus | null
    // The health check's own verdict, always persisted with the timestamp so the
    // detail page can show "last tested <when>: <result>" across reloads.
    verdict: AppConnectionStatus
    message?: string
}): Promise<TestConnectionResult> {
    // Plain, unconditional write. A previous revision guarded this with
    // `current.status !== status` and claimed it avoided clobbering a newer
    // result, but that condition is true precisely when the stored status
    // differs - i.e. exactly the stale case - so the guard inverted its own
    // intent while costing an extra SELECT.
    //
    // Consequence, stated plainly: if two health checks race, the slower one
    // can write its older verdict last. That is accepted - the next check
    // self-heals the row, and a conditional write would need a compare-and-set
    // on `testedAt` to be any safer.
    await appConnectionsRepo().update({ id }, {
        ...(isNil(rowStatus) ? {} : { status: rowStatus }),
        testedAt,
        testedStatus: verdict,
        testedMessage: sanitizeTestMessage(message),
    })
    return {
        ok: verdict === AppConnectionStatus.ACTIVE,
        status: verdict,
        testedAt,
        message,
    }
}

// The failure message can quote external provider responses (error_description)
// and is persisted to a varchar column: strip control characters postgres
// rejects and cap the length so an oversized provider payload can't bloat rows.
function sanitizeTestMessage(message: string | undefined): string | null {
    if (isNil(message)) {
        return null
    }
    return message.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 512) || null
}

async function assertProjectIds(projectIds: ProjectId[], platformId: string): Promise<void> {
    const filteredProjects = await projectRepo().countBy({
        id: In(projectIds),
        platformId,
    })
    if (filteredProjects !== projectIds.length) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'Project',
            },
        })
    }
}
const validateConnectionValue = async (
    params: ValidateConnectionValueParams,
    log: FastifyBaseLogger,
): Promise<AppConnectionValue> => {
    const { value, pieceName, pieceVersion, projectId, platformId } = params

    switch (value.type) {
        case AppConnectionType.PLATFORM_OAUTH2: {
            const tokenUrl = await oauth2Util(log).getOAuth2TokenUrl({
                pieceName,
                pieceVersion,
                platformId,
                props: value.props,
            })
            return oauth2Handler[value.type](log).claim({
                projectId,
                platformId,
                pieceName,
                request: {
                    grantType: OAuth2GrantType.AUTHORIZATION_CODE,
                    code: value.code,
                    tokenUrl,
                    clientId: value.client_id,
                    props: value.props,
                    authorizationMethod: value.authorization_method,
                    codeVerifier: value.code_challenge,
                    redirectUrl: value.redirect_url,
                },
            })
        }
        case AppConnectionType.CLOUD_OAUTH2: {
            const tokenUrl = await oauth2Util(log).getOAuth2TokenUrl({
                pieceName,
                pieceVersion,
                platformId,
                props: value.props,
            })
            return oauth2Handler[value.type](log).claim({
                projectId,
                platformId,
                pieceName,
                request: {
                    tokenUrl,
                    grantType: OAuth2GrantType.AUTHORIZATION_CODE,
                    code: value.code,
                    props: value.props,
                    clientId: value.client_id,
                    authorizationMethod: value.authorization_method,
                    codeVerifier: value.code_challenge,
                },
            })
        }
        case AppConnectionType.OAUTH2: {
            const tokenUrl = await oauth2Util(log).getOAuth2TokenUrl({
                pieceName,
                pieceVersion,
                platformId,
                props: value.props,
            })
            
            const auth = await oauth2Handler[value.type](log).claim({
                projectId,
                platformId,
                pieceName,
                request: {
                    tokenUrl,
                    code: value.code,
                    clientId: value.client_id,
                    props: value.props,
                    grantType: value.grant_type!,
                    redirectUrl: value.redirect_url,
                    clientSecret: value.client_secret,
                    authorizationMethod: value.authorization_method,
                    codeVerifier: value.code_challenge,
                    scope: value.scope,
                },
            })
            await engineValidateAuth({
                pieceName,
                projectId,
                platformId,
                auth,
            }, log)
            return auth
        }
        case AppConnectionType.NO_AUTH:
            break
        case AppConnectionType.CUSTOM_AUTH:
        case AppConnectionType.OIDC:
        case AppConnectionType.BASIC_AUTH:
        case AppConnectionType.SECRET_TEXT:
            await engineValidateAuth({
                platformId,
                pieceName,
                projectId,
                auth: value,
            }, log)
    }

    return value
}

const engineValidateAuth = async (
    params: EngineValidateAuthParams,
    log: FastifyBaseLogger,
): Promise<void> => {
    const environment = system.getOrThrow(AppSystemProp.ENVIRONMENT)
    if (environment === ApEnvironment.TESTING) {
        return
    }
    const { pieceName, auth, projectId, platformId } = params

    const pieceMetadata = await pieceMetadataService(log).getOrThrow({
        name: pieceName,
        version: undefined,
        platformId,
    })

    const engineResponse = await userInteractionWatcher.submitAndWaitForResponse<EngineResponse<ExecuteValidateAuthResponse>>({
        piece: await getPiecePackageWithoutArchive(log, platformId, {
            pieceName,
            pieceVersion: pieceMetadata.version,
        }),
        projectId,
        platformId,
        auth,
        jobType: WorkerJobType.EXECUTE_VALIDATION,
    }, log)

    if (engineResponse.status !== EngineResponseStatus.OK) {
        log.error(
            { engineResponse },
            'Engine validate auth failed',
        )
        throw new ActivepiecesError({
            code: ErrorCode.ENGINE_OPERATION_FAILURE,
            params: {
                message: 'Failed to run engine validate auth',
                context: engineResponse,
            },
        })
    }

    const validateAuthResult = engineResponse.response

    if (!validateAuthResult.valid) {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_APP_CONNECTION,
            params: {
                error: validateAuthResult.error,
            },
        })
    }
}


function mapToUserWithMetaInformation(owner: (User & { identity?: UserIdentity }) | null): UserWithMetaInformation | null {
    if (isNil(owner)) {
        return null
    }
    const identity = owner.identity
    if (isNil(identity)) {
        return null
    }

    return {
        id: owner.id,
        email: identity.email,
        firstName: identity.firstName,
        lastName: identity.lastName,
        platformId: owner.platformId,
        platformRole: owner.platformRole,
        status: owner.status,
        externalId: owner.externalId,
        created: owner.created,
        updated: owner.updated,
    }
}

function validatePieceVersion(pieceVersion: string): void {
    if (!semver.valid(pieceVersion)) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: 'Invalid piece version',
            },
        })
    }
}
type UpsertParams = {
    projectIds: ProjectId[]
    ownerId: string | null
    platformId: string
    scope: AppConnectionScope
    externalId: string
    value: Extract<UpsertAppConnectionRequestBody, { value: unknown }>['value']
    displayName: string
    type: AppConnectionType
    status?: AppConnectionStatus
    pieceName: string
    metadata?: Metadata
    pieceVersion?: string
    preSelectForNewProjects?: boolean
}


type GetOneByName = {
    projectId: ProjectId
    platformId: string
    externalId: string
}

type GetOneParams = {
    projectId: ProjectId | null
    platformId: string
    id: string
}

type GetManyParams = {
    projectId: ProjectId
}

type DeleteParams = {
    projectId: ProjectId | null
    scope: AppConnectionScope
    id: AppConnectionId
    platformId: string
}

type ValidateConnectionValueParams = {
    value: Extract<UpsertAppConnectionRequestBody, { value: unknown }>['value']
    pieceName: string
    pieceVersion: string
    projectId: ProjectId | undefined
    platformId: string
}

type ListParams = {
    projectId: ProjectId | null
    projectIds?: ProjectId[]
    ownerIds?: string[]
    platformId: string
    pieceName: string | undefined
    cursorRequest: Cursor | null
    scope: AppConnectionScope | undefined
    displayName: string | undefined
    status: AppConnectionStatus[] | undefined
    limit: number
    externalIds: string[] | undefined
}

type ListForPlatformParams = {
    platformId: string
    pieceName: string | undefined
    displayName: string | undefined
    status: AppConnectionStatus[] | undefined
    scope: AppConnectionScope | undefined
    projectIds: ProjectId[] | undefined
    ownerIds: string[] | undefined
    cursorRequest: Cursor | null
    limit: number
}

type UpdateParams = {
    projectIds: ProjectId[] | null
    platformId: string
    id: AppConnectionId
    scope: AppConnectionScope
    request: {
        displayName: string
        projectIds: ProjectId[] | null
        metadata?: Metadata
        preSelectForNewProjects?: boolean
    }
}

type EngineValidateAuthParams = {
    pieceName: string
    projectId: ProjectId | undefined
    platformId: string
    auth: AppConnectionValue
}

type TestConnectionParams = {
    id: AppConnectionId
    projectId: ProjectId
    platformId: string
}

type TestConnectionResult = {
    ok: boolean
    status: AppConnectionStatus
    testedAt: string
    message?: string
}


