import { describe, expect, it } from 'vitest'
import {
    AppConnectionScope,
    AppConnectionStatus,
    AppConnectionType,
    AppConnectionWithoutSensitiveData,
    AppConnectionOwners,
    resolveValueFromProps,
} from '../../../src/lib/automation/app-connection/app-connection'
import { OAuth2AuthorizationMethod } from '../../../src/lib/automation/app-connection/oauth2-authorization-method'
import {
    ListAppConnectionsRequestQuery,
    GetAppConnectionForWorkerRequestQuery,
    ListGlobalConnectionsRequestQuery,
    ListAppConnectionOwnersRequestQuery,
    ListPlatformAppConnectionsRequestQuery,
    PlatformAppConnectionProjectInfo,
    PlatformAppConnectionsListItem,
    PlatformAppConnectionOwner,
    PlatformAppConnectionOwnersResponse,
    MAX_PLATFORM_APP_CONNECTION_OWNERS,
} from '../../../src/lib/automation/app-connection/dto/read-app-connection-request'
import {
    OAuth2GrantType,
    UpsertCustomAuthRequest,
    UpsertOIDCRequest,
    UpsertNoAuthRequest,
    UpsertPlaceholderConnectionRequest,
    UpsertPlatformOAuth2Request,
    UpsertCloudOAuth2Request,
    UpsertSecretTextRequest,
    UpsertOAuth2Request,
    UpsertBasicAuthRequest,
    UpsertAppConnectionRequestBody,
    UpdateConnectionValueRequestBody,
    UpdateGlobalConnectionValueRequestBody,
    UpsertGlobalConnectionRequestBody,
    GetOAuth2AuthorizationUrlRequestBody,
    GetOAuth2AuthorizationUrlResponse,
    ReplaceAppConnectionsRequestBody,
    ListFlowsFromAppConnectionRequestQuery,
    BOTH_CLIENT_CREDENTIALS_AND_AUTHORIZATION_CODE,
    PLACEHOLDER_CONNECTION_TYPE,
} from '../../../src/lib/automation/app-connection/dto/upsert-app-connection-request'
import { ProjectType } from '../../../src/lib/management/project/project'

describe('resolveValueFromProps', () => {
    it('returns original value when props is undefined', () => {
        expect(resolveValueFromProps(undefined, 'https://api.example.com/{tenant}')).toBe('https://api.example.com/{tenant}')
    })

    it('returns original value when props is empty object', () => {
        expect(resolveValueFromProps({}, 'https://api.example.com/{tenant}')).toBe('https://api.example.com/{tenant}')
    })

    it('replaces a single occurrence of a prop placeholder', () => {
        const props = { tenantId: 'tenant-123' }
        expect(resolveValueFromProps(props, 'https://login.microsoftonline.com/{tenantId}/v2.0')).toBe(
            'https://login.microsoftonline.com/tenant-123/v2.0',
        )
    })

    it('replaces ALL occurrences of a prop placeholder when repeated (discriminator test)', () => {
        const props = { tenantId: 'tenant-456' }
        const template = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token?tenant={tenantId}'
        const resolved = resolveValueFromProps(props, template)
        expect(resolved).toBe('https://login.microsoftonline.com/tenant-456/oauth2/v2.0/token?tenant=tenant-456')
        expect(resolved).not.toContain('{tenantId}')
    })

    it('replaces multiple distinct placeholders', () => {
        const props = { region: 'us-east-1', account: '123456789' }
        expect(resolveValueFromProps(props, 'arn:aws:s3:{region}:{account}:bucket')).toBe('arn:aws:s3:us-east-1:123456789:bucket')
    })

    it('coerces non-string prop values to strings', () => {
        const props = { port: 8080, ssl: true }
        expect(resolveValueFromProps(props, 'http://localhost:{port}?secure={ssl}')).toBe('http://localhost:8080?secure=true')
    })

    it('ignores props not present in the template', () => {
        const props = { unused: 'foo', active: 'bar' }
        expect(resolveValueFromProps(props, 'constant-value')).toBe('constant-value')
    })
})

