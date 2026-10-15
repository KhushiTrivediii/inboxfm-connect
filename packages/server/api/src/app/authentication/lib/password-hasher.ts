import { ActivepiecesError, assertNotNullOrUndefined, ErrorCode } from '@inboxfm-connect/core-utils'
import bcrypt from 'bcrypt'
import { FirebaseScrypt, FirebaseScryptOptions } from 'firebase-scrypt'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
const SALT_ROUNDS = 10
const SCRYPT_SEPARATOR = '~'

export const passwordHasher = {
    hash: async (plainTextPassword: string): Promise<string> => {
        return bcrypt.hash(plainTextPassword, SALT_ROUNDS)
    },

    compare: async (
        plainTextPassword: string,
        hashedPassword: string,
    ): Promise<boolean> => {
        assertNotNullOrUndefined(plainTextPassword, 'plainTextPassword')
        assertNotNullOrUndefined(hashedPassword, 'hashedPassword')
        if (isBcryptHash(hashedPassword)) {
            return bcrypt.compare(plainTextPassword, hashedPassword)
        }
        if (isScrypt(hashedPassword)) {
            const salt = hashedPassword.split(SCRYPT_SEPARATOR)[1]
            const rawHashedPassword = hashedPassword
                .split(SCRYPT_SEPARATOR)[0]
                .substring('$scrypt$'.length)
            return compareScrypt(plainTextPassword, salt, rawHashedPassword)
        }
        return false
    },
}

async function compareScrypt(
    password: string,
    salt: string,
    hashedPassword: string,
): Promise<boolean> {
    // FIREBASE_HASH_PARAMETERS is operator-supplied env config parsed on the
    // legacy-scrypt sign-in path — a malformed value must surface as a
    // named configuration error, not a raw SyntaxError 500.
    const firebaseHashParameters = system.getOrThrow(AppSystemProp.FIREBASE_HASH_PARAMETERS)
    let firebaseParameter: FirebaseScryptOptions
    try {
        firebaseParameter = JSON.parse(firebaseHashParameters)
    }
    catch (error) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: `AP_FIREBASE_HASH_PARAMETERS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            },
        })
    }
    const firebaseScrypt = new FirebaseScrypt(firebaseParameter)
    return firebaseScrypt.verify(password, salt, hashedPassword)
}

function isBcryptHash(hash: string): boolean {
    return hash.startsWith('$2')
}

function isScrypt(hash: string): boolean {
    return hash.startsWith('$scrypt$')
}
