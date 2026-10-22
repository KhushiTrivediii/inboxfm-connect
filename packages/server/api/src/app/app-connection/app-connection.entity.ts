import {
    AppConnection,
    AppConnectionStatus,
    User,
    UserIdentity,
} from '@inboxfm-connect/shared'
import { EntitySchema } from 'typeorm'
import {
    BaseColumnSchemaPart,
} from '../database/database-common'
import { EncryptedObject } from '../helper/encryption'

export type ConnectionSchema = Omit<AppConnection, 'value'> & {
    value: EncryptedObject
    owner?: (User & { identity?: UserIdentity })
}

export const ConnectionEntity = new EntitySchema<ConnectionSchema>({
    name: 'app_connection',
    columns: {
        ...BaseColumnSchemaPart,
        displayName: {
            type: String,
        },
        externalId: {
            type: String,
        },
        type: {
            type: String,
        },
        status: {
            type: String,
            default: AppConnectionStatus.ACTIVE,
        },
        platformId: {
            type: String,
            nullable: false,
        },
        pieceName: {
            type: String,
        },
        ownerId: {
            type: String,
            nullable: true,
        },
        projectIds: {
            type: String,
            array: true,
            nullable: false,
        },
        scope: {
            type: String,
        },
        value: {
            type: 'jsonb',
        },
        metadata: {
            type: 'jsonb',
            nullable: true,
        },
        pieceVersion: {
            type: String,
        },
        preSelectForNewProjects: {
            type: Boolean,
            nullable: false,
            default: false,
        },
        // Health-check bookkeeping (issue #188): when the connection was last
        // explicitly tested, the verdict of that check, and the readable failure
        // reason. Null until the first test runs.
        testedAt: {
            type: String,
            nullable: true,
        },
        testedStatus: {
            type: String,
            nullable: true,
        },
        testedMessage: {
            type: String,
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_app_connection_platform_id_and_external_id',
            columns: ['platformId', 'externalId'],
        },
        {
            name: 'idx_app_connection_owner_id',
            columns: ['ownerId'],
        },
        {
            name: 'idx_app_connection_project_ids_gin',
            columns: ['projectIds'],
            synchronize: false,
        },
    ],
    relations: {
        owner: {
            type: 'many-to-one',
            target: 'user',
            cascade: true,
            onDelete: 'SET NULL',
            joinColumn: {
                name: 'ownerId',
                foreignKeyConstraintName: 'fk_app_connection_owner_id',
            },
        },
    },
})

export type AppConnectionSchema = ConnectionSchema
export const AppConnectionEntity = ConnectionEntity
