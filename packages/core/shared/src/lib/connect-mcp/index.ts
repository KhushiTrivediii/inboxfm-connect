import { ApId, Nullable } from '@inboxfm-connect/core-utils'
import { z } from 'zod'

export const CreateConnectMcpTokenRequest = z.object({
    projectId: ApId,
    externalUserId: z.string().min(1),
    allowedPieceNames: z.array(z.string()).optional(),
    expiresInSeconds: z.number().int().positive().max(7 * 86400).optional(),
})

export type CreateConnectMcpTokenRequest = z.infer<typeof CreateConnectMcpTokenRequest>

export const CreateConnectMcpTokenResponse = z.object({
    token: z.string(),
    mcpServerUrl: z.string(),
    expiresAt: z.string(),
    projectId: ApId,
    externalUserId: z.string(),
    allowedPieceNames: Nullable(z.array(z.string())),
})

export type CreateConnectMcpTokenResponse = z.infer<typeof CreateConnectMcpTokenResponse>

export const ExchangeConnectSessionMcpTokenRequest = z.object({
    expiresInSeconds: z.number().int().positive().max(7 * 86400).optional(),
})

export type ExchangeConnectSessionMcpTokenRequest = z.infer<typeof ExchangeConnectSessionMcpTokenRequest>

export type ExternalUserMcpContext = {
    externalUserId: string
    projectId: string
    platformId: string
    allowedPieceNames: string[] | null
}
