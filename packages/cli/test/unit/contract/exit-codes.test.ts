import { describe, expect, it } from 'vitest'
import {
    EXIT_AUTH,
    EXIT_DRIFT,
    EXIT_PREFLIGHT,
    EXIT_SERVER,
    EXIT_SUCCESS,
    EXIT_TRANSPORT,
    EXIT_VALIDATION,
} from '../../../src/lib/commands/project-replace'

describe('CLI Exit-Code Contract (Issue #139)', () => {
    it('locks distinct, predictable exit codes for each failure class', () => {
        const exitCodes = {
            EXIT_SUCCESS,
            EXIT_PREFLIGHT,
            EXIT_VALIDATION,
            EXIT_DRIFT,
            EXIT_AUTH,
            EXIT_TRANSPORT,
            EXIT_SERVER,
        }

        expect(exitCodes.EXIT_SUCCESS).toBe(0)
        expect(exitCodes.EXIT_PREFLIGHT).toBe(1)
        expect(exitCodes.EXIT_VALIDATION).toBe(2)
        expect(exitCodes.EXIT_DRIFT).toBe(3)
        expect(exitCodes.EXIT_AUTH).toBe(4)
        expect(exitCodes.EXIT_TRANSPORT).toBe(5)
        expect(exitCodes.EXIT_SERVER).toBe(6)
    })

    it('guarantees zero collisions between different exit code categories', () => {
        const codes = [
            EXIT_SUCCESS,
            EXIT_PREFLIGHT,
            EXIT_VALIDATION,
            EXIT_DRIFT,
            EXIT_AUTH,
            EXIT_TRANSPORT,
            EXIT_SERVER,
        ]

        const uniqueCodes = new Set(codes)
        expect(uniqueCodes.size).toBe(codes.length)
    })
})
