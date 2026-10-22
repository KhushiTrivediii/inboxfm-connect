import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddMcpOAuthTokenLineage1790154000000 implements Migration {
    name = 'AddMcpOAuthTokenLineage1790154000000'
    breaking = false
    release = '0.87.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "mcp_oauth_token"
            ADD "previousRefreshToken" character varying(128)
        `)
        await queryRunner.query(`
            ALTER TABLE "mcp_oauth_token"
            ADD "familyId" character varying(21) NOT NULL DEFAULT 'legacy'
        `)
        // Existing rows were all issued before lineage tracking: they are their own
        // family. Backfill familyId from the row id so the NOT NULL constraint holds
        // without a disruptive rewrite, then keep new rows on the id-based default.
        await queryRunner.query(`
            UPDATE "mcp_oauth_token" SET "familyId" = "id" WHERE "familyId" = 'legacy'
        `)
        // The DEFAULT 'legacy' only exists so pre-lineage rows can be backfilled in one
        // statement; the entity declares no default, so drop it to keep the generated
        // schema in sync (CI drift check fails otherwise).
        await queryRunner.query(`
            ALTER TABLE "mcp_oauth_token" ALTER COLUMN "familyId" DROP DEFAULT
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_mcp_oauth_token_previous_refresh" ON "mcp_oauth_token" ("previousRefreshToken")
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_mcp_oauth_token_family" ON "mcp_oauth_token" ("familyId")
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP INDEX "idx_mcp_oauth_token_family"')
        await queryRunner.query('DROP INDEX "idx_mcp_oauth_token_previous_refresh"')
        await queryRunner.query('ALTER TABLE "mcp_oauth_token" ALTER COLUMN "familyId" SET DEFAULT \'legacy\'')
        await queryRunner.query('ALTER TABLE "mcp_oauth_token" DROP COLUMN "familyId"')
        await queryRunner.query('ALTER TABLE "mcp_oauth_token" DROP COLUMN "previousRefreshToken"')
    }
}
