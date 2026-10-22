import crypto from 'crypto'
import { ConnectionMappingSchema, ProjectReplacePlan } from '@inboxfm-connect/shared'
import { describe, expect, it } from 'vitest'
import { projectReplaceTesting } from '../../../../src/app/project/replace/project-replace.service'

const {
    canonicalJson,
    computePlanSignature,
    sanitizeMappingForPlan,
} = projectReplaceTesting

describe('project-replace plan signing & integrity (Issue #126)', () => {
    describe('canonicalJson', () => {
        it('serializes objects with keys in sorted deterministic order', () => {
            const objA = { z: 1, a: 2, m: { y: 'hello', b: 'world' } }
            const objB = { a: 2, m: { b: 'world', y: 'hello' }, z: 1 }

            expect(canonicalJson(objA)).toBe('{"a":2,"m":{"b":"world","y":"hello"},"z":1}')
            expect(canonicalJson(objA)).toBe(canonicalJson(objB))
        })

        it('handles arrays, nulls, and primitives consistently', () => {
            expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]')
            expect(canonicalJson(null)).toBe('null')
            expect(canonicalJson('test')).toBe('"test"')
            expect(canonicalJson(123)).toBe('123')
            expect(canonicalJson(true)).toBe('true')
        })

        it('ignores undefined values on object properties', () => {
            const objWithUndefined = { a: 1, b: undefined, c: 3 }
            expect(canonicalJson(objWithUndefined)).toBe('{"a":1,"c":3}')
        })
    })

    describe('sanitizeMappingForPlan', () => {
        it('strips sensitive connection values while preserving mapping coordinates', () => {
            const rawMapping: ConnectionMappingSchema = {
                sourceExternalId: 'slack-source',
                destExternalId: 'slack-dest',
                destConnectionId: 'conn-123',
                pieceName: '@inboxfm-connect/piece-slack',
                type: 'SECRET_TEXT' as const,
                displayName: 'Slack Connection',
                value: 'secret-token-xyz' as unknown as Record<string, unknown>,
            }

            const sanitized = sanitizeMappingForPlan(rawMapping)
            expect(sanitized).not.toHaveProperty('value')
            expect(sanitized).toEqual({
                sourceExternalId: 'slack-source',
                destExternalId: 'slack-dest',
                destConnectionId: 'conn-123',
                pieceName: '@inboxfm-connect/piece-slack',
                type: 'SECRET_TEXT',
                displayName: 'Slack Connection',
            })
        })
    })

    describe('computePlanSignature & tamper rejection', () => {
        const createSamplePlan = (): Omit<ProjectReplacePlan, 'signature'> => ({
            planId: 'plan-001',
            schemaVersion: 1,
            toolVersion: '1.0.0',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceActivepiecesVersion: '0.86.0',
            targetActivepiecesVersion: '0.86.0',
            targetProjectId: 'proj-dest-1',
            checksum: 'sha256:abcd1234abcd1234',
            destinationStateHash: 'hash-xyz-987',
            preflight: {
                passed: true,
                errors: [],
                warnings: [],
            },
            connectionMappings: [
                {
                    sourceExternalId: 'conn-a',
                    destExternalId: 'conn-b',
                    destConnectionId: 'dest-conn-id',
                    pieceName: '@inboxfm-connect/piece-slack',
                    type: 'SECRET_TEXT' as const,
                    displayName: 'Slack Integration',
                },
            ],
            changes: {
                creates: [{ kind: 'table', externalId: 'tbl-1' }],
                updates: [],
                deletes: [],
                unchanged: [],
            },
            summary: {
                totalCreates: 1,
                totalUpdates: 0,
                totalDeletes: 0,
                totalUnchanged: 0,
            },
        })

        it('generates consistent HMAC-SHA256 signature for identical plan content', () => {
            const planA = createSamplePlan()
            const planB = createSamplePlan()

            const sigA = computePlanSignature(planA)
            const sigB = computePlanSignature(planB)

            expect(sigA).toBe(sigB)
            expect(sigA).toMatch(/^[a-f0-9]{64}$/)
        })

        it('rejects tampered plan with any byte flipped in changes', () => {
            const basePlan = createSamplePlan()
            const originalSig = computePlanSignature(basePlan)

            const tamperedPlan = createSamplePlan()
            tamperedPlan.changes.creates.push({ kind: 'agent', externalId: 'injected-evil-agent' })
            const tamperedSig = computePlanSignature(tamperedPlan)

            expect(tamperedSig).not.toBe(originalSig)

            // Verify timingSafeEqual detection
            const origBuf = Buffer.from(originalSig, 'hex')
            const tamperedBuf = Buffer.from(tamperedSig, 'hex')
            expect(crypto.timingSafeEqual(origBuf, tamperedBuf)).toBe(false)
        })

        it('rejects tampered destination project ID or destination state hash (anti-replay)', () => {
            const basePlan = createSamplePlan()
            const originalSig = computePlanSignature(basePlan)

            const replayedPlan = createSamplePlan()
            replayedPlan.targetProjectId = 'proj-different-victim'
            const replayedSig = computePlanSignature(replayedPlan)

            expect(replayedSig).not.toBe(originalSig)

            const driftedPlan = createSamplePlan()
            driftedPlan.destinationStateHash = 'different-destination-state'
            const driftedSig = computePlanSignature(driftedPlan)

            expect(driftedSig).not.toBe(originalSig)
        })

        it('rejects tampered preflight flags or checksums', () => {
            const basePlan = createSamplePlan()
            const originalSig = computePlanSignature(basePlan)

            const tamperedPreflight = createSamplePlan()
            tamperedPreflight.preflight.passed = false
            const preflightSig = computePlanSignature(tamperedPreflight)
            expect(preflightSig).not.toBe(originalSig)

            const tamperedChecksum = createSamplePlan()
            tamperedChecksum.checksum = 'sha256:corrupted'
            const checksumSig = computePlanSignature(tamperedChecksum)
            expect(checksumSig).not.toBe(originalSig)
        })
    })
})
