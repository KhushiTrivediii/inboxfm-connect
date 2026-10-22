import { describe, expect, it } from 'vitest'
import {
    KeyAlgorithm,
    SigningKey,
} from '../../../src/lib/ee/signing-key/signing-key-model'
import {
    AddSigningKeyRequestBody,
} from '../../../src/lib/ee/signing-key/signing-key.request'
import { AddSigningKeyResponse } from '../../../src/lib/ee/signing-key/signing-key-response'
import { OtpType } from '../../../src/lib/ee/otp/otp-type'
import { CreateOtpRequestBody } from '../../../src/lib/ee/otp/otp-requests'
import {
    ListOAuth2AppRequest,
    OAuthApp,
    UpsertOAuth2AppRequest,
} from '../../../src/lib/ee/oauth-apps/oauth-app'

describe('SigningKey models and KeyAlgorithm enum', () => {
    it('defines KeyAlgorithm.RSA as RSA', () => {
        expect(KeyAlgorithm.RSA).toBe('RSA')
    })

    it('parses valid SigningKey model', () => {
        const key = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            platformId: '123456789012345678902',
            publicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...\n-----END PUBLIC KEY-----',
            displayName: 'Default JWT Signing Key',
            algorithm: KeyAlgorithm.RSA,
        }
        const parsed = SigningKey.parse(key)
        expect(parsed.displayName).toBe('Default JWT Signing Key')
        expect(parsed.algorithm).toBe(KeyAlgorithm.RSA)
    })

    it('validates AddSigningKeyRequestBody schema', () => {
        const body = { displayName: 'Rotated Key 2026' }
        const parsed = AddSigningKeyRequestBody.parse(body)
        expect(parsed.displayName).toBe('Rotated Key 2026')
    })

    it('conforms to AddSigningKeyResponse type including privateKey', () => {
        const res: AddSigningKeyResponse = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            platformId: '123456789012345678902',
            publicKey: 'pubkey',
            privateKey: 'privkey',
            displayName: 'Key with Private Material',
            algorithm: KeyAlgorithm.RSA,
        }
        expect(res.privateKey).toBe('privkey')
    })
})

describe('OtpType enum and CreateOtpRequestBody', () => {
    it('defines EMAIL_VERIFICATION and PASSWORD_RESET otp types', () => {
        expect(OtpType.EMAIL_VERIFICATION).toBe('EMAIL_VERIFICATION')
        expect(OtpType.PASSWORD_RESET).toBe('PASSWORD_RESET')
    })

    it('parses CreateOtpRequestBody with valid types', () => {
        const verifyReq = {
            email: 'user@example.com',
            type: OtpType.EMAIL_VERIFICATION,
        }
        expect(CreateOtpRequestBody.parse(verifyReq).type).toBe(OtpType.EMAIL_VERIFICATION)

        const resetReq = {
            email: 'user@example.com',
            type: OtpType.PASSWORD_RESET,
        }
        expect(CreateOtpRequestBody.parse(resetReq).type).toBe(OtpType.PASSWORD_RESET)
    })

    it('rejects invalid OTP type', () => {
        expect(() => CreateOtpRequestBody.parse({
            email: 'user@example.com',
            type: 'PHONE_VERIFICATION',
        })).toThrow()
    })
})

describe('OAuthApp models and request schemas', () => {
    const validOAuthApp = {
        id: '123456789012345678901',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        pieceName: '@inboxfm-connect/piece-google',
        platformId: 'plat-1',
        clientId: 'google-client-id-123',
    }

    it('parses OAuthApp model', () => {
        const parsed = OAuthApp.parse(validOAuthApp)
        expect(parsed.pieceName).toBe('@inboxfm-connect/piece-google')
        expect(parsed.clientId).toBe('google-client-id-123')
    })

    it('parses UpsertOAuth2AppRequest containing clientSecret', () => {
        const upsert = {
            pieceName: '@inboxfm-connect/piece-github',
            clientId: 'gh-cid',
            clientSecret: 'gh-secret-token',
        }
        const parsed = UpsertOAuth2AppRequest.parse(upsert)
        expect(parsed.clientSecret).toBe('gh-secret-token')
    })

    it('parses ListOAuth2AppRequest and coerces limit to number', () => {
        const listReq = {
            limit: '50',
            cursor: 'cur_page_2',
        }
        const parsed = ListOAuth2AppRequest.parse(listReq)
        expect(parsed.limit).toBe(50)
        expect(parsed.cursor).toBe('cur_page_2')
    })
})
