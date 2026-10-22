import { describe, expect, it } from 'vitest'
import {
    ChatFormResponse,
    createKeyForFormInput,
    FileResponseInterface,
    HumanInputFormResult,
    HumanInputFormResultTypes,
} from '../../../src/lib/automation/forms'

describe('Forms Model & Helpers', () => {
    describe('createKeyForFormInput', () => {
        it('converts multi-word display name to camelCase key', () => {
            expect(createKeyForFormInput('First Name')).toBe('firstName')
            expect(createKeyForFormInput('User Email Address')).toBe('userEmailAddress')
        })

        it('handles single-word inputs properly', () => {
            expect(createKeyForFormInput('Message')).toBe('message')
            expect(createKeyForFormInput('description')).toBe('description')
        })

        it('strips quotes, backslashes, tabs, and newlines', () => {
            expect(createKeyForFormInput('User\'s "Special" Field')).toBe('users specialField')
            expect(createKeyForFormInput('Quote"Word"')).toBe('quoteword')
            expect(createKeyForFormInput('Backslash\\Tab\tNewline\nTest')).toBe('backslashtabNewlineTest')
        })
    })

    describe('FileResponseInterface', () => {
        it('validates V1 format with base64Url and fileName', () => {
            const v1 = {
                base64Url: 'data:text/plain;base64,aGVsbG8=',
                fileName: 'notes.txt',
                extension: 'txt',
            }
            expect(FileResponseInterface.parse(v1)).toEqual(v1)
        })

        it('validates V2 format with mimeType and url', () => {
            const v2 = {
                mimeType: 'application/pdf',
                url: 'https://example.com/files/doc.pdf',
                fileName: 'doc.pdf',
            }
            expect(FileResponseInterface.parse(v2)).toEqual(v2)
        })

        it('rejects objects missing both V1 and V2 required properties', () => {
            expect(() => FileResponseInterface.parse({
                fileName: 'orphan.txt',
            })).toThrow()
        })
    })

    describe('HumanInputFormResult', () => {
        it('validates FILE result type', () => {
            const fileResult = {
                type: HumanInputFormResultTypes.FILE,
                value: {
                    mimeType: 'image/png',
                    url: 'https://cdn.example.com/img.png',
                },
            }
            expect(HumanInputFormResult.parse(fileResult)).toEqual(fileResult)
        })

        it('validates MARKDOWN result type with optional files', () => {
            const mdResult = {
                type: HumanInputFormResultTypes.MARKDOWN,
                value: '### Title\n\nSubmitted text content',
                files: [
                    {
                        mimeType: 'text/csv',
                        url: 'https://cdn.example.com/data.csv',
                    },
                ],
            }
            expect(HumanInputFormResult.parse(mdResult)).toEqual(mdResult)
        })
    })

    describe('ChatFormResponse', () => {
        it('validates chat form submission', () => {
            const chatResponse = {
                sessionId: 'sess_123',
                message: 'Can you summarize this invoice?',
                files: ['file_id_1', 'file_id_2'],
            }
            expect(ChatFormResponse.parse(chatResponse)).toEqual(chatResponse)
        })

        it('allows files property to be omitted', () => {
            const minimal = {
                sessionId: 'sess_456',
                message: 'Hello assistant',
            }
            expect(ChatFormResponse.parse(minimal)).toEqual(minimal)
        })
    })
})
