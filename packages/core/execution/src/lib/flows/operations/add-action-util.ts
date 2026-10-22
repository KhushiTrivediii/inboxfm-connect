import dayjs from 'dayjs'
import { applyFunctionToValuesSync, extractMustacheTokens, isString } from '@inboxfm-connect/core-utils'
import { FlowAction } from '../actions/action'
import { FlowVersion } from '../flow-version'
import { flowStructureUtil } from '../util/flow-structure-util'

function mapToNewNames(flowVersion: FlowVersion, clonedActions: FlowAction[]): Record<string, string> {
    const existingNames = flowStructureUtil.getAllSteps(flowVersion.trigger)
        .map(step => step.name)

    const oldStepNames = clonedActions.flatMap(clonedAction => flowStructureUtil.getAllSteps(clonedAction).map(step => step.name))

    return oldStepNames.reduce((nameMap, oldName) => {
        const newName = flowStructureUtil.findUnusedName(existingNames)
        existingNames.push(newName)
        return { ...nameMap, [oldName]: newName }
    }, {} as Record<string, string>)
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces occurrences of `oldStepName` with `newStepName` inside mustache expressions `{{ ... }}` in `input`.
 */
function replaceOldStepNameWithNewOne({
    input,
    oldStepName,
    newStepName,
}: ReplaceOldStepNameWithNewOneProps): string {
    const tokens = extractMustacheTokens(input)
    if (tokens.length === 0) {
        return input
    }
    const escapedOldName = escapeRegex(oldStepName)
    const stepRegex = new RegExp(`\\b${escapedOldName}\\b`, 'g')

    let result = ''
    let lastIndex = 0

    for (const token of tokens) {
        result += input.slice(lastIndex, token.index)
        const replacedInner = token.inner.replaceAll(stepRegex, () => newStepName)
        result += `{{${replacedInner}}}`
        lastIndex = token.index + token.token.length
    }

    result += input.slice(lastIndex)
    return result
}

function clone(step: FlowAction, oldNameToNewName: Record<string, string>): FlowAction {
    step.displayName = `${step.displayName} Copy`
    step.name = oldNameToNewName[step.name]
    if ('input' in step.settings) {
        Object.keys(oldNameToNewName).forEach((oldName) => {
            const settings = step.settings as { input: unknown }
            settings.input = applyFunctionToValuesSync(
                settings.input,
                (value: unknown) => {
                    if (isString(value)) {
                        return replaceOldStepNameWithNewOne({
                            input: value,
                            oldStepName: oldName,
                            newStepName: oldNameToNewName[oldName],
                        })
                    }
                    return value
                },
            )
        })
    }
    if (step.settings.sampleData) {
        step.settings = {
            ...step.settings,
            sampleData: {},
        }
    }
    step.lastUpdatedDate = dayjs().toISOString()
    return step
}

export const addActionUtils = {
    mapToNewNames,
    clone,
    replaceOldStepNameWithNewOne,
}

type ReplaceOldStepNameWithNewOneProps = {
    input: string
    oldStepName: string
    newStepName: string
}
