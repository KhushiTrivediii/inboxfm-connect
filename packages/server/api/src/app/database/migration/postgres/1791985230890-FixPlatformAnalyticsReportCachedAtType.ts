import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class FixPlatformAnalyticsReportCachedAtType1791985230890 implements Migration {
    name = 'FixPlatformAnalyticsReportCachedAtType1791985230890'
    breaking = false
    release = '0.87.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // "cachedAt" was created as TIMESTAMP WITHOUT TIME ZONE (the entity declared `type: Date`),
        // so the UTC offset of the value written by the service was silently dropped. Readers then
        // re-interpreted the naive wall-clock in the server's local timezone: under PGlite the value
        // is written as UTC (Date params are serialized via toISOString) but read back as local time,
        // shifting the instant by exactly the machine's UTC offset. On any server offset by ±5 minutes
        // or more, getOrGenerateReport saw every cached report as >5 minutes old and regenerated on
        // every call, so the 5-minute cache never hit. The service always writes UTC
        // (dayjs().toISOString()), so interpret the existing naive values as UTC when converting.
        await queryRunner.query(`
            ALTER TABLE "platform_analytics_report"
            ALTER COLUMN "cachedAt" TYPE TIMESTAMP WITH TIME ZONE
            USING "cachedAt" AT TIME ZONE 'UTC'
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "platform_analytics_report"
            ALTER COLUMN "cachedAt" TYPE TIMESTAMP
            USING "cachedAt" AT TIME ZONE 'UTC'
        `)
    }
}