describe('AppConnectionWithoutSensitiveData schema', () => {
    const validBaseConnection = {
        id: '123456789012345678901',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        externalId: 'ext-conn-1',
        displayName: 'My Slack Connection',
        type: AppConnectionType.SECRET_TEXT,
        pieceName: '@inboxfm-connect/piece-slack',
        projectIds: ['123456789012345678901'],
        platformId: null,
        scope: AppConnectionScope.PROJECT,
        status: AppConnectionStatus.ACTIVE,
        ownerId: null,
        owner: null,
        metadata: null,
        pieceVersion: '0.1.0',
        preSelectForNewProjects: false,
        usingSecretManager: false,
        testedAt: null,
        testedStatus: null,
        testedMessage: null,
    }

    it('parses valid connection object without sensitive data', () => {
        const parsed = AppConnectionWithoutSensitiveData.parse(validBaseConnection)
        expect(parsed.displayName).toBe('My Slack Connection')
        expect(parsed.type).toBe(AppConnectionType.SECRET_TEXT)
        expect(parsed.status).toBe(AppConnectionStatus.ACTIVE)
    })

    it('parses persisted health-check bookkeeping', () => {
        const parsed = AppConnectionWithoutSensitiveData.parse({
            ...validBaseConnection,
            testedAt: '2026-10-13T09:00:00.000Z',
            testedStatus: AppConnectionStatus.ERROR,
            testedMessage: 'The app rejected the stored credentials.',
        })
        expect(parsed.testedAt).toBe('2026-10-13T09:00:00.000Z')
        expect(parsed.testedStatus).toBe(AppConnectionStatus.ERROR)
        expect(parsed.testedMessage).toBe('The app rejected the stored credentials.')
    })

    it('validates with platform scope and metadata', () => {
        const conn = {
            ...validBaseConnection,
            scope: AppConnectionScope.PLATFORM,
            platformId: 'plat-123',
            ownerId: 'user-456',
            status: AppConnectionStatus.ERROR,
            metadata: { env: 'production' },
            usingSecretManager: true,
        }
        const parsed = AppConnectionWithoutSensitiveData.parse(conn)
        expect(parsed.scope).toBe(AppConnectionScope.PLATFORM)
        expect(parsed.status).toBe(AppConnectionStatus.ERROR)
        expect(parsed.usingSecretManager).toBe(true)
    })

    it('rejects missing required fields', () => {
        const { externalId, ...missingExternalId } = validBaseConnection
        expect(() => AppConnectionWithoutSensitiveData.parse(missingExternalId)).toThrow()
    })

    it('rejects invalid connection type', () => {
        expect(() => AppConnectionWithoutSensitiveData.parse({ ...validBaseConnection, type: 'INVALID_TYPE' })).toThrow()
    })

    it('rejects invalid status', () => {
        expect(() => AppConnectionWithoutSensitiveData.parse({ ...validBaseConnection, status: 'UNKNOWN_STATUS' })).toThrow()
    })
})

describe('AppConnectionOwners schema', () => {
    it('parses valid owner info', () => {
        const owner = {
            firstName: 'Rakshit',
            lastName: 'Sapariya',
            email: 'rakshits9828@gmail.com',
        }
        const parsed = AppConnectionOwners.parse(owner)
        expect(parsed.email).toBe('rakshits9828@gmail.com')
    })

    it('rejects missing email', () => {
        expect(() => AppConnectionOwners.parse({ firstName: 'Rakshit', lastName: 'Sapariya' })).toThrow()
    })
})

