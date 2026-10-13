import { ActivepiecesError } from '@inboxfm-connect/core-utils'
import { TriggerBinding, TriggerBindingStatus, TriggerHookType } from '@inboxfm-connect/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeEngineHook, triggerBindingService } from '../../../../src/app/execution/trigger-binding/trigger-binding.service'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { userInteractionWatcher } from '../../../../src/app/helper/user-interaction/user-interaction-watcher'

const schedulerSpies = vi.hoisted(() => ({
    cron: vi.fn(),
    cancel: vi.fn(),
}))

const repositoryMock = vi.hoisted(() => ({
    findOneBy: vi.fn(),
    save: vi.fn(),
}))

vi.mock('@inboxfm-connect/scheduler', async (importOriginal) => {
    // Keep the real cron parser (the service validates expressions with it) but stub
    // the scheduler so the in-memory job registration is observable and side-effect free.
    const actual = await importOriginal<typeof import('@inboxfm-connect/scheduler')>()
    return {
        ...actual,
        scheduler: {
            cron: schedulerSpies.cron,
            cancel: schedulerSpies.cancel,
        },
    }
})

vi.mock('../../../../src/app/database/database-connection', () => ({
    databaseConnection: () => ({
        getRepository: () => repositoryMock,
    }),
}))


const createSampleBinding = (id = 'tb_test_webhook_123'): TriggerBinding => ({
    id,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    projectId: 'proj_sample_123',
    platformId: 'plat_sample_123',
    pieceName: '@inboxfm-connect/piece-slack',
    pieceVersion: '0.1.0',
    triggerName: 'new_message',
    connectionId: 'conn_sample_123',
    promptTemplate: 'Handle message {{item.text}}',
    settings: {},
    propertySettings: null,
    status: TriggerBindingStatus.ENABLED,
})

describe('TriggerBinding Domain & Safety Audit', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    describe('Forbidden Graph Fields Audit', () => {
        it('ensures TriggerBinding schema contains zero legacy workflow graph fields', () => {
            const keys = Object.keys(TriggerBinding.shape)
            const forbiddenKeys = [
                'flowId',
                'flowVersionId',
                'flowRunId',
                'stepName',
                'stepIndex',
                'nodeId',
                'routerPath',
                'loopIteration',
            ]

            for (const forbiddenKey of forbiddenKeys) {
                expect(keys).not.toContain(forbiddenKey)
            }
        })
    })

    describe('TriggerBinding Contract Validation', () => {
        it('parses valid TriggerBinding with ENABLED status', () => {
            const binding = {
                id: 'tb_12345678901234567',
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
                projectId: 'proj_12345678901234567',
                platformId: 'plat_12345678901234567',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.1.0',
                triggerName: 'new_message',
                connectionId: 'conn_12345678901234567',
                promptTemplate: 'Summarize the Slack message: {{item.text}}',
                settings: {
                    channel: 'C123456',
                },
                status: TriggerBindingStatus.ENABLED,
            }

            const parsed = TriggerBinding.parse(binding)
            expect(parsed.id).toBe('tb_12345678901234567')
            expect(parsed.status).toBe(TriggerBindingStatus.ENABLED)
            expect(parsed.promptTemplate).toContain('Summarize')
        })

        it('parses valid TriggerBinding with DISABLED status', () => {
            const binding = {
                id: 'tb_98765432109876543',
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
                projectId: 'proj_12345678901234567',
                platformId: 'plat_12345678901234567',
                pieceName: '@inboxfm-connect/piece-github',
                pieceVersion: '0.2.0',
                triggerName: 'new_issue',
                connectionId: null,
                promptTemplate: 'Handle new issue',
                settings: {
                    repo: 'inboxfm/connect',
                },
                status: TriggerBindingStatus.DISABLED,
            }

            const parsed = TriggerBinding.parse(binding)
            expect(parsed.status).toBe(TriggerBindingStatus.DISABLED)
            expect(parsed.connectionId).toBeNull()
        })
    })

    describe('Webhook URL Derivation (#159)', () => {
        it('derives webhookUrl pointing to /run without localhost literals via executeEngineHook', async () => {
            const watcherSpy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockImplementation(async () => ({ output: [] }))
            const binding = createSampleBinding()

            await executeEngineHook({
                binding,
                hookType: TriggerHookType.ON_ENABLE,
            })

            expect(watcherSpy).toHaveBeenCalledTimes(1)
            const passedJobData = watcherSpy.mock.calls[0][0]
            expect(typeof passedJobData.webhookUrl).toBe('string')
            const webhookUrl = String(passedJobData.webhookUrl)
            expect(webhookUrl).not.toContain('localhost:3000')
            expect(webhookUrl).toContain(`/api/v1/trigger-bindings/${binding.id}/run`)
            expect(webhookUrl.endsWith(`/api/v1/trigger-bindings/${binding.id}/run`)).toBe(true)
        })

        it('hands the exact same derived webhookUrl across ON_ENABLE, RUN, and RENEW hooks', async () => {
            const watcherSpy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockImplementation(async () => ({ output: [] }))
            const binding = createSampleBinding('tb_parity_check_456')

            await executeEngineHook({
                binding,
                hookType: TriggerHookType.ON_ENABLE,
            })
            await executeEngineHook({
                binding,
                hookType: TriggerHookType.RUN,
                triggerPayload: { event: 'ping' },
            })
            await executeEngineHook({
                binding,
                hookType: TriggerHookType.RENEW,
            })

            expect(watcherSpy).toHaveBeenCalledTimes(3)
            const onEnableJob = watcherSpy.mock.calls[0][0]
            const runJob = watcherSpy.mock.calls[1][0]
            const renewJob = watcherSpy.mock.calls[2][0]

            expect(typeof onEnableJob.webhookUrl).toBe('string')
            expect(String(onEnableJob.webhookUrl)).toContain(`/api/v1/trigger-bindings/${binding.id}/run`)
            expect(runJob.webhookUrl).toBe(onEnableJob.webhookUrl)
            expect(renewJob.webhookUrl).toBe(onEnableJob.webhookUrl)
        })

        it('rejects loudly and never emits a localhost URL when FRONTEND_URL is unset', async () => {
            const watcherSpy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockImplementation(async () => ({ output: [] }))
            const originalGetOrThrow = system.getOrThrow.bind(system)
            vi.spyOn(system, 'getOrThrow').mockImplementation((prop: AppSystemProp) => {
                if (prop === AppSystemProp.FRONTEND_URL) {
                    throw new Error('System property AP_FRONTEND_URL is not defined')
                }
                return originalGetOrThrow(prop)
            })

            const binding = createSampleBinding('tb_fail_loud_789')
            await expect(executeEngineHook({
                binding,
                hookType: TriggerHookType.ON_ENABLE,
            })).rejects.toThrow('System property AP_FRONTEND_URL is not defined')

            expect(watcherSpy).not.toHaveBeenCalled()
        })
    })
})

