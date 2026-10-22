import { apId } from '@inboxfm-connect/core-utils'
import { FilesService } from '@inboxfm-connect/pieces-framework'
import { FileSizeError, FileType } from '@inboxfm-connect/shared'
import { engineFileApi } from '../api/engine-file-api'
import { parseNumberEnv } from '../helper/logging-utils'

// Matches the API's default for AppSystemProp.MAX_FILE_SIZE_MB so a shared
// deployment environment behaves the same on both sides. Without this, an
// unset or non-numeric AP_MAX_FILE_SIZE_MB yields NaN, every size comparison
// is false, and the engine-side upload cap is silently disabled.
const DEFAULT_MAX_FILE_SIZE_MB = 25

export function createFileUploader({ engineToken, apiUrl }: CreateFileUploaderParams): FilesService {
    const maxFileSizeMb = parseNumberEnv(process.env.AP_MAX_FILE_SIZE_MB, DEFAULT_MAX_FILE_SIZE_MB)
    return {
        write: async ({ fileName, data }: { fileName: string, data: Buffer }): Promise<string> => {
            if (!Buffer.isBuffer(data)) {
                throw new Error(
                    `Expected file data to be a Buffer, but received ${typeof data === 'object' ? Object.prototype.toString.call(data) : typeof data}`,
                )
            }
            validateFileSize(data, maxFileSizeMb)
            const { readUrl } = await engineFileApi.upload({
                engineToken,
                apiUrl,
                fileId: apId(),
                type: FileType.FLOW_STEP_FILE,
                fileName,
                data,
            })
            return readUrl
        },
    }
}

function validateFileSize(data: Buffer, maxFileSizeMb: number): void {
    const maximumFileSizeInBytes = maxFileSizeMb * 1024 * 1024
    if (data.length > maximumFileSizeInBytes) {
        throw new FileSizeError(data.length / 1024 / 1024, maxFileSizeMb)
    }
}

type CreateFileUploaderParams = {
    apiUrl: string
    engineToken: string
}