describe('ListAppConnectionsRequestQuery schema', () => {
    it('parses minimal query with projectId', () => {
        const parsed = ListAppConnectionsRequestQuery.parse({ projectId: 'proj-1' })
        expect(parsed.projectId).toBe('proj-1')
        expect(parsed.limit).toBeUndefined()
    })

    it('parses full query and coerces limit', () => {
        const parsed = ListAppConnectionsRequestQuery.parse({
            projectId: 'proj-1',
            cursor: 'cur_abc',
            scope: AppConnectionScope.PROJECT,
            pieceName: 'slack',
            displayName: 'My Slack',
            externalId: 'ext-1',
            status: [AppConnectionStatus.ACTIVE, AppConnectionStatus.ERROR],
            limit: '25',
        })
        expect(parsed.limit).toBe(25)
        expect(parsed.status).toEqual([AppConnectionStatus.ACTIVE, AppConnectionStatus.ERROR])
    })

    it('handles single status string via OptionalArrayFromQuery', () => {
        const parsed = ListAppConnectionsRequestQuery.parse({
            projectId: 'proj-1',
            status: AppConnectionStatus.ACTIVE,
        })
        expect(parsed.status).toEqual([AppConnectionStatus.ACTIVE])
    })

    it('rejects when projectId is missing', () => {
        expect(() => ListAppConnectionsRequestQuery.parse({})).toThrow()
    })
})

describe('GetAppConnectionForWorkerRequestQuery schema', () => {
    it('validates externalId', () => {
        const parsed = GetAppConnectionForWorkerRequestQuery.parse({ externalId: 'ext-conn' })
        expect(parsed.externalId).toBe('ext-conn')
    })

    it('rejects missing externalId', () => {
        expect(() => GetAppConnectionForWorkerRequestQuery.parse({})).toThrow()
    })
})

describe('ListPlatformAppConnectionsRequestQuery & ProjectInfo', () => {
    it('parses query with projectIds and ownerIds arrays', () => {
        const parsed = ListPlatformAppConnectionsRequestQuery.parse({
            projectIds: ['p1', 'p2'],
            ownerIds: 'u1',
            limit: '10',
            scope: AppConnectionScope.PLATFORM,
        })
        expect(parsed.projectIds).toEqual(['p1', 'p2'])
        expect(parsed.ownerIds).toEqual(['u1'])
        expect(parsed.limit).toBe(10)
    })

    it('validates PlatformAppConnectionProjectInfo', () => {
        const parsed = PlatformAppConnectionProjectInfo.parse({
            id: 'proj-1',
            displayName: 'Default Project',
            type: ProjectType.TEAM,
        })
        expect(parsed.type).toBe(ProjectType.TEAM)
    })

    it('validates PlatformAppConnectionOwnersResponse and MAX constant', () => {
        expect(MAX_PLATFORM_APP_CONNECTION_OWNERS).toBe(1000)
        const response = {
            data: [{ id: 'u1', firstName: 'John', lastName: 'Doe', email: 'john@example.com' }],
            truncated: false,
        }
        const parsed = PlatformAppConnectionOwnersResponse.parse(response)
        expect(parsed.data).toHaveLength(1)
        expect(parsed.truncated).toBe(false)
    })
})

