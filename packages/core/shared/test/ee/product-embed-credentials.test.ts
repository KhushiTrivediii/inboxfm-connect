import { describe, it, expect } from 'vitest'
import {
    ConnectionKeyType,
    GetOrDeleteConnectionFromTokenRequest,
    ListConnectionKeysRequest,
    UpsertApiKeyConnectionFromToken,
    UpsertOAuth2ConnectionFromToken,
    UpsertConnectionFromToken,
    UpsertSigningKeyConnection,
} from '../../src/lib/ee/product-embed/connection-keys'
import {
    AppCredentialType,
    ListAppCredentialsRequest,
    UpsertApiKeyCredentialRequest,
    UpsertOAuth2CredentialRequest,
    UpsertAppCredentialRequest,
} from '../../src/lib/ee/product-embed/app-credentials'

describe('Product-Embed Connection Keys and Credentials contracts', () => {
    describe('Connection Keys and Token Requests', () => {
        it('should validate ConnectionKeyType enum', () => {
            expect(ConnectionKeyType.SIGNING_KEY).toBe('SIGNING_KEY')
        })

        it('should validate GetOrDeleteConnectionFromTokenRequest', () => {
            const valid = {
                projectId: 'proj_123',
                token: 'jwt_signed_token_xyz',
                appName: 'slack',
            }
            const parsed = GetOrDeleteConnectionFromTokenRequest.safeParse(valid)
            expect(parsed.success).toBe(true)

            const missing = { projectId: 'proj_123', token: 'jwt_token' }
            expect(GetOrDeleteConnectionFromTokenRequest.safeParse(missing).success).toBe(false)
        })

        it('should validate ListConnectionKeysRequest with pagination coercion', () => {
            const valid = {
                projectId: 'proj_123',
                limit: '20',
                cursor: 'cursor_abc',
            }
            const parsed = ListConnectionKeysRequest.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.limit).toBe(20)
                expect(parsed.data.projectId).toBe('proj_123')
            }
        })

        it('should validate UpsertApiKeyConnectionFromToken schema', () => {
            const valid = {
                appCredentialId: 'cred_1',
                apiKey: 'sk_live_123456789',
                token: 'embed_token_abc',
            }
            expect(UpsertApiKeyConnectionFromToken.safeParse(valid).success).toBe(true)
            expect(UpsertApiKeyConnectionFromToken.safeParse({ apiKey: 'sk_live' }).success).toBe(false)
        })

        it('should validate UpsertOAuth2ConnectionFromToken schema', () => {
            const valid = {
                appCredentialId: 'cred_2',
                props: { subDomain: 'my-org' },
                token: 'embed_token_xyz',
                code: 'auth_code_oauth',
                redirectUrl: 'https://cloud.activepieces.com/redirect',
            }
            const parsed = UpsertOAuth2ConnectionFromToken.safeParse(valid)
            expect(parsed.success).toBe(true)
        })

        it('should validate UpsertConnectionFromToken union resolving either API_KEY or OAuth2', () => {
            const apiKeyPayload = {
                appCredentialId: 'cred_1',
                apiKey: 'sk_live_123',
                token: 'token_1',
            }
            const oauthPayload = {
                appCredentialId: 'cred_2',
                props: {},
                token: 'token_2',
                code: 'code_2',
                redirectUrl: 'https://example.com/oauth',
            }

            expect(UpsertConnectionFromToken.safeParse(apiKeyPayload).success).toBe(true)
            expect(UpsertConnectionFromToken.safeParse(oauthPayload).success).toBe(true)
            expect(UpsertConnectionFromToken.safeParse({ invalid: 'payload' }).success).toBe(false)
        })

        it('should validate UpsertSigningKeyConnection with explicit SIGNING_KEY type', () => {
            const valid = {
                projectId: 'proj_999',
                settings: {
                    type: ConnectionKeyType.SIGNING_KEY,
                },
            }
            expect(UpsertSigningKeyConnection.safeParse(valid).success).toBe(true)

            const invalid = {
                projectId: 'proj_999',
                settings: {
                    type: 'RSA_KEY',
                },
            }
            expect(UpsertSigningKeyConnection.safeParse(invalid).success).toBe(false)
        })
    })

    describe('App Credentials contracts', () => {
        it('should validate AppCredentialType enum values', () => {
            expect(AppCredentialType.API_KEY).toBe('API_KEY')
            expect(AppCredentialType.OAUTH2).toBe('OAUTH2')
        })

        it('should validate ListAppCredentialsRequest', () => {
            const valid = {
                projectId: 'proj_123',
                appName: 'google-sheets',
                limit: '50',
            }
            const parsed = ListAppCredentialsRequest.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.limit).toBe(50)
                expect(parsed.data.appName).toBe('google-sheets')
            }
        })

        it('should validate UpsertApiKeyCredentialRequest', () => {
            const valid = {
                appName: 'mailchimp',
                projectId: 'proj_123',
                settings: {
                    type: AppCredentialType.API_KEY,
                },
            }
            expect(UpsertApiKeyCredentialRequest.safeParse(valid).success).toBe(true)
        })

        it('should validate UpsertOAuth2CredentialRequest', () => {
            const valid = {
                appName: 'hubspot',
                projectId: 'proj_123',
                settings: {
                    type: AppCredentialType.OAUTH2,
                    authUrl: 'https://app.hubspot.com/oauth/authorize',
                    tokenUrl: 'https://api.hubspot.com/oauth/v1/token',
                    scope: 'contacts crm.objects.deals.read',
                    clientId: 'hubspot-client-id',
                    clientSecret: 'hubspot-client-secret',
                },
            }
            expect(UpsertOAuth2CredentialRequest.safeParse(valid).success).toBe(true)

            const missingField = {
                ...valid,
                settings: {
                    type: AppCredentialType.OAUTH2,
                    authUrl: 'https://app.hubspot.com/oauth/authorize',
                },
            }
            expect(UpsertOAuth2CredentialRequest.safeParse(missingField).success).toBe(false)
        })

        it('should validate UpsertAppCredentialRequest union', () => {
            const apiKeyPayload = {
                appName: 'sendgrid',
                projectId: 'proj_abc',
                settings: { type: AppCredentialType.API_KEY },
            }
            expect(UpsertAppCredentialRequest.safeParse(apiKeyPayload).success).toBe(true)
        })
    })
})
