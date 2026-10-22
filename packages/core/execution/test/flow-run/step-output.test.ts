import { describe, expect, it } from 'vitest'
import { FlowActionType } from '../../src/lib/flows/actions/action'
import { FlowTriggerType } from '../../src/lib/flows/triggers/trigger'
import { GenericStepOutput, LoopStepOutput, RouterStepOutput, StepOutputStatus, StepOutputType } from '../../src/lib/flow-run/execution/step-output'

describe('step-output classes and immutable state methods (Issue #141)', () => {
    describe('GenericStepOutput', () => {
        it('instantiates and creates new instances immutably via builder methods', () => {
            const initial = GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.RUNNING,
                input: { action: 'test' },
            })

            expect(initial.status).toBe(StepOutputStatus.RUNNING)
            expect(initial.output).toBeUndefined()

            const withOutput = initial.setOutput({ score: 100 })
            expect(withOutput).not.toBe(initial)
            expect(withOutput.output).toEqual({ score: 100 })
            expect(initial.output).toBeUndefined()

            const withStatus = withOutput.setStatus(StepOutputStatus.SUCCEEDED)
            expect(withStatus.status).toBe(StepOutputStatus.SUCCEEDED)
            expect(withOutput.status).toBe(StepOutputStatus.RUNNING)

            const withDuration = withStatus.setDuration(150)
            expect(withDuration.duration).toBe(150)

            const withError = withStatus.setErrorMessage('Some failure')
            expect(withError.errorMessage).toBe('Some failure')
        })

        it('supports slice outputType for large log payload references', () => {
            const step = new GenericStepOutput({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: {},
                outputType: StepOutputType.SLICE,
                output: { fileId: 'file-123', size: 2048, url: 'https://storage/log' },
            })

            expect(step.outputType).toBe(StepOutputType.SLICE)
            expect(step.output).toEqual({ fileId: 'file-123', size: 2048, url: 'https://storage/log' })
        })
    })

    describe('RouterStepOutput', () => {
        it('initializes router step output with SUCCEEDED status by default', () => {
            const router = RouterStepOutput.init({ input: { condition: true } })
            expect(router.type).toBe(FlowActionType.ROUTER)
            expect(router.status).toBe(StepOutputStatus.SUCCEEDED)
            expect(router.input).toEqual({ condition: true })
        })
    })

    describe('LoopStepOutput', () => {
        it('initializes loop step output with empty iterations', () => {
            const loop = LoopStepOutput.init({ input: ['a', 'b', 'c'] })
            expect(loop.type).toBe(FlowActionType.LOOP_ON_ITEMS)
            expect(loop.output?.iterations).toEqual([])
            expect(loop.output?.index).toBe(0)
            expect(loop.hasIteration(0)).toBe(false)
        })

        it('immutably sets item and index and adds iterations', () => {
            const loop0 = LoopStepOutput.init({ input: ['first', 'second'] })
            const loop1 = loop0.setItemAndIndex({ item: 'first', index: 0 }).addIteration()

            expect(loop1.output?.item).toBe('first')
            expect(loop1.output?.index).toBe(0)
            expect(loop1.output?.iterations).toHaveLength(1)
            expect(loop1.hasIteration(0)).toBe(true)
            expect(loop1.hasIteration(1)).toBe(false)

            const loop2 = loop1.setItemAndIndex({ item: 'second', index: 1 }).addIteration()
            expect(loop2.output?.iterations).toHaveLength(2)
            expect(loop2.output?.item).toBe('second')
            expect(loop2.output?.index).toBe(1)
            expect(loop2.hasIteration(1)).toBe(true)
        })
    })
})
