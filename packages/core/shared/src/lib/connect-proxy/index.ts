import { z } from 'zod'

export const ProxyHttpMethod = {
    GET: 'GET',
    POST: 'POST',
    PUT: 'PUT',
    PATCH: 'PATCH',
    DELETE: 'DELETE',
} as const

export type ProxyHttpMethod = (typeof ProxyHttpMethod)[keyof typeof ProxyHttpMethod]

export const ProxyHttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export type SupportedProxyProvider = {
    provider: string
    name: string
    baseUrl: string
    authType: 'bearer' | 'header' | 'custom'
    authHeaderName?: string
    authHeaderPrefix?: string
    defaultHeaders?: Record<string, string>
    supportsSubdomain?: boolean
    subdomainRegex?: RegExp
    allowedPieceNames?: string[]
}

export const ALLOWED_PROXY_PROVIDERS: Record<string, SupportedProxyProvider> = {
    slack: {
        provider: 'slack',
        name: 'Slack',
        baseUrl: 'https://slack.com/api',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
        allowedPieceNames: ['slack'],
    },
    github: {
        provider: 'github',
        name: 'GitHub',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
        allowedPieceNames: ['github'],
        defaultHeaders: {
            'User-Agent': 'InboxFM-Connect-Proxy/1.0',
            'Accept': 'application/vnd.github+json',
        },
    },
    notion: {
        provider: 'notion',
        name: 'Notion',
        baseUrl: 'https://api.notion.com/v1',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
        allowedPieceNames: ['notion'],
        defaultHeaders: {
            'Notion-Version': '2022-06-28',
        },
    },
    hubspot: {
        provider: 'hubspot',
        name: 'HubSpot',
        baseUrl: 'https://api.hubapi.com',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
        allowedPieceNames: ['hubspot'],
    },
    google: {
        provider: 'google',
        name: 'Google',
        baseUrl: 'https://www.googleapis.com',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
        allowedPieceNames: ['google', 'google-calendar', 'google_calendar', 'google-sheets', 'google-drive', 'google-docs'],
    },
    google_calendar: {
        provider: 'google_calendar',
        name: 'Google Calendar',
        baseUrl: 'https://www.googleapis.com/calendar/v3',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
        allowedPieceNames: ['google-calendar', 'google_calendar', 'google'],
    },
    stripe: {
        provider: 'stripe',
        name: 'Stripe',
        baseUrl: 'https://api.stripe.com/v1',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
    },
    zendesk: {
        provider: 'zendesk',
        name: 'Zendesk',
        baseUrl: 'https://{subdomain}.zendesk.com/api/v2',
        authType: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderPrefix: 'Bearer ',
        supportsSubdomain: true,
        subdomainRegex: /^[a-zA-Z0-9-]+$/,
    },
}

export const ConnectProxyRequest = z.object({
    projectId: z.string().min(1).describe('The project ID owning the connection and API key'),
    externalUserId: z.string().min(1).describe('Authenticated external customer ID owning the connection'),
    provider: z.string().min(1).describe('Target provider integration name (e.g. "slack", "github", "hubspot")'),
    connectionId: z.string().optional().describe('Optional explicit connection ID. Must match the customer and provider.'),
    subdomain: z.string().regex(/^[a-zA-Z0-9-]+$/).optional().describe('Optional tenant subdomain for providers requiring dynamic domains (e.g. Zendesk)'),
    method: ProxyHttpMethodSchema.default(ProxyHttpMethod.GET).describe('HTTP method to send to upstream provider'),
    path: z
        .string()
        .min(1)
        .refine((p) => !p.startsWith('http://') && !p.startsWith('https://') && !p.startsWith('//'), {
            message: 'Path must be a relative path and cannot contain an absolute URL scheme',
        })
        .refine((p) => !p.includes('\\'), {
            message: 'Path cannot contain backslashes',
        })
        .refine((p) => !/[\x00-\x1F\x7F]/.test(p), {
            message: 'Path cannot contain control characters',
        })
        .refine((p) => !p.includes('/../') && !p.startsWith('../') && !p.endsWith('/..') && p !== '..', {
            message: 'Path cannot contain directory traversal elements ("..")',
        })
        .describe('Relative sub-path on the provider API (e.g. "/users.info" or "/user/repos")'),
    headers: z.record(z.string(), z.string()).optional().describe('Custom request headers. Authorization and host headers are forbidden.'),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional().describe('URL query parameters'),
    body: z.unknown().optional().describe('Request payload (JSON or string) for POST, PUT, or PATCH requests'),
    timeoutMs: z.number().int().min(500).max(60000).default(30000).describe('Request timeout in milliseconds (500ms to 60,000ms, default 30s)'),
    idempotencyKey: z.string().optional().describe('Optional idempotency key to prevent accidental duplicate execution'),
})

export type ConnectProxyRequest = z.infer<typeof ConnectProxyRequest>

export const ConnectProxyResponse = z.object({
    status: z.number().int().describe('Upstream HTTP response status code'),
    statusText: z.string().describe('Upstream HTTP status text'),
    headers: z.record(z.string(), z.string()).describe('Upstream response headers (sanitized, hop-by-hop stripped)'),
    data: z.unknown().describe('Upstream response body parsed as JSON if possible, otherwise string or null'),
    provider: z.string().describe('The provider that handled the request'),
    rateLimit: z
        .object({
            limit: z.number().optional(),
            remaining: z.number().optional(),
            reset: z.number().optional(),
        })
        .optional()
        .describe('Normalized rate limit details extracted from upstream headers if present'),
})

export type ConnectProxyResponse = z.infer<typeof ConnectProxyResponse>

export const ConnectProxyErrorCode = {
    PROVIDER_NOT_SUPPORTED: 'PROVIDER_NOT_SUPPORTED',
    CONNECTION_NOT_FOUND: 'CONNECTION_NOT_FOUND',
    CROSS_CUSTOMER_FORBIDDEN: 'CROSS_CUSTOMER_FORBIDDEN',
    CROSS_PROJECT_FORBIDDEN: 'CROSS_PROJECT_FORBIDDEN',
    PROVIDER_MISMATCH: 'PROVIDER_MISMATCH',
    SSRF_BLOCKED: 'SSRF_BLOCKED',
    INVALID_PATH: 'INVALID_PATH',
    PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
    UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
    UPSTREAM_ERROR: 'UPSTREAM_ERROR',
} as const

export type ConnectProxyErrorCode = (typeof ConnectProxyErrorCode)[keyof typeof ConnectProxyErrorCode]
