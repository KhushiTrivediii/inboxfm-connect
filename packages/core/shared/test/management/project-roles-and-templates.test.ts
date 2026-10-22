import { describe, it, expect } from 'vitest'
import { RoleType } from '@inboxfm-connect/core-utils'
import {
    CreateProjectRoleRequestBody,
    UpdateProjectRoleRequestBody,
    ListProjectMembersForProjectRoleRequestQuery,
} from '../../src/lib/management/project-role/project-role.request'
import {
    TemplateTelemetryEventType,
    TemplateTelemetryEvent,
} from '../../src/lib/management/template/template-telemetry'
import { GetFlowTemplateRequestQuery } from '../../src/lib/management/template/flow-template/flow-template.request'

describe('Project Roles and Template Telemetry Contracts', () => {
    describe('Project Role Request Schemas', () => {
        it('should validate CreateProjectRoleRequestBody with valid safe string and role type', () => {
            const valid = {
                name: 'CustomEditor',
                permissions: ['READ_FLOW', 'WRITE_FLOW'],
                type: RoleType.CUSTOM,
            }
            const parsed = CreateProjectRoleRequestBody.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.name).toBe('CustomEditor')
                expect(parsed.data.type).toBe(RoleType.CUSTOM)
                expect(parsed.data.permissions).toHaveLength(2)
            }
        })

        it('should reject names violating SAFE_STRING_PATTERN or invalid role types', () => {
            const invalidName = {
                name: '<script>alert(1)</script>',
                permissions: [],
                type: RoleType.CUSTOM,
            }
            expect(CreateProjectRoleRequestBody.safeParse(invalidName).success).toBe(false)

            const invalidType = {
                name: 'ValidName',
                permissions: [],
                type: 'SUPER_ADMIN_INVALID',
            }
            expect(CreateProjectRoleRequestBody.safeParse(invalidType).success).toBe(false)
        })

        it('should validate UpdateProjectRoleRequestBody with partial fields', () => {
            expect(UpdateProjectRoleRequestBody.safeParse({}).success).toBe(true)
            expect(UpdateProjectRoleRequestBody.safeParse({ name: 'RenamedRole' }).success).toBe(true)
            expect(UpdateProjectRoleRequestBody.safeParse({ permissions: ['READ_PROJECT'] }).success).toBe(true)
        })

        it('should validate ListProjectMembersForProjectRoleRequestQuery with limit coercion', () => {
            const parsed = ListProjectMembersForProjectRoleRequestQuery.safeParse({
                limit: '50',
                cursor: 'cur_role_1',
            })
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.limit).toBe(50)
                expect(parsed.data.cursor).toBe('cur_role_1')
            }
        })
    })

    describe('Template Telemetry Contracts', () => {
        it('should export all TemplateTelemetryEventType enum values', () => {
            expect(TemplateTelemetryEventType.VIEW).toBe('VIEW')
            expect(TemplateTelemetryEventType.INSTALL).toBe('INSTALL')
            expect(TemplateTelemetryEventType.ACTIVATE).toBe('ACTIVATE')
            expect(TemplateTelemetryEventType.DEACTIVATE).toBe('DEACTIVATE')
            expect(TemplateTelemetryEventType.EXPLORE_VIEW).toBe('EXPLORE_VIEW')
        })

        it('should validate VIEW template telemetry event', () => {
            const parsed = TemplateTelemetryEvent.safeParse({
                eventType: TemplateTelemetryEventType.VIEW,
                templateId: 'tmpl_101',
            })
            expect(parsed.success).toBe(true)
        })

        it('should validate INSTALL template telemetry event requiring userId', () => {
            const valid = {
                eventType: TemplateTelemetryEventType.INSTALL,
                templateId: 'tmpl_101',
                userId: 'usr_42',
            }
            expect(TemplateTelemetryEvent.safeParse(valid).success).toBe(true)

            const missingUser = {
                eventType: TemplateTelemetryEventType.INSTALL,
                templateId: 'tmpl_101',
            }
            expect(TemplateTelemetryEvent.safeParse(missingUser).success).toBe(false)
        })

        it('should validate ACTIVATE and DEACTIVATE template telemetry events requiring flowId', () => {
            const activate = {
                eventType: TemplateTelemetryEventType.ACTIVATE,
                templateId: 'tmpl_101',
                flowId: 'flow_99',
            }
            expect(TemplateTelemetryEvent.safeParse(activate).success).toBe(true)

            const deactivate = {
                eventType: TemplateTelemetryEventType.DEACTIVATE,
                templateId: 'tmpl_101',
                flowId: 'flow_99',
            }
            expect(TemplateTelemetryEvent.safeParse(deactivate).success).toBe(true)
        })

        it('should validate EXPLORE_VIEW template telemetry event with optional userId', () => {
            expect(TemplateTelemetryEvent.safeParse({
                eventType: TemplateTelemetryEventType.EXPLORE_VIEW,
            }).success).toBe(true)

            expect(TemplateTelemetryEvent.safeParse({
                eventType: TemplateTelemetryEventType.EXPLORE_VIEW,
                userId: 'usr_abc',
            }).success).toBe(true)
        })

        it('should reject unrecognized telemetry event types', () => {
            expect(TemplateTelemetryEvent.safeParse({
                eventType: 'UNKNOWN_ACTION',
                templateId: 'tmpl_1',
            }).success).toBe(false)
        })
    })

    describe('Flow Template Request Contracts', () => {
        it('should validate GetFlowTemplateRequestQuery with optional versionId', () => {
            expect(GetFlowTemplateRequestQuery.safeParse({}).success).toBe(true)
            const withVer = GetFlowTemplateRequestQuery.safeParse({ versionId: 'ver_latest' })
            expect(withVer.success).toBe(true)
            if (withVer.success) {
                expect(withVer.data.versionId).toBe('ver_latest')
            }
        })
    })
})
