import { z } from 'zod'
import { BaseModelSchema } from '@inboxfm-connect/core-utils'
import { EngineResponseStatus } from '../engine/engine-operation'
import { JobData } from './job-data'

export enum WorkerMachineStatus {
    ONLINE = 'ONLINE',
    OFFLINE = 'OFFLINE',
}

export enum WorkerMachineType {
    SHARED = 'SHARED',
    DEDICATED = 'DEDICATED',
}

export enum WorkerGroupScope {
    PLATFORM = 'platform',
    PROJECT = 'project',
}

export enum NetworkMode {
    UNRESTRICTED = 'UNRESTRICTED',
    STRICT = 'STRICT',
}


export const SandboxInformation = z.object({
    sandboxId: z.string(),
    boxId: z.number(),
    busy: z.boolean(),
    memoryUsageBytes: z.number(),
})

export type SandboxInformation = z.infer<typeof SandboxInformation>
export const WorkerProps = z.object({
    EXECUTION_MODE: z.string().optional(),
    WORKER_CONCURRENCY: z.string().optional(),
    SANDBOX_MEMORY_LIMIT: z.string().optional(),
    REUSE_SANDBOX: z.string().optional(),
    version: z.string().optional(),
})

export type WorkerProps = z.infer<typeof WorkerProps>

export const MachineInformation = z.object({
    cpuUsagePercentage: z.number(),
    diskInfo: z.object({
        total: z.number(),
        free: z.number(),
        used: z.number(),
        percentage: z.number(),
    }),
    workerId: z.string(),
    workerProps: WorkerProps,
    ramUsagePercentage: z.number(),
    totalAvailableRamInBytes: z.number(),
    totalCpuCores: z.number(),
    ip: z.string(),
    sandboxes: z.array(SandboxInformation).default([]),
})

export type MachineInformation = z.infer<typeof MachineInformation>

export const WorkerMachine = z.object({
    ...BaseModelSchema,
    information: MachineInformation,
})

export type WorkerMachine = z.infer<typeof WorkerMachine>

export const WorkerMachineWithStatus = WorkerMachine.extend({
    status: z.nativeEnum(WorkerMachineStatus),
    type: z.nativeEnum(WorkerMachineType),
    workerGroupId: z.string().optional(),
    workerGroupScope: z.nativeEnum(WorkerGroupScope).optional(),
})

export type WorkerMachineWithStatus = z.infer<typeof WorkerMachineWithStatus>

export const ConsumeJobRequest = z.object({
    jobId: z.string(),
    jobData: JobData,
    attempsStarted: z.number(),
    engineToken: z.string(),
    token: z.string(),
    queueName: z.string(),
})

export type ConsumeJobRequest = z.infer<typeof ConsumeJobRequest>

export const ConsumeJobResponse = z.object({
    status: z.nativeEnum(EngineResponseStatus),
    errorMessage: z.string().optional(),
    logs: z.string().optional(),
    response: z.unknown().optional(),
})


export type ConsumeJobResponse = z.infer<typeof ConsumeJobResponse>

export const WorkerMachineHealthcheckRequest = MachineInformation

export type WorkerMachineHealthcheckRequest = z.infer<typeof WorkerMachineHealthcheckRequest>

