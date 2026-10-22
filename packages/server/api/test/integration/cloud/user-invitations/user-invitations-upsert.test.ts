import { faker } from '@faker-js/faker'
import { DefaultProjectRole, InvitationStatus, InvitationType, PlatformRole, PrincipalType, ProjectType, SendUserInvitationRequest } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('User Invitation Upsert', () => {
    it('re-inviting the same email for a PLATFORM invitation must update the existing row, not create a duplicate', async () => {
        const { mockOwner, mockPlatform } = await mockAndSaveBasicSetup({})
        const ownerToken = await generateMockToken({
            id: mockOwner.id,
            type: PrincipalType.USER,
            platform: { id: mockPlatform.id },
        })

        const email = faker.internet.email()
        const body: SendUserInvitationRequest = {
            email,
            type: InvitationType.PLATFORM,
            platformRole: PlatformRole.ADMIN,
        }

        const first = await app?.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${ownerToken}` },
            body,
        })
        expect(first?.statusCode).toBe(StatusCodes.CREATED)
        const firstBody = first?.json()

        const second = await app?.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${ownerToken}` },
            body,
        })
        expect(second?.statusCode).toBe(StatusCodes.CREATED)
        const secondBody = second?.json()

        // The API contract (route description) says: "If the user already has an
        // invitation, the invitation will be updated." A second PENDING row for the
        // same email means every re-invite stacks another duplicate — and every one
        // of them sends another invitation email and stays separately revocable.
        const invitations = await db.findManyBy('user_invitation', { email: email.toLowerCase().trim(), platformId: mockPlatform.id })
        expect(invitations.length).toBe(1)
        expect(secondBody?.id).toBe(firstBody?.id)
    })

    it('re-inviting the same email for a PROJECT invitation must keep the same row id so already-sent links keep working', async () => {
        const { mockOwner, mockPlatform, mockProject } = await mockAndSaveBasicSetup({
            plan: { projectRolesEnabled: true },
            project: { type: ProjectType.TEAM },
        })
        const ownerToken = await generateMockToken({
            id: mockOwner.id,
            type: PrincipalType.USER,
            platform: { id: mockPlatform.id },
        })

        const email = faker.internet.email()
        const body: SendUserInvitationRequest = {
            email,
            type: InvitationType.PROJECT,
            projectId: mockProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        }

        const first = await app?.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${ownerToken}` },
            body,
        })
        expect(first?.statusCode).toBe(StatusCodes.CREATED)
        const firstBody = first?.json()

        const second = await app?.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${ownerToken}` },
            body,
        })
        expect(second?.statusCode).toBe(StatusCodes.CREATED)
        const secondBody = second?.json()

        // The id embedded in the already-emailed invitation JWT must survive a
        // re-invite: rotating it strands every link already sitting in a user's inbox.
        expect(secondBody?.id).toBe(firstBody?.id)
        expect(secondBody?.status).toBe(InvitationStatus.PENDING)

        const invitations = await db.findManyBy('user_invitation', { email: email.toLowerCase().trim(), platformId: mockPlatform.id, projectId: mockProject.id })
        expect(invitations.length).toBe(1)
    })
})
