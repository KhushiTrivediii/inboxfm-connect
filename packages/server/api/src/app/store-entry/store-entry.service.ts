import { apId, ProjectId, sanitizeObjectForPostgresql } from '@inboxfm-connect/core-utils'
import { PutStoreEntryRequest, StoreEntry } from '@inboxfm-connect/shared'
import { repoFactory } from '../core/db/repo-factory'
import { StoreEntryEntity } from './store-entry-entity'

const storeEntryRepo = repoFactory<StoreEntry>(StoreEntryEntity)

export const storeEntryService = {
    async upsert({ projectId, request }: { projectId: ProjectId, request: PutStoreEntryRequest }): Promise<StoreEntry | null> {
        const value = sanitizeObjectForPostgresql(request.value)
        // TypeORM's `upsert()` puts every column we supply that is not part of the conflict target
        // into `ON CONFLICT ... DO UPDATE SET`, so supplying `id` would rewrite the primary key on
        // every overwrite. The insert is built directly with an explicit overwrite list so only
        // `value` changes (`updated` is appended to the set clause by TypeORM itself). The row is
        // then read back, because `InsertResult.identifiers` echoes the `id` generated for this
        // call rather than the one already stored for an existing key.
        await storeEntryRepo()
            .createQueryBuilder()
            .insert()
            .values({
                id: apId(),
                key: request.key,
                value,
                projectId,
            })
            .orUpdate(['value'], ['projectId', 'key'])
            .execute()

        return storeEntryRepo().findOneBy({
            projectId,
            key: request.key,
        })
    },
    async getOne({
        projectId,
        key,
    }: {
        projectId: ProjectId
        key: string
    }): Promise<StoreEntry | null> {
        return storeEntryRepo().findOneBy({
            projectId,
            key,
        })
    },
    async delete({
        projectId,
        key,
    }: {
        projectId: ProjectId
        key: string
    }): Promise<void> {
        await storeEntryRepo().delete({
            projectId,
            key,
        })
    },
}