describe('TriggerBinding Schedule Re-sync on Update', () => {
    beforeEach(() => {
        schedulerSpies.cron.mockReset().mockResolvedValue('job-id')
        schedulerSpies.cancel.mockReset().mockResolvedValue(undefined)
        repositoryMock.findOneBy.mockReset()
        repositoryMock.save.mockReset().mockImplementation((entity: TriggerBinding) => entity)
    })

    const existingBinding = (id: string, settings: TriggerBinding['settings']): TriggerBinding => ({
        ...createSampleBinding(id),
        settings,
    })

    it('re-registers the in-memory cron job when settings.cronExpression changes while staying ENABLED', async () => {
        const binding = existingBinding('tb_resync_001', { cronExpression: '0 0 * * *' })
        repositoryMock.findOneBy.mockResolvedValue(binding)

        await triggerBindingService.update({
            id: binding.id,
            projectId: binding.projectId,
            platformId: binding.platformId,
            request: { settings: { cronExpression: '30 12 * * *' } },
        })

        // Old jobs are torn down so a stale schedule cannot keep firing…
        expect(schedulerSpies.cancel).toHaveBeenCalledWith(`trigger-cron-${binding.id}`)
        expect(schedulerSpies.cancel).toHaveBeenCalledWith(`trigger-renew-${binding.id}`)
        // …and the run job is re-registered with the NEW expression.
        expect(schedulerSpies.cron).toHaveBeenCalledWith(expect.objectContaining({
            name: `trigger-cron-${binding.id}`,
            cronExpression: '30 12 * * *',
        }))
    })

    it('stops scheduling when the updated settings remove the cron expression', async () => {
        const binding = existingBinding('tb_resync_002', { cronExpression: '0 0 * * *' })
        repositoryMock.findOneBy.mockResolvedValue(binding)

        await triggerBindingService.update({
            id: binding.id,
            projectId: binding.projectId,
            platformId: binding.platformId,
            request: { settings: {} },
        })

        expect(schedulerSpies.cancel).toHaveBeenCalledWith(`trigger-cron-${binding.id}`)
        expect(schedulerSpies.cron).not.toHaveBeenCalled()
    })

    it('rejects an invalid cron expression and leaves the previous schedule intact', async () => {
        const binding = existingBinding('tb_resync_003', { cronExpression: '0 0 * * *' })
        repositoryMock.findOneBy.mockResolvedValue(binding)

        await expect(triggerBindingService.update({
            id: binding.id,
            projectId: binding.projectId,
            platformId: binding.platformId,
            request: { settings: { cronExpression: 'not a cron' } },
        })).rejects.toThrow(ActivepiecesError)

        expect(schedulerSpies.cancel).not.toHaveBeenCalled()
        expect(schedulerSpies.cron).not.toHaveBeenCalled()
    })

    it('does not re-register the schedule for updates that cannot affect scheduling', async () => {
        const binding = existingBinding('tb_resync_004', { cronExpression: '0 0 * * *' })
        repositoryMock.findOneBy.mockResolvedValue(binding)

        await triggerBindingService.update({
            id: binding.id,
            projectId: binding.projectId,
            platformId: binding.platformId,
            request: { promptTemplate: 'New prompt' },
        })

        expect(schedulerSpies.cron).not.toHaveBeenCalled()
        expect(schedulerSpies.cancel).not.toHaveBeenCalled()
    })
})

