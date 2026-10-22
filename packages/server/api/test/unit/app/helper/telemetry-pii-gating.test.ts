import { describe, expect, it, vi } from 'vitest'

// Issue #406: telemetry identify() ships email/firstName/lastName to PostHog
// unconditionally, trackUser() writes the full payload to the app log at info
// level, and the enabled-flag is frozen at module load so runtime flag changes
// never take effect. The PostHog client and the system prop reader are mocked.

const piiOptIn = vi.hoisted(() => ({ value: false }))
const { posthogCapture, posthogIdentify, systemGetBoolean, logInfo } = vi.hoisted(() => ({
    posthogCapture: vi.fn(),
    posthogIdentify: vi.fn(),
    systemGetBoolean: vi.fn(() => true),
    logInfo: vi.fn(),
}))

vi.mock('posthog-node', () => ({
    PostHog: vi.fn(() => ({
        identify: posthogIdentify,
        capture: posthogCapture,
        shutdown: vi.fn(async () => {}),
    })),
}))

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        getBoolean: (prop: unknown) => {
            if (String(prop).includes('INCLUDE_PII')) {
                return piiOptIn.value
            }
            return systemGetBoolean(prop)
        },
        get: vi.fn(() => 'dev'),
        getOrThrow: vi.fn(() => 'memory'),
        getEdition: vi.fn(() => 'ce'),
    },
}))
vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedStore: { putIfAbsent: vi.fn(async () => true), get: vi.fn(async () => null), del: vi.fn(async () => {}) },
    redisConnections: { useExisting: vi.fn(), getRedisType: vi.fn(() => 'memory'), create: vi.fn() },
}))
vi.mock('../../../../src/app/platform/platform.service', () => ({
    platformService: vi.fn(() => ({ getOneOrThrow: vi.fn(async () => ({ ownerId: 'owner-1' })), getOne: vi.fn(async () => ({})) })),
}))
vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({ getOne: vi.fn(async () => ({ ownerId: 'owner-1', platformId: 'platform-1' })) })),
}))

import { telemetry } from '../../../../src/app/helper/telemetry.utils'

const log = { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

describe('telemetry PII gating (issue #406)', () => {
    it('strips email/firstName/lastName from identify() unless explicitly opted in', async () => {
        await telemetry(log).identify(
            { id: 'identity-1', email: 'victim@example.com', firstName: 'Victim', lastName: 'User', created: '2026-01-01' } as never,
            undefined,
        )
        expect(posthogIdentify).toHaveBeenCalled()
        const props = posthogIdentify.mock.calls[0]![0]!.properties
        expect(props['email']).toBeUndefined()
        expect(props['firstName']).toBeUndefined()
        expect(props['lastName']).toBeUndefined()
    })

    it('does not write the event payload into the info-level app log', async () => {
        await telemetry(log).trackUser('user-1', { name: 'flow_started', payload: { secret: 'abc' } } as never)
        expect(logInfo).not.toHaveBeenCalled()
        expect(posthogCapture).toHaveBeenCalled()
    })

    it('reads the telemetry flag per call - flipping it off stops events without a restart', async () => {
        posthogCapture.mockClear()
        systemGetBoolean.mockReturnValue(false)
        await telemetry(log).trackUser('user-1', { name: 'flow_started', payload: {} } as never)
        expect(posthogCapture).not.toHaveBeenCalled()
        systemGetBoolean.mockReturnValue(true)
        await telemetry(log).trackUser('user-1', { name: 'flow_started', payload: {} } as never)
        expect(posthogCapture).toHaveBeenCalled()
    })
})

describe('event-payload PII gating (codeant on #407)', () => {
    it('strips email/firstName/lastName from trackUser event payloads unless opted in', async () => {
        posthogCapture.mockClear()
        await telemetry(log).trackUser('user-1', {
            name: 'signed_up',
            payload: { userId: 'user-1', email: 'victim@example.com', firstName: 'Victim', lastName: 'User', projectId: 'project-1' },
        } as never)
        expect(posthogCapture).toHaveBeenCalled()
        const props = posthogCapture.mock.calls[0]![0]!.properties
        expect(props['email']).toBeUndefined()
        expect(props['firstName']).toBeUndefined()
        expect(props['lastName']).toBeUndefined()
        expect(props['userId']).toBe('user-1')
        expect(props['projectId']).toBe('project-1')
    })

    it('forwards identity PII in the payload when TELEMETRY_INCLUDE_PII is on', async () => {
        piiOptIn.value = true
        posthogCapture.mockClear()
        await telemetry(log).trackUser('user-1', {
            name: 'signed_up',
            payload: { email: 'victim@example.com', firstName: 'Victim' },
        } as never)
        const props = posthogCapture.mock.calls[0]![0]!.properties
        expect(props['email']).toBe('victim@example.com')
        expect(props['firstName']).toBe('Victim')
        piiOptIn.value = false
    })
})