describe('UpsertAppConnectionRequestBody union schemas', () => {
    const common = {
        externalId: 'ext-1',
        displayName: 'Connection 1',
        pieceName: 'piece-github',
        projectId: 'proj-1',
    }

    it('parses UpsertSecretTextRequest', () => {
        const body = {
            ...common,
            type: AppConnectionType.SECRET_TEXT,
            value: {
                type: AppConnectionType.SECRET_TEXT,
                secret_text: 'my-api-token',
            },
        }
        const parsed = UpsertSecretTextRequest.parse(body)
        expect(parsed.value.secret_text).toBe('my-api-token')
        expect(UpsertAppConnectionRequestBody.parse(body)).toBeDefined()
    })

    it('rejects UpsertSecretTextRequest with empty secret_text', () => {
        const body = {
            ...common,
            type: AppConnectionType.SECRET_TEXT,
            value: {
                type: AppConnectionType.SECRET_TEXT,
                secret_text: '',
            },
        }
        expect(() => UpsertSecretTextRequest.parse(body)).toThrow()
    })

    it('parses UpsertBasicAuthRequest', () => {
        const body = {
            ...common,
            type: AppConnectionType.BASIC_AUTH,
            value: {
                type: AppConnectionType.BASIC_AUTH,
                username: 'admin',
                password: 'secretpassword',
            },
        }
        const parsed = UpsertBasicAuthRequest.parse(body)
        expect(parsed.value.username).toBe('admin')
        expect(UpsertAppConnectionRequestBody.parse(body)).toBeDefined()
    })

    it('rejects UpsertBasicAuthRequest with missing username or password', () => {
        expect(() => UpsertBasicAuthRequest.parse({
            ...common,
            type: AppConnectionType.BASIC_AUTH,
            value: {
                type: AppConnectionType.BASIC_AUTH,
                username: '',
                password: 'pwd',
            },
        })).toThrow()
    })

    it('parses UpsertCustomAuthRequest with arbitrary props record', () => {
        const body = {
            ...common,
            type: AppConnectionType.CUSTOM_AUTH,
            value: {
                type: AppConnectionType.CUSTOM_AUTH,
                props: { apiKey: 'key-123', subdomain: 'my-tenant' },
            },
        }
        const parsed = UpsertCustomAuthRequest.parse(body)
        expect(parsed.value.props.apiKey).toBe('key-123')
        expect(UpsertAppConnectionRequestBody.parse(body)).toBeDefined()
    })

    it('parses UpsertOIDCRequest', () => {
        const body = {
            ...common,
            type: AppConnectionType.OIDC,
            value: {
                type: AppConnectionType.OIDC,
                props: { issuer: 'https://auth.example.com' },
            },
        }
        const parsed = UpsertOIDCRequest.parse(body)
        expect(parsed.type).toBe(AppConnectionType.OIDC)
        expect(UpsertAppConnectionRequestBody.parse(body)).toBeDefined()
    })

    it('parses UpsertNoAuthRequest', () => {
        const body = {
            ...common,
            type: AppConnectionType.NO_AUTH,
            value: {
                type: AppConnectionType.NO_AUTH,
            },
        }
        const parsed = UpsertNoAuthRequest.parse(body)
        expect(parsed.type).toBe(AppConnectionType.NO_AUTH)
        expect(UpsertAppConnectionRequestBody.parse(body)).toBeDefined()
    })

    it('parses UpsertPlaceholderConnectionRequest without value field', () => {
        const body = {
            ...common,
            type: PLACEHOLDER_CONNECTION_TYPE,
        }
        const parsed = UpsertPlaceholderConnectionRequest.parse(body)
        expect(parsed.type).toBe(PLACEHOLDER_CONNECTION_TYPE)
        expect(UpsertAppConnectionRequestBody.parse(body)).toBeDefined()
    })

    it('parses UpsertOAuth2Request with authorization code and credentials', () => {
        const body = {
            ...common,
            type: AppConnectionType.OAUTH2,
            value: {
                type: AppConnectionType.OAUTH2,
                client_id: 'client-id-123',
                client_secret: 'client-secret-xyz',
                code: 'auth-code-789',
                redirect_url: 'https://cloud.inboxfm.com/redirect',
                scope: 'repo read:user',
                grant_type: OAuth2GrantType.AUTHORIZATION_CODE,
                authorization_method: OAuth2AuthorizationMethod.HEADER,
            },
        }
        const parsed = UpsertOAuth2Request.parse(body)
        expect(parsed.value.grant_type).toBe(OAuth2GrantType.AUTHORIZATION_CODE)
        expect(parsed.value.authorization_method).toBe(OAuth2AuthorizationMethod.HEADER)
        expect(UpsertAppConnectionRequestBody.parse(body)).toBeDefined()
    })

    it('parses UpsertCloudOAuth2Request and UpsertPlatformOAuth2Request', () => {
        const cloudBody = {
            ...common,
            type: AppConnectionType.CLOUD_OAUTH2,
            value: {
                type: AppConnectionType.CLOUD_OAUTH2,
                client_id: 'cid',
                code: 'code1',
                scope: 'read',
            },
        }
        expect(UpsertCloudOAuth2Request.parse(cloudBody)).toBeDefined()

        const platformBody = {
            ...common,
            type: AppConnectionType.PLATFORM_OAUTH2,
            value: {
                type: AppConnectionType.PLATFORM_OAUTH2,
                client_id: 'cid',
                code: 'code2',
                scope: 'write',
                redirect_url: 'https://app.example.com/oauth',
            },
        }
        expect(UpsertPlatformOAuth2Request.parse(platformBody)).toBeDefined()
    })
})

