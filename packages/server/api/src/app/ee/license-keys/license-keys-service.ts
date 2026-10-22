import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { safeHttp } from '@inboxfm-connect/server-utils'
import { ApEdition, CreateTrialLicenseKeyRequestBody, LicenseKeyEntity, PlanName, TeamProjectsLimit, TelemetryEventName } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { rejectedPromiseHandler } from '../../helper/promise-handler'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { telemetry } from '../../helper/telemetry.utils'
import { platformService } from '../../platform/platform.service'
import { platformPlanService } from '../platform/platform-plan/platform-plan.service'

const secretManagerLicenseKeysRoute = 'https://secrets.activepieces.com/license-keys'

const httpClient = safeHttp.createAxios({ validateStatus: () => true })

const handleUnexpectedSecretsManagerError = (log: FastifyBaseLogger, message: string) => {
    log.error({ message }, '[licenseKeysService#handleUnexpectedSecretsManagerError] Unexpected error from secret manager')
    throw new Error(message)
}

export const licenseKeysService = (log: FastifyBaseLogger) => ({
    async requestTrial(request: CreateTrialLicenseKeyRequestBody): Promise<LicenseKeyEntity> {
        const response = await httpClient.post<LicenseKeyEntity>(secretManagerLicenseKeysRoute, request, {
            headers: {
                'Content-Type': 'application/json',
            },
        })
        if (response.status === StatusCodes.CONFLICT) {
            throw new ActivepiecesError({
                code: ErrorCode.EMAIL_ALREADY_HAS_ACTIVATION_KEY,
                params: request,
            })
        }
        if (response.status < 200 || response.status >= 300) {
            const errorMessage = JSON.stringify(response.data)
            handleUnexpectedSecretsManagerError(log, errorMessage)
        }
        return response.data
    },
    async markAsActiviated(request: { key: string, platformId?: string }): Promise<void> {
        try {
            const response = await httpClient.post(secretManagerLicenseKeysRoute + '/activate', request, {
                headers: {
                    'Content-Type': 'application/json',
                },
            })
            if (response.status === StatusCodes.CONFLICT) {
                return
            }
            if (response.status === StatusCodes.NOT_FOUND) {
                return
            }
            if (response.status < 200 || response.status >= 300) {
                const errorMessage = JSON.stringify(response.data)
                handleUnexpectedSecretsManagerError(log, errorMessage)
            }
            if (request.platformId) {
                rejectedPromiseHandler(telemetry(log).trackPlatform(request.platformId, {
                    name: TelemetryEventName.KEY_ACTIVATED,
                    payload: {
                        date: dayjs().toISOString(),
                        key: request.key,
                    },
                }), log)
            }
        }
        catch (e) {
            // ignore
        }
    },
    async getKey(license: string | undefined): Promise<LicenseKeyEntity | null> {
        if (isNil(license)) {
            return null
        }
        const response = await httpClient.get<LicenseKeyEntity>(`${secretManagerLicenseKeysRoute}/${license}`)
        if (response.status === StatusCodes.NOT_FOUND) {
            return null
        }
        if (response.status < 200 || response.status >= 300) {
            const errorMessage = JSON.stringify(response.data)
            handleUnexpectedSecretsManagerError(log, errorMessage)
        }
        return response.data
    },
    async verifyKeyOrReturnNull({ platformId, license }: { license: string | undefined, platformId: string }): Promise<LicenseKeyEntity | null> {
        if (isNil(license)) {
            return null
        }
        await this.markAsActiviated({ key: license, platformId })
        const key = await this.getKey(license)
        const isExpired = isNil(key) || dayjs(key.expiresAt).isBefore(dayjs())
        return isExpired ? null : key
    },
    async extendTrial({ email, days }: { email: string, days: number }): Promise<void> {
        const SECRET_MANAGER_API_KEY = system.getOrThrow(AppSystemProp.SECRET_MANAGER_API_KEY)
        const response = await httpClient.post(`${secretManagerLicenseKeysRoute}/extend-trial`, { email, days }, {
            headers: {
                'Content-Type': 'application/json',
                'api-key': SECRET_MANAGER_API_KEY,
            },
        })

        if (response.status === StatusCodes.NOT_FOUND) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    message: 'License key not found',
                },
            })
        }

        if (response.status < 200 || response.status >= 300) {
            const errorMessage = JSON.stringify(response.data)
            handleUnexpectedSecretsManagerError(log, errorMessage)
        }
    },
    async downgradeToFreePlan(platformId: string): Promise<void> {
        await platformPlanService(log).update({ ...turnedOffFeatures, platformId })
        await platformService(log).update({
            id: platformId,
            plan: {
                ...turnedOffFeatures,
            },
        })
    },
    async applyLimits(platformId: string, key: LicenseKeyEntity): Promise<void> {
        const isInternalPlan = !key.ssoEnabled && !key.embeddingEnabled && system.getEdition() === ApEdition.CLOUD
        const teamProjectsLimit = key.manageProjectsEnabled ? TeamProjectsLimit.UNLIMITED : system.getEdition() === ApEdition.CLOUD ? TeamProjectsLimit.ONE : TeamProjectsLimit.NONE
        await platformService(log).update({
            id: platformId,
            plan: {
                plan: isInternalPlan ? 'internal' : PlanName.ENTERPRISE,
                licenseKey: key.key,
                licenseExpiresAt: key.expiresAt,
                ssoEnabled: key.ssoEnabled,
                scimEnabled: key.scimEnabled,
                environmentsEnabled: key.environmentsEnabled,
                showPoweredBy: key.showPoweredBy,
                embeddingEnabled: key.embeddingEnabled,
                auditLogEnabled: key.auditLogEnabled,
                customAppearanceEnabled: key.customAppearanceEnabled,
                globalConnectionsEnabled: key.globalConnectionsEnabled,
                customRolesEnabled: key.customRolesEnabled,
                teamProjectsLimit,
                managePiecesEnabled: key.managePiecesEnabled,
                activeFlowsLimit: undefined,
                projectsLimit: undefined,
                stripeSubscriptionId: undefined,
                stripeSubscriptionStatus: undefined,
                manageTemplatesEnabled: key.manageTemplatesEnabled,
                apiKeysEnabled: key.apiKeysEnabled,
                projectRolesEnabled: key.projectRolesEnabled,
                analyticsEnabled: key.analyticsEnabled,
                eventStreamingEnabled: key.eventStreamingEnabled,
                secretManagersEnabled: key.secretManagersEnabled,
                agentsEnabled: key.agentsEnabled,
                aiProvidersEnabled: key.aiProvidersEnabled ?? true,
                chatEnabled: key.chatEnabled ?? false,
                workerGroupsEnabled: key.workerGroupsEnabled ?? false,
            },
        })
    },
})

const turnedOffFeatures: Omit<LicenseKeyEntity, 'id' | 'createdAt' | 'expiresAt' | 'activatedAt' | 'isTrial' | 'email' | 'customerName' | 'key'> = {
    ssoEnabled: false,
    scimEnabled: false,
    analyticsEnabled: false,
    environmentsEnabled: false,
    showPoweredBy: false,
    embeddingEnabled: false,
    auditLogEnabled: false,
    customAppearanceEnabled: false,
    manageProjectsEnabled: false,
    managePiecesEnabled: false,
    manageTemplatesEnabled: false,
    apiKeysEnabled: false,
    globalConnectionsEnabled: false,
    customRolesEnabled: false,
    projectRolesEnabled: false,
    eventStreamingEnabled: false,
    secretManagersEnabled: false,
    agentsEnabled: false,
    aiProvidersEnabled: false,
    chatEnabled: false,
    workerGroupsEnabled: false,
}
