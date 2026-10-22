import { BaseModelSchema } from '@inboxfm-connect/core-utils'
import { z } from 'zod'

export const McpOAuthClient = z.object({
    ...BaseModelSchema,
    clientId: z.string(),
    clientSecret: z.string().nullable(),
    clientSecretExpiresAt: z.coerce.number(),
    clientIdIssuedAt: z.coerce.number(),
    redirectUris: z.array(z.string()),
    clientName: z.string().nullable(),
    grantTypes: z.array(z.string()),
    tokenEndpointAuthMethod: z.string(),
})

export type McpOAuthClient = z.infer<typeof McpOAuthClient>

export const McpOAuthToken = z.object({
    ...BaseModelSchema,
    refreshToken: z.string(),
    // Hash of the refresh token this row was rotated FROM (null on first issue).
    // Lets a replayed token be attributed to its lineage (issue #332).
    previousRefreshToken: z.string().nullable(),
    // Stable id of the lineage root: every rotation descendant carries the
    // familyId of the first-issued token, enabling family revocation (#332).
    familyId: z.string(),
    clientId: z.string(),
    userId: z.string(),
    projectId: z.string().nullable(),
    platformId: z.string(),
    scopes: z.array(z.string()).nullable(),
    expiresAt: z.string(),
    revoked: z.boolean(),
})

export type McpOAuthToken = z.infer<typeof McpOAuthToken>

export const McpOAuthAuthorizationCode = z.object({
    ...BaseModelSchema,
    code: z.string(),
    clientId: z.string(),
    userId: z.string(),
    projectId: z.string().nullable(),
    platformId: z.string(),
    redirectUri: z.string(),
    codeChallenge: z.string(),
    codeChallengeMethod: z.string(),
    scopes: z.array(z.string()).nullable(),
    state: z.string().nullable(),
    expiresAt: z.string(),
    used: z.boolean(),
})

export type McpOAuthAuthorizationCode = z.infer<typeof McpOAuthAuthorizationCode>

