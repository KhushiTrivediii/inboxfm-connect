import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddConnectionHealthCheckColumns1791869626000 implements Migration {
    name = 'AddConnectionHealthCheckColumns1791869626000'
    breaking = false
    release = '0.87.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "app_connection"
            ADD "testedAt" character varying
        `)
        await queryRunner.query(`
            ALTER TABLE "app_connection"
            ADD "testedStatus" character varying
        `)
        await queryRunner.query(`
            ALTER TABLE "app_connection"
            ADD "testedMessage" character varying
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "app_connection" DROP COLUMN "testedMessage"')
        await queryRunner.query('ALTER TABLE "app_connection" DROP COLUMN "testedStatus"')
        await queryRunner.query('ALTER TABLE "app_connection" DROP COLUMN "testedAt"')
    }

}
