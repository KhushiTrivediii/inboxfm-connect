import { describe, expect, it } from 'vitest'
import { FlowActionType, PieceAction } from '../../../src/lib/flows/actions/action'
import { addActionUtils } from '../../../src/lib/flows/operations/add-action-util'

describe('addActionUtils.replaceOldStepNameWithNewOne (Issue #167)', () => {
    it('renames simple step references inside {{ }}', () => {
        const input = '{{ step_1.output.id }} and {{ step_1.output.name }}'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(result).toBe('{{ step_2.output.id }} and {{ step_2.output.name }}')
    })

    it('correctly renames step references when expression contains nested braces or string literals with }}', () => {
        const input = "{{ steps.step_1.output + '}}' + steps.step_1.value }}"
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(result).toBe("{{ steps.step_2.output + '}}' + steps.step_2.value }}")
    })

    it('correctly handles object literals with nested braces inside {{ }}', () => {
        const input = '{{ { key: steps.step_1.val, suffix: "}}" } }}'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(result).toBe('{{ { key: steps.step_2.val, suffix: "}}" } }}')
    })

    it('renames step references inside expressions with backtick template literals containing }}', () => {
        const input = '{{ `a}}b` + steps.step_1.x }}'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(result).toBe('{{ `a}}b` + steps.step_2.x }}')
    })

    it('renames step references in expressions with escaped quotes inside string literals', () => {
        const inputSingle = "{{ steps['It\\'s'].x + steps.step_1.x }}"
        const resultSingle = addActionUtils.replaceOldStepNameWithNewOne({
            input: inputSingle,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(resultSingle).toBe("{{ steps['It\\'s'].x + steps.step_2.x }}")

        const inputDouble = '{{ steps["a\\"b"].x + steps.step_1.x }}'
        const resultDouble = addActionUtils.replaceOldStepNameWithNewOne({
            input: inputDouble,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(resultDouble).toBe('{{ steps["a\\"b"].x + steps.step_2.x }}')
    })

    it('escapes regex special characters in step names without crashing or corrupting matches', () => {
        const input = '{{ step$1.output }}'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step$1',
            newStepName: 'step$2',
        })
        expect(result).toBe('{{ step$2.output }}')
    })

    it('treats dollar patterns in newStepName literally without regex interpolation ($&, $`, $\', $$)', () => {
        const input = '{{ step_1.output }}'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step$&_$`_$1_$$',
        })
        expect(result).toBe('{{ step$&_$`_$1_$$.output }}')
    })

    it('respects word boundaries so step_10 is not renamed when replacing step_1', () => {
        const input = '{{ step_10.output + step_1.output }}'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(result).toBe('{{ step_10.output + step_2.output }}')
    })

    it('returns original input unchanged when token is unterminated (failure path)', () => {
        const input = '{{ steps.step_1.output'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(result).toBe(input)
    })

    it('returns original input unchanged when no mustache tokens are present', () => {
        const input = 'plain string without any tokens step_1'
        const result = addActionUtils.replaceOldStepNameWithNewOne({
            input,
            oldStepName: 'step_1',
            newStepName: 'step_2',
        })
        expect(result).toBe('plain string without any tokens step_1')
    })

    it('properly clones a step and rewrites nested mustache expressions in its inputs', () => {
        const step: PieceAction = {
            name: 'step_1',
            displayName: 'HTTP Request',
            type: FlowActionType.PIECE,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                pieceName: '@inboxfm-connect/piece-http',
                pieceVersion: '1.0.0',
                propertySettings: {},
                input: {
                    url: 'https://example.com/api',
                    body: "{{ steps.step_1.output + '}}' }}",
                    nested: {
                        field: '{{ steps.step_1.data }}',
                    },
                },
            },
        }

        const cloned = addActionUtils.clone(step, { step_1: 'step_2' })
        expect(cloned.name).toBe('step_2')
        expect(cloned.displayName).toBe('HTTP Request Copy')
        if (cloned.type === FlowActionType.PIECE && cloned.settings.input && typeof cloned.settings.input === 'object') {
            const input = cloned.settings.input
            if ('body' in input && 'nested' in input && typeof input.nested === 'object' && input.nested && 'field' in input.nested) {
                expect(input.body).toBe("{{ steps.step_2.output + '}}' }}")
                expect(input.nested.field).toBe('{{ steps.step_2.data }}')
            }
        }
    })

    it('clones action and updates step references across complex nested input settings', () => {
        const action: PieceAction = {
            name: 'step_1',
            displayName: 'Send Message',
            type: FlowActionType.PIECE,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.1.0',
                propertySettings: {},
                input: {
                    text: 'From {{ step_1.author }} with {{ "}}" + step_1.signature }}',
                    nested: {
                        deep: '{{ step_1.id }}',
                    },
                },
            },
        }

        const cloned = addActionUtils.clone(action, { step_1: 'step_copy_1' })

        expect(cloned.name).toBe('step_copy_1')
        expect(cloned.displayName).toBe('Send Message Copy')
        if (cloned.type === FlowActionType.PIECE && cloned.settings.input && typeof cloned.settings.input === 'object') {
            const input = cloned.settings.input
            if ('text' in input && 'nested' in input && typeof input.nested === 'object' && input.nested && 'deep' in input.nested) {
                expect(input.text).toBe('From {{ step_copy_1.author }} with {{ "}}" + step_copy_1.signature }}')
                expect(input.nested.deep).toBe('{{ step_copy_1.id }}')
            }
        }
    })
})
