import type { ApId, PlatformId, ProjectId } from '@inboxfm-connect/core-utils'
import { PrincipalType } from './principal-type'

export type WorkerPrincipal = {
    id: ApId
    type: PrincipalType.WORKER
}

export type AnnonymousPrincipal = {
    id: ApId
    type: PrincipalType.UNKNOWN
}

export type ServicePrincipal = {
    id: ApId
    type: PrincipalType.SERVICE
    platform: {
        id: ApId
    }
    projectId?: ProjectId
}

export type UserPrincipal = {
    id: ApId
    type: PrincipalType.USER
    platform: {
        id: ApId
    }
    tokenVersion?: string
}

export type EnginePrincipal = {
    id: ApId
    type: PrincipalType.ENGINE
    // Optional: platform-scoped engine operations (e.g. piece metadata extraction) mint
    // tokens without a project; project-scoped authz denies those by default.
    projectId: ProjectId | undefined
    platform: {
        id: PlatformId
    }
}


export type OnboardingPrincipal = {
    id: ApId
    type: PrincipalType.ONBOARDING
    tokenVersion?: string
}

export type PrincipalForType<T extends PrincipalType> = Extract<Principal, { type: T }>

export type PrincipalForTypes<R extends readonly PrincipalType[]> = PrincipalForType<R[number]>

export type Principal =
    | WorkerPrincipal
    | AnnonymousPrincipal
    | ServicePrincipal
    | UserPrincipal
    | EnginePrincipal
    | OnboardingPrincipal

