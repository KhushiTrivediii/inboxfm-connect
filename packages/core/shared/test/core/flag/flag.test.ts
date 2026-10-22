import { describe, expect, it } from 'vitest'
import {
    ApEdition,
    ApEnvironment,
    ApFlagId,
    Flag,
} from '../../../src/lib/core/flag/flag'
import {
    UpdateTemplatesCategoriesFlagRequestBody,
} from '../../../src/lib/core/flag/flag.requests'

describe('ApEnvironment and ApEdition enums', () => {
    it('defines standard runtime environments', () => {
        expect(ApEnvironment.PRODUCTION).toBe('prod')
        expect(ApEnvironment.DEVELOPMENT).toBe('dev')
        expect(ApEnvironment.TESTING).toBe('test')
    })

    it('defines software editions (ce, ee, cloud)', () => {
        expect(ApEdition.COMMUNITY).toBe('ce')
        expect(ApEdition.ENTERPRISE).toBe('ee')
        expect(ApEdition.CLOUD).toBe('cloud')
    })
})

describe('ApFlagId constants', () => {
    it('exposes critical system flag IDs', () => {
        const flagIds = Object.values(ApFlagId)
        expect(flagIds).toContain(ApFlagId.CURRENT_VERSION)
        expect(flagIds).toContain(ApFlagId.EDITION)
        expect(flagIds).toContain(ApFlagId.ENVIRONMENT)
        expect(flagIds).toContain(ApFlagId.TELEMETRY_ENABLED)
        expect(flagIds).toContain(ApFlagId.CLOUD_AUTH_ENABLED)
        expect(flagIds).toContain(ApFlagId.EMAIL_AUTH_ENABLED)
        expect(flagIds).toContain(ApFlagId.WEBHOOK_URL_PREFIX)
        expect(flagIds).toContain(ApFlagId.ALLOW_NPM_PACKAGES_IN_CODE_STEP)
        expect(flagIds).toContain(ApFlagId.SHOW_POWERED_BY_IN_FORM)
        expect(flagIds.length).toBeGreaterThanOrEqual(40)
    })
})

describe('Flag model and UpdateTemplatesCategoriesFlagRequestBody', () => {
    it('constructs a conforming Flag object', () => {
        const flag: Flag = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            value: '0.127.0',
        }
        expect(flag.id).toBe('123456789012345678901')
        expect(flag.value).toBe('0.127.0')
    })

    it('validates UpdateTemplatesCategoriesFlagRequestBody schema', () => {
        const body = { value: ['Productivity', 'Marketing', 'CRM'] }
        const parsed = UpdateTemplatesCategoriesFlagRequestBody.parse(body)
        expect(parsed.value).toEqual(['Productivity', 'Marketing', 'CRM'])
    })

    it('rejects non-array value in UpdateTemplatesCategoriesFlagRequestBody', () => {
        expect(() => UpdateTemplatesCategoriesFlagRequestBody.parse({ value: 'Productivity' })).toThrow()
    })
})
