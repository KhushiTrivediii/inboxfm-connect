import { Agent, Platform, Project } from '@inboxfm-connect/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export const AgentEntity = new EntitySchema<AgentSchema>({
    name: 'agent',
    columns: {
        ...BaseColumnSchemaPart,
        projectId: {
            ...ApIdSchema,
            nullable: false,
        },
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        externalId: {
            type: String,
            nullable: false,
        },
        displayName: {
            type: String,
            nullable: false,
        },
        description: {
            type: String,
            nullable: true,
        },
        prompt: {
            type: 'text',
            nullable: false,
        },
        maxSteps: {
            type: Number,
            nullable: false,
            default: 10,
        },
        model: {
            type: 'jsonb',
            nullable: false,
        },
        tools: {
            type: 'jsonb',
            nullable: false,
            default: () => '\'[]\'',
        },
        structuredOutput: {
            type: 'jsonb',
            nullable: true,
        },
        status: {
            type: String,
            nullable: false,
            default: 'ENABLED',
        },
    },
    indices: [
        {
            name: 'idx_agent_project_id_external_id',
            columns: ['projectId', 'externalId'],
            unique: true,
        },
        {
            name: 'idx_agent_project_id',
            columns: ['projectId'],
        },
        {
            name: 'idx_agent_platform_id',
            columns: ['platformId'],
        },
    ],
    relations: {
        project: {
            type: 'many-to-one',
            target: 'project',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_agent_project_id',
            },
        },
        platform: {
            type: 'many-to-one',
            target: 'platform',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_agent_platform_id',
            },
        },
    },
})

export type AgentSchema = Agent & {
    project?: Project
    platform?: Platform
}
