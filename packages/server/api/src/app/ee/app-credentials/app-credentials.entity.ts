import { AppCredential, Project } from '@inboxfm-connect/shared'
import { EntitySchema } from 'typeorm'
import {
    ApIdSchema,
    BaseColumnSchemaPart,
} from '../../database/database-common'
import { EncryptedObject } from '../../helper/encryption'

// Settings carry the OAuth2 clientSecret, so they are stored encrypted at
// rest (encryptUtils.encryptObject — same at-rest policy as app-connection
// values). Rows written before encryption shipped keep the plaintext
// settings object in this column; read paths shape-discriminate and decrypt
// (see app-credentials.service.ts).
export type AppCredentialSchema = Omit<AppCredential, 'settings'> & {
    project: Project[]
    settings: EncryptedObject | AppCredential['settings']
}

export const AppCredentialEntity = new EntitySchema<AppCredentialSchema>({
    name: 'app_credential',
    columns: {
        ...BaseColumnSchemaPart,
        appName: {
            type: String,
        },
        projectId: ApIdSchema,
        settings: {
            type: 'jsonb',
        },
    },
    indices: [],
    relations: {
        project: {
            type: 'many-to-one',
            target: 'project',
            onDelete: 'CASCADE',
            joinColumn: true,
            inverseSide: 'appCredentials',
        },
    },
})
