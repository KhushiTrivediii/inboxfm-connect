import { Platform, PlatformAnalyticsReport } from '@inboxfm-connect/shared'
import { EntitySchema } from 'typeorm'
import {
    BaseColumnSchemaPart,
} from '../database/database-common'

type PlatformAnalyticsReportEntity = PlatformAnalyticsReport & {
    platform: Platform
}
export const PlatformAnalyticsReportEntity = new EntitySchema<PlatformAnalyticsReportEntity>({
    name: 'platform_analytics_report',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            type: String,
        },
        outdated: {
            type: Boolean,
            nullable: false,
        },
        cachedAt: {
            // `type: Date` maps to TIMESTAMP WITHOUT TIME ZONE (PostgresDriver.normalizeType),
            // dropping the UTC offset the service writes and shifting the value by the server's
            // timezone offset on read (cache then never hits outside UTC) — see migration
            // 1791985230890. Every other timestamp column here is timestamptz.
            type: 'timestamp with time zone',
            nullable: false,
        },
        runs: {
            type: 'jsonb',
            nullable: false,
        },
        flows: {
            type: 'jsonb',
            nullable: false,
        },
        users: {
            type: 'jsonb',
            nullable: false,
        },
    },    
    indices: [
        {
            name: 'idx_platform_analytics_report_platform_id',
            columns: ['platformId'],
            unique: false,
        },
    ],
    relations: {
        platform: {
            target: 'platform',
            type: 'many-to-one',
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                referencedColumnName: 'id',
                foreignKeyConstraintName: 'fk_platform_analytics_report_platform_id',
            },
        },
    },
})
