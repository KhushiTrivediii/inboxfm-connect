export interface Scheduler {
    once(params: {
        name: string
        delayMs: number
        fn: () => Promise<void> | void
        onError?: (ctx: SchedulerTaskErrorContext) => void
    }): Promise<string>

    every(params: {
        name: string
        intervalMs: number
        fn: () => Promise<void> | void
        onError?: (ctx: SchedulerTaskErrorContext) => void
    }): Promise<string>

    cron(params: {
        name: string
        cronExpression: string
        timezone?: string
        recoverMissedExecutions?: boolean
        fn: () => Promise<void> | void
        onError?: (ctx: SchedulerTaskErrorContext) => void
    }): Promise<string>

    cancel(id: string): Promise<void>
    shutdown(): Promise<void>
    has(id: string): boolean
    getActiveTaskCount(): number
    getTaskIds(): string[]
}

export type SchedulerTaskErrorContext = {
    id: string
    name: string
    error: unknown
}

export type ParsedCronField = {
    values: Set<number>
    wildcard: boolean
}

export type ParsedCronSchedule = {
    seconds: ParsedCronField
    minutes: ParsedCronField
    hours: ParsedCronField
    daysOfMonth: ParsedCronField
    months: ParsedCronField
    daysOfWeek: ParsedCronField
    originalExpression: string
    hasSeconds: boolean
}

export type NextTickOptions = {
    fromDate?: Date
    timezone?: string
}
