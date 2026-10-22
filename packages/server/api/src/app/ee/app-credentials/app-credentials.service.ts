import { apId, Cursor, isNil, ProjectId, SeekPage } from '@inboxfm-connect/core-utils'
import { AppCredential, AppCredentialId, UpsertAppCredentialRequest } from '@inboxfm-connect/shared'
import { repoFactory } from '../../core/db/repo-factory'
import { EncryptedObject, encryptUtils } from '../../helper/encryption'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { AppCredentialEntity, AppCredentialSchema } from './app-credentials.entity'

export const appCredentialRepo = repoFactory(AppCredentialEntity)

// Settings carry live OAuth2 client secrets, so they are encrypted at rest
// with encryptUtils.encryptObject — the same at-rest policy app-connection
// values follow. Rows written before this shipped store the plaintext
// settings object, so reads shape-discriminate instead of blind-decrypting:
// a value matching the EncryptedObject {iv, data} envelope is ciphertext and
// gets decrypted; anything else is a legacy plaintext row and is returned
// as-is. Neither AppOAuth2Settings nor AppApiKeySettings can be mistaken
// for the envelope (neither has iv/data fields), so the fallback is
// unambiguous. Writes always encrypt, so plaintext rows only survive until
// their next upsert — no data migration needed.
const decryptSettings = async (
    stored: AppCredentialSchema['settings'],
): Promise<AppCredential['settings']> => {
    const parsed = EncryptedObject.safeParse(stored)
    if (parsed.success) {
        return encryptUtils.decryptObject<AppCredential['settings']>(parsed.data)
    }
    // safeParse rejected the {iv, data} envelope, so this is a legacy
    // plaintext row — return it as-is.
    return stored as AppCredential['settings']
}

export const appCredentialService = {
    async list(
        projectId: ProjectId,
        appName: string | undefined,
        cursorRequest: Cursor | null,
        limit: number,
    ): Promise<SeekPage<AppCredential>> {
        const decodedCursor = paginationHelper.decodeCursor(cursorRequest ?? null)
        const paginator = buildPaginator({
            entity: AppCredentialEntity,
            query: {
                limit,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        let queryBuilder = appCredentialRepo()
            .createQueryBuilder('app_credential')
            .where({ projectId })
        if (appName !== undefined) {
            // Issue #415: TypeORM's second .where() RESETS expressionMap.wheres
            // (SelectQueryBuilder.js:341), which dropped the projectId scoping and
            // listed every tenant's rows. Compose instead of replace.
            queryBuilder = queryBuilder.andWhere({ appName })
        }
        const { data, cursor } = await paginator.paginate(queryBuilder)
        const decrypted = await Promise.all(data.map(async (stored) => ({
            ...stored,
            settings: await decryptSettings(stored.settings),
        })))
        return paginationHelper.createPage<AppCredential>(decrypted, cursor)
    },
    async getOneOrThrow(id: AppCredentialId): Promise<AppCredential> {
        const stored = await appCredentialRepo().findOneByOrFail({ id })
        return {
            ...stored,
            settings: await decryptSettings(stored.settings),
        }
    },
    async upsert({
        projectId,
        request,
    }: {
        projectId: ProjectId
        request: UpsertAppCredentialRequest
    }): Promise<AppCredential | null> {
        const newId = request.id ?? apId()
        await appCredentialRepo().upsert(
            {
                id: newId,
                ...request,
                // Always encrypt on write — the clientSecret must never hit
                // the jsonb column in plaintext (see decryptSettings for how
                // pre-encryption rows are still read).
                settings: await encryptUtils.encryptObject(request.settings),
                projectId,
            },
            ['id'],
        )
        const stored = await appCredentialRepo().findOneBy({ projectId, appName: request.appName })
        return isNil(stored) ? null : {
            ...stored,
            settings: await decryptSettings(stored.settings),
        }
    },
    async delete({ id, projectId }: DeleteParams): Promise<void> {
        await appCredentialRepo().delete({
            id,
            projectId,
        })
    },
}

type DeleteParams = {
    id: AppCredentialId
    projectId: ProjectId
}
