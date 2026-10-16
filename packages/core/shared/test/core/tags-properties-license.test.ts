import { describe, it, expect } from 'vitest'
import {
    Tag,
    PieceTag,
    ListTagsRequest,
    SetPieceTagsRequest,
    UpsertTagRequest,
    DeleteTagRequest,
} from '../../src/lib/core/tag'
import { MarkdownVariant } from '../../src/lib/core/property/markdown'
import { supportUrl } from '../../src/lib/core/support-url'
import { feedbackUrl } from '../../src/lib/core/feedback-url'
import {
    VerifyLicenseKeyRequestBody,
    LicenseKeyEntity,
    CreateTrialLicenseKeyRequestBody,
} from '../../src/lib/core/license-keys'

describe('Tags, Properties, and License Keys contracts', () => {
    describe('Tag schemas', () => {
        const baseTag = {
            id: 'tag_1',
            created: '2026-10-01T00:00:00.000Z',
            updated: '2026-10-01T00:00:00.000Z',
            platformId: 'plat_123',
            name: 'Utilities',
        }

        it('should validate a valid Tag object', () => {
            const parsed = Tag.safeParse(baseTag)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.name).toBe('Utilities')
                expect(parsed.data.platformId).toBe('plat_123')
            }
        })

        it('should reject a Tag with missing required fields', () => {
            const missingName = { ...baseTag, name: undefined }
            expect(Tag.safeParse(missingName).success).toBe(false)
        })

        it('should validate PieceTag association', () => {
            const validPieceTag = {
                id: 'ptag_1',
                created: '2026-10-01T00:00:00.000Z',
                updated: '2026-10-01T00:00:00.000Z',
                pieceName: '@inboxfm-connect/piece-gmail',
                tagId: 'tag_1',
                platformId: 'plat_123',
            }
            const parsed = PieceTag.safeParse(validPieceTag)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.pieceName).toBe('@inboxfm-connect/piece-gmail')
                expect(parsed.data.tagId).toBe('tag_1')
            }
        })

        it('should validate and coerce ListTagsRequest parameters', () => {
            const requestWithCoercion = {
                limit: '25',
                cursor: 'cur_abc',
            }
            const parsed = ListTagsRequest.safeParse(requestWithCoercion)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.limit).toBe(25)
                expect(parsed.data.cursor).toBe('cur_abc')
            }

            const emptyRequest = {}
            expect(ListTagsRequest.safeParse(emptyRequest).success).toBe(true)
        })

        it('should validate SetPieceTagsRequest', () => {
            const valid = {
                piecesName: ['@inboxfm-connect/piece-slack', '@inboxfm-connect/piece-discord'],
                tags: ['communication', 'chat'],
            }
            const parsed = SetPieceTagsRequest.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.piecesName).toHaveLength(2)
                expect(parsed.data.tags).toContain('chat')
            }

            const invalid = {
                piecesName: 'not-an-array',
                tags: ['communication'],
            }
            expect(SetPieceTagsRequest.safeParse(invalid).success).toBe(false)
        })

        it('should validate UpsertTagRequest and DeleteTagRequest', () => {
            expect(UpsertTagRequest.safeParse({ name: 'Finance' }).success).toBe(true)
            expect(UpsertTagRequest.safeParse({}).success).toBe(false)

            expect(DeleteTagRequest.safeParse({ id: 'tag_999' }).success).toBe(true)
            expect(DeleteTagRequest.safeParse({}).success).toBe(false)
        })
    })

    describe('MarkdownVariant and URL contracts', () => {
        it('should export all expected markdown variant constants', () => {
            expect(MarkdownVariant.BORDERLESS).toBe('BORDERLESS')
            expect(MarkdownVariant.INFO).toBe('INFO')
            expect(MarkdownVariant.WARNING).toBe('WARNING')
            expect(MarkdownVariant.TIP).toBe('TIP')
        })

        it('should expose valid default support and feedback URLs', () => {
            expect(supportUrl).toBe('https://community.activepieces.com')
            expect(feedbackUrl).toBe('https://feedback.activepieces.com')
        })
    })

    describe('License Keys contracts', () => {
        it('should validate VerifyLicenseKeyRequestBody', () => {
            const valid = {
                licenseKey: 'lic_xyz123',
                platformId: 'plat_456',
            }
            expect(VerifyLicenseKeyRequestBody.safeParse(valid).success).toBe(true)
            expect(VerifyLicenseKeyRequestBody.safeParse({ licenseKey: 'lic_xyz123' }).success).toBe(false)
        })

        it('should validate complete LicenseKeyEntity', () => {
            const license = {
                id: 'lic_1',
                email: 'admin@company.com',
                expiresAt: '2027-01-01T00:00:00.000Z',
                activatedAt: '2026-01-01T00:00:00.000Z',
                createdAt: '2026-01-01T00:00:00.000Z',
                key: 'license-secret-key-abc',
                ssoEnabled: true,
                scimEnabled: true,
                environmentsEnabled: true,
                showPoweredBy: false,
                embeddingEnabled: true,
                auditLogEnabled: true,
                customAppearanceEnabled: true,
                manageProjectsEnabled: true,
                managePiecesEnabled: true,
                manageTemplatesEnabled: true,
                apiKeysEnabled: true,
                projectRolesEnabled: true,
                analyticsEnabled: true,
                globalConnectionsEnabled: true,
                customRolesEnabled: true,
                eventStreamingEnabled: true,
                secretManagersEnabled: true,
                agentsEnabled: true,
                aiProvidersEnabled: true,
                chatEnabled: true,
                workerGroupsEnabled: false,
            }
            const parsed = LicenseKeyEntity.safeParse(license)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.scimEnabled).toBe(true)
                expect(parsed.data.chatEnabled).toBe(true)
            }
        })

        it('should validate CreateTrialLicenseKeyRequestBody omitting entity id and key', () => {
            const trialRequest = {
                email: 'trial@example.com',
                companyName: 'Acme Corp',
                goal: 'Evaluate automation platform',
                keyType: 'enterprise-trial',
                ssoEnabled: true,
                scimEnabled: false,
                environmentsEnabled: true,
                showPoweredBy: true,
                embeddingEnabled: false,
                auditLogEnabled: false,
                customAppearanceEnabled: false,
                manageProjectsEnabled: true,
                managePiecesEnabled: true,
                manageTemplatesEnabled: true,
                apiKeysEnabled: true,
                projectRolesEnabled: true,
                analyticsEnabled: false,
                globalConnectionsEnabled: false,
                customRolesEnabled: false,
                eventStreamingEnabled: false,
                secretManagersEnabled: false,
                agentsEnabled: false,
                aiProvidersEnabled: false,
            }
            const parsed = CreateTrialLicenseKeyRequestBody.safeParse(trialRequest)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.companyName).toBe('Acme Corp')
                expect(parsed.data.keyType).toBe('enterprise-trial')
            }
        })
    })
})