describe('UpsertGlobalConnectionRequestBody schema', () => {
    it('validates global platform connection omitting projectId and externalId', () => {
        const body = {
            displayName: 'Global OpenAI',
            pieceName: '@inboxfm-connect/piece-openai',
            scope: AppConnectionScope.PLATFORM,
            projectIds: ['p1', 'p2'],
            type: AppConnectionType.SECRET_TEXT,
            value: {
                type: AppConnectionType.SECRET_TEXT,
                secret_text: 'sk-global-token',
            },
        }
        const parsed = UpsertGlobalConnectionRequestBody.parse(body)
        expect(parsed.scope).toBe(AppConnectionScope.PLATFORM)
        expect(parsed.projectIds).toEqual(['p1', 'p2'])
    })
})

describe('OAuth2 Authorization URL schemas', () => {
    it('validates GetOAuth2AuthorizationUrlRequestBody and response', () => {
        const request = {
            pieceName: 'slack',
            clientId: 'cid-123',
            redirectUrl: 'https://callback.com',
            scopes: ['chat:write', 'channels:read'],
        }
        const parsedReq = GetOAuth2AuthorizationUrlRequestBody.parse(request)
        expect(parsedReq.scopes).toEqual(['chat:write', 'channels:read'])

        const response = {
            authorizationUrl: 'https://slack.com/oauth/v2/authorize?client_id=cid-123',
            codeVerifier: 'verifier-random-string',
        }
        const parsedRes = GetOAuth2AuthorizationUrlResponse.parse(response)
        expect(parsedRes.codeVerifier).toBe('verifier-random-string')
    })
})

describe('ReplaceAppConnectionsRequestBody defaults', () => {
    it('applies default false to deleteSourceConnection and applyToPublishedVersions', () => {
        const body = {
            sourceAppConnectionId: 'src-1',
            targetAppConnectionId: 'tgt-2',
            projectId: 'proj-1',
        }
        const parsed = ReplaceAppConnectionsRequestBody.parse(body)
        expect(parsed.deleteSourceConnection).toBe(false)
        expect(parsed.applyToPublishedVersions).toBe(false)
    })

    it('respects explicitly provided booleans', () => {
        const body = {
            sourceAppConnectionId: 'src-1',
            targetAppConnectionId: 'tgt-2',
            projectId: 'proj-1',
            deleteSourceConnection: true,
            applyToPublishedVersions: true,
        }
        const parsed = ReplaceAppConnectionsRequestBody.parse(body)
        expect(parsed.deleteSourceConnection).toBe(true)
        expect(parsed.applyToPublishedVersions).toBe(true)
    })
})

describe('Constants and Enum validation', () => {
    it('exposes BOTH_CLIENT_CREDENTIALS_AND_AUTHORIZATION_CODE and PLACEHOLDER_CONNECTION_TYPE', () => {
        expect(BOTH_CLIENT_CREDENTIALS_AND_AUTHORIZATION_CODE).toBe('both_client_credentials_and_authorization_code')
        expect(PLACEHOLDER_CONNECTION_TYPE).toBe('PLACEHOLDER')
    })
})
