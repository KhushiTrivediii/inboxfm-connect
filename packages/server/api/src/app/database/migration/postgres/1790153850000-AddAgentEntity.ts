import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddAgentEntity1790153850000 implements Migration {
    name = 'AddAgentEntity1790153850000'
    breaking = false
    release = '0.88.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "agent" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21) NOT NULL,
                "platformId" character varying(21) NOT NULL,
                "externalId" character varying NOT NULL,
                "displayName" character varying NOT NULL,
                "description" character varying,
                "prompt" text NOT NULL,
                "maxSteps" integer NOT NULL DEFAULT 10,
                "model" jsonb NOT NULL,
                "tools" jsonb NOT NULL DEFAULT '[]',
                "structuredOutput" jsonb,
                "status" character varying NOT NULL DEFAULT 'ENABLED',
                CONSTRAINT "PK_agent_id" PRIMARY KEY ("id"),
                CONSTRAINT "fk_agent_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_agent_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_project_id_external_id" ON "agent" ("projectId", "externalId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_agent_project_id" ON "agent" ("projectId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_agent_platform_id" ON "agent" ("platformId")')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE IF EXISTS "agent"')
    }
}
