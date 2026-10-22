import { describe, expect, it } from 'vitest'
import { createActionCommand } from '../../../src/lib/commands/create-action'
import { createPieceCommand } from '../../../src/lib/commands/create-piece'
import { createTriggerCommand } from '../../../src/lib/commands/create-trigger'
import {
    displayNameToCamelCase,
    displayNameToKebabCase,
    removeStartingSlashes,
} from '../../../src/lib/utils/piece-utils'

describe('Piece CLI Commands & String Utils (Issue #139)', () => {
    describe('Command Definitions', () => {
        it('registers create-piece command properly', () => {
            expect(createPieceCommand.name()).toBe('create')
            expect(createPieceCommand.description()).toContain('Create a new piece')
        })

        it('registers create-action command properly', () => {
            expect(createActionCommand.name()).toBe('create')
            expect(createActionCommand.description()).toContain('Create a new action')
        })

        it('registers create-trigger command properly', () => {
            expect(createTriggerCommand.name()).toBe('create')
            expect(createTriggerCommand.description()).toContain('Create a new trigger')
        })
    })

    describe('Naming Validation & Transformation Utilities', () => {
        it('transforms display names to camelCase correctly for code exports', () => {
            expect(displayNameToCamelCase('Send Email')).toBe('sendEmail')
            expect(displayNameToCamelCase('create customer invoice')).toBe('createCustomerInvoice')
            expect(displayNameToCamelCase('GET_ALL_RECORDS')).toBe('get_all_records')
            expect(displayNameToCamelCase('SingleWord')).toBe('singleword')
        })

        it('transforms display names to kebab-case correctly for filenames', () => {
            expect(displayNameToKebabCase('Send Email')).toBe('send-email')
            expect(displayNameToKebabCase('Create New Record')).toBe('create-new-record')
            expect(displayNameToKebabCase('simple')).toBe('simple')
        })

        it('removes leading slashes cleanly from relative paths', () => {
            expect(removeStartingSlashes('/packages/pieces/slack')).toBe('packages/pieces/slack')
            expect(removeStartingSlashes('packages/pieces/slack')).toBe('packages/pieces/slack')
        })

        it('validates piece name pattern against specifications', () => {
            const pieceNamePattern = /^(?![._])[a-z0-9-]{1,214}$/

            expect(pieceNamePattern.test('slack')).toBe(true)
            expect(pieceNamePattern.test('google-sheets')).toBe(true)
            expect(pieceNamePattern.test('hubspot-crm-v2')).toBe(true)

            expect(pieceNamePattern.test('_invalid')).toBe(false)
            expect(pieceNamePattern.test('.invalid')).toBe(false)
            expect(pieceNamePattern.test('InvalidCamelCase')).toBe(false)
            expect(pieceNamePattern.test('invalid_underscore')).toBe(false)
            expect(pieceNamePattern.test('invalid piece')).toBe(false)
        })

        it('validates npm package name pattern against specifications', () => {
            const packageNamePattern = /^(?:@[a-zA-Z0-9-]+\/)?[a-zA-Z0-9-]+$/

            expect(packageNamePattern.test('@inboxfm-connect/piece-slack')).toBe(true)
            expect(packageNamePattern.test('custom-piece-mycorp')).toBe(true)

            expect(packageNamePattern.test('bad/package/name')).toBe(false)
            expect(packageNamePattern.test('@bad/nested/package')).toBe(false)
        })
    })
})
