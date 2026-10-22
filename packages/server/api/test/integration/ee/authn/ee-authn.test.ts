import { ApEdition, ApEnvironment } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { createMockSignUpRequest } from '../../../helpers/mocks/authn'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'


let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})
describe('Authentication API', () => {
    describe('Sign up Endpoint', () => {
        it('Adds new user with onboarding token', async () => {
            // Sign-up's contract is edition-dependent (sendVerificationOrAutoVerify in
            // authentication.service.ts): ee/ce auto-verify new identities, while cloud
            // only auto-verifies in DEVELOPMENT — otherwise it dispatches an OTP
            // verification email and getOnboardingResponse correctly refuses a token for
            // the still-unverified identity (the cloud suite asserts that 403 contract
            // in cloud-authn.test.ts). This suite normally runs under AP_EDITION=ee
            // (`npm run test-ee`, what CI's ee job runs), but branch on the live
            // edition/environment instead of assuming the runner set one.
            const edition = system.getEdition()
            const environment = system.get(AppSystemProp.ENVIRONMENT)
            const signUpAutoVerifies = edition !== ApEdition.CLOUD || environment === ApEnvironment.DEVELOPMENT

            // arrange
            const mockSignUpRequest = createMockSignUpRequest()

            // act
            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })

            // assert
            if (!signUpAutoVerifies) {
                expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
                expect(response?.json()).toEqual({
                    code: 'EMAIL_IS_NOT_VERIFIED',
                    params: {
                        email: mockSignUpRequest.email.toLocaleLowerCase().trim(),
                    },
                })
                return
            }

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const responseBody = response?.json()

            expect(responseBody?.id).toHaveLength(21)
            expect(responseBody?.email).toBe(mockSignUpRequest.email.toLocaleLowerCase().trim())
            expect(responseBody?.firstName).toBe(mockSignUpRequest.firstName)
            expect(responseBody?.lastName).toBe(mockSignUpRequest.lastName)
            expect(responseBody?.trackEvents).toBe(mockSignUpRequest.trackEvents)
            expect(responseBody?.newsLetter).toBe(mockSignUpRequest.newsLetter)
            expect(responseBody?.password).toBeUndefined()
            expect(responseBody?.status).toBe('ACTIVE')
            expect(responseBody?.verified).toBe(true)
            expect(responseBody?.platformId).toBeNull()
            expect(responseBody?.externalId).toBeNull()
            expect(responseBody?.projectId).toBeNull()
            expect(responseBody?.token).toBeDefined()
        })
    })
})
