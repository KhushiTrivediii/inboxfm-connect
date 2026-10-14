import { timingSafeEqual } from 'node:crypto'
import { apId, PlatformId } from '@inboxfm-connect/core-utils'
import { OtpModel, OtpState, OtpType } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { userIdentityService } from '../../../authentication/user-identity/user-identity-service'
import { repoFactory } from '../../../core/db/repo-factory'
import { emailService } from '../../helper/email/email-service'
import { otpGenerator } from './lib/otp-generator'
import { OtpEntity } from './otp-entity'

const TEN_MINUTES = 10 * 60 * 1000

const repo = repoFactory(OtpEntity)

export const otpService = (log: FastifyBaseLogger) => ({
    async createAndSend({
        platformId,
        email,
        type,
    }: CreateParams): Promise<void> {
        const userIdentity = await userIdentityService(log).getIdentityByEmail(email)
        if (!userIdentity) {
            return
        }
        const existingOtp = await repo().findOneBy({
            identityId: userIdentity.id,
            type,
        })
        const otpIsNotExpired = existingOtp && dayjs().diff(existingOtp.updated, 'milliseconds') < TEN_MINUTES
        if (otpIsNotExpired) {
            return
        }
        const newOtp: Omit<OtpModel, 'created'> = {
            id: apId(),
            updated: dayjs().toISOString(),
            type,
            identityId: userIdentity.id,
            value: otpGenerator.generate(),
            state: OtpState.PENDING,
        }
        await repo().upsert(newOtp, ['identityId', 'type'])
        await emailService(log).sendOtp({
            platformId,
            userIdentity,
            otp: newOtp.value,
            type: newOtp.type,
        })
    },

    async confirm({ identityId, type, value }: ConfirmParams): Promise<boolean> {
        const otp = await repo().findOneByOrFail({
            identityId,
            type,
        })
        const otpIsPending = otp.state === OtpState.PENDING
        const otpIsNotExpired = dayjs().diff(otp.updated, 'milliseconds') < TEN_MINUTES
        const otpMatches = matchesOtpValue(otp.value, value)
        if (!otpIsPending || !otpIsNotExpired || !otpMatches) {
            // Fail-closed WITHOUT consuming: a wrong or expired attempt must not
            // burn a still-usable token (the caller may retry with the right code
            // within the window).
            return false
        }

        // Single-use enforcement must hold under concurrency: the previous shape
        // was read-check-write, so two racing requests that both read state=PENDING
        // both confirmed the same OTP (double password reset / double
        // verification). The consumption is a single conditional UPDATE that only
        // matches a still-PENDING row — the loser of a race sees no returned row
        // and is rejected. RETURNING is the verdict instead of
        // UpdateResult.affected because the PGLite driver does not populate the
        // latter (same pattern as mcp-oauth-code.service.ts#consume and
        // connect-session.service.ts#consumeOrThrow).
        const claimResult = await repo().createQueryBuilder()
            .update()
            .set({ state: OtpState.CONFIRMED })
            .where('"id" = :id AND "state" = :pending', { id: otp.id, pending: OtpState.PENDING })
            .returning('id')
            .execute()

        const claimedRows = claimResult.raw as unknown[]
        return Array.isArray(claimedRows) && claimedRows.length > 0
    },
})

// Constant-time OTP comparison, same shape as the admin API-key and AppSumo
// token compares (admin-platform.controller.ts #369, appsumo.module.ts #463):
// the OTP is a single-use bearer credential for password reset / email
// verification, so a plain `===` leaks a prefix-based timing signal on the
// route an attacker scripts against. The length check first avoids
// timingSafeEqual's throw — length is not secret material.
function matchesOtpValue(storedValue: string, providedValue: string): boolean {
    const storedBuf = Buffer.from(storedValue)
    const providedBuf = Buffer.from(providedValue)
    return storedBuf.length === providedBuf.length && timingSafeEqual(storedBuf, providedBuf)
}

type CreateParams = {
    platformId: PlatformId | null
    email: string
    type: OtpType
}

type ConfirmParams = {
    identityId: string
    type: OtpType
    value: string
}
