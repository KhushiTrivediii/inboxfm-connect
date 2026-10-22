import { describe, expect, it } from 'vitest'
import { Permission } from '@inboxfm-connect/core-utils'
import { rolePermissions } from '../../src/lib/ee/authn/access-control-list'
import { DefaultProjectRole } from '../../src/lib/management/project/project-member'

describe('rolePermissions Access Control List (ACL)', () => {
    it('defines permissions for all DefaultProjectRole members', () => {
        const roles = Object.values(DefaultProjectRole)
        expect(roles).toEqual(['Admin', 'Editor', 'Viewer'])
        for (const role of roles) {
            expect(rolePermissions[role]).toBeDefined()
            expect(Array.isArray(rolePermissions[role])).toBe(true)
            expect(rolePermissions[role].length).toBeGreaterThan(0)
        }
    })

    it('contains no duplicate permissions within any role', () => {
        for (const [role, permissions] of Object.entries(rolePermissions)) {
            const uniqueSet = new Set(permissions)
            expect(uniqueSet.size, `Duplicate permission found in role ${role}`).toBe(permissions.length)
        }
    })

    it('enforces that VIEWER only possesses READ permissions (strict read-only gate)', () => {
        const viewerPerms = rolePermissions[DefaultProjectRole.VIEWER]
        for (const perm of viewerPerms) {
            expect(perm.startsWith('READ_'), `Viewer has non-read permission: ${perm}`).toBe(true)
        }
    })

    it('enforces that VIEWER possesses zero WRITE or UPDATE permissions', () => {
        const viewerPerms = rolePermissions[DefaultProjectRole.VIEWER]
        expect(viewerPerms).not.toContain(Permission.WRITE_FLOW)
        expect(viewerPerms).not.toContain(Permission.UPDATE_FLOW_STATUS)
        expect(viewerPerms).not.toContain(Permission.WRITE_RUN)
        expect(viewerPerms).not.toContain(Permission.WRITE_TABLE)
        expect(viewerPerms).not.toContain(Permission.WRITE_APP_CONNECTION)
        expect(viewerPerms).not.toContain(Permission.WRITE_PROJECT_MEMBER)
        expect(viewerPerms).not.toContain(Permission.WRITE_INVITATION)
    })

    it('enforces that ADMIN is a superset of EDITOR permissions', () => {
        const adminPerms = new Set(rolePermissions[DefaultProjectRole.ADMIN])
        const editorPerms = rolePermissions[DefaultProjectRole.EDITOR]
        for (const perm of editorPerms) {
            expect(adminPerms.has(perm), `Admin is missing editor permission: ${perm}`).toBe(true)
        }
        expect(adminPerms.size).toBeGreaterThan(editorPerms.length)
    })

    it('enforces that sensitive administrative permissions are restricted to ADMIN only', () => {
        const adminExclusivePerms = [
            Permission.WRITE_PROJECT_MEMBER,
            Permission.WRITE_INVITATION,
            Permission.WRITE_PROJECT,
            Permission.WRITE_ALERT,
            Permission.READ_ALERT,
            Permission.READ_API_KEY,
            Permission.WRITE_API_KEY,
        ]

        const editorPerms = new Set(rolePermissions[DefaultProjectRole.EDITOR])
        const viewerPerms = new Set(rolePermissions[DefaultProjectRole.VIEWER])

        for (const perm of adminExclusivePerms) {
            expect(rolePermissions[DefaultProjectRole.ADMIN]).toContain(perm)
            expect(editorPerms.has(perm), `Editor leaked admin-only permission: ${perm}`).toBe(false)
            expect(viewerPerms.has(perm), `Viewer leaked admin-only permission: ${perm}`).toBe(false)
        }
    })

    it('verifies flow and resource editing permissions on EDITOR role', () => {
        const editorPerms = new Set(rolePermissions[DefaultProjectRole.EDITOR])
        expect(editorPerms.has(Permission.WRITE_FLOW)).toBe(true)
        expect(editorPerms.has(Permission.UPDATE_FLOW_STATUS)).toBe(true)
        expect(editorPerms.has(Permission.WRITE_TABLE)).toBe(true)
        expect(editorPerms.has(Permission.WRITE_FOLDER)).toBe(true)
        expect(editorPerms.has(Permission.WRITE_APP_CONNECTION)).toBe(true)
        expect(editorPerms.has(Permission.WRITE_MCP)).toBe(true)
        expect(editorPerms.has(Permission.WRITE_KNOWLEDGE_BASE)).toBe(true)
        expect(editorPerms.has(Permission.WRITE_VARIABLE)).toBe(true)
    })
})
