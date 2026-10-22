import { randomBytes } from 'crypto'
import { promisify } from 'util'
import { ActivepiecesError, ErrorCode, isNil, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { Mutex } from 'async-mutex'
import jwtLibrary, {
    DecodeOptions,
    SignOptions,
    VerifyOptions,
} from 'jsonwebtoken'
import { RedisType } from '../database/redis/types'
import { redisConnections } from '../database/redis-connections'
import { localFileStore } from './local-store'
import { system } from './system/system'
import { AppSystemProp } from './system/system-props'

export enum JwtSignAlgorithm {
    HS256 = 'HS256',
    RS256 = 'RS256',
}

export enum JwtAudience {
    FLOW_RUN_LOG = 'FLOW_RUN_LOG',
    USER_INVITATION = 'USER_INVITATION',
    MCP_OAUTH_ACCESS = 'MCP_OAUTH_ACCESS',
    MCP_OAUTH_AUTH_REQUEST = 'MCP_OAUTH_AUTH_REQUEST',
    FILE_READ = 'FILE_READ',
    CONNECT_EXTERNAL_MCP = 'CONNECT_EXTERNAL_MCP',
}

const ONE_WEEK = 7 * 24 * 3600
const KEY_ID = '1'
// Legacy issuer inherited from upstream. Verification keeps accepting it during
// the rebrand migration window so tokens minted before an issuer change (the
// 100-year AP_WORKER_TOKENs, user sessions, signed file tokens) do not brick
// on upgrade — see issue #373. The window closes automatically once the
// configured issuer equals the legacy one.
const LEGACY_ISSUER = 'activepieces'
const ALGORITHM = JwtSignAlgorithm.HS256

// AP_JWT_ISSUER picks the issuer for NEW tokens. Default is the legacy value,
// so nothing changes until an operator opts in.
const getIssuer = (): string => {
    return system.get(AppSystemProp.JWT_ISSUER) ?? LEGACY_ISSUER
}

// Verification accepts the configured issuer plus the legacy issuer while the
// two differ — the dual-issuer migration window from #373. When they match the
// set collapses to a single value, closing the window.
const getVerifyIssuers = (): string[] => {
    const configured = getIssuer()
    return configured === LEGACY_ISSUER ? [LEGACY_ISSUER] : [configured, LEGACY_ISSUER]
}

const redisType = redisConnections.getRedisType()

export const jwtUtils = {
    async sign({
        payload,
        key,
        expiresInSeconds = ONE_WEEK,
        keyId = KEY_ID,
        algorithm = ALGORITHM,
        audience,
        issuer,
    }: SignParams): Promise<string> {
        const signOptions: SignOptions = {
            algorithm,
            keyid: keyId,
            expiresIn: expiresInSeconds,
            issuer: issuer ?? getIssuer(),
            ...spreadIfDefined('audience', audience),
        }
        return new Promise((resolve, reject) => {
            jwtLibrary.sign(payload, key, signOptions, (err, token) => {
                if (err) {
                    return reject(err)
                }

                if (isNil(token)) {
                    return reject(
                        new ActivepiecesError({
                            code: ErrorCode.INVALID_BEARER_TOKEN,
                            params: {},
                        }),
                    )
                }

                return resolve(token)
            })
        })
    },
    getJwtSecret: async (): Promise<string> => {
        const secret = system.get(AppSystemProp.JWT_SECRET) ?? null
        if (!isNil(secret)) {
            return secret
        }
        if (redisType === RedisType.MEMORY) {
            return getOrGenerateAndStoreSecret()
        }
        throw new ActivepiecesError(
            {
                code: ErrorCode.SYSTEM_PROP_INVALID,
                params: {
                    prop: AppSystemProp.JWT_SECRET,
                },
            },
            `System property AP_${AppSystemProp.JWT_SECRET} must be defined`,
        )
    },
    async decodeAndVerify<T>({ jwt, key, algorithm = ALGORITHM, issuer = getVerifyIssuers(), audience }: VerifyParams): Promise<T> {
        const verifyOptions: VerifyOptions = {
            algorithms: [algorithm],
            ...spreadIfDefined('issuer', issuer),
            ...spreadIfDefined('audience', audience),
        }

        return new Promise((resolve, reject) => {
            jwtLibrary.verify(jwt, key, verifyOptions, async (err, payload) => {
                if (err) {
                    return reject(err)
                }
                return resolve(payload as T)
            })
        })
    },

    decode<T>({ jwt }: DecodeParams): DecodedJwt<T> {
        const decodeOptions: DecodeOptions = {
            complete: true,
        }

        return jwtLibrary.decode(jwt, decodeOptions) as DecodedJwt<T>
    },
}

const mutexLock = new Mutex()

const getOrGenerateAndStoreSecret = async (): Promise<string> => {
    return mutexLock.runExclusive(async () => {
        const currentSecret = await localFileStore.load(AppSystemProp.JWT_SECRET)
        if (!isNil(currentSecret)) {
            return currentSecret
        }
        const secretLengthInBytes = 32
        const secretBuffer = await promisify(randomBytes)(secretLengthInBytes)
        const secret = secretBuffer.toString('base64')
        await localFileStore.save(AppSystemProp.JWT_SECRET, secret)
        return secret
    })
}

type SignParams = {
    payload: Record<string, unknown>
    key: string
    expiresInSeconds?: number
    algorithm?: JwtSignAlgorithm
    keyId?: string
    audience?: JwtAudience
    issuer?: string
}

type VerifyParams = {
    jwt: string
    key: string
    algorithm?: JwtSignAlgorithm
    issuer?: string | string[] | null
    audience?: JwtAudience | string
}

type DecodeParams = {
    jwt: string
}

type DecodedJwt<T> = {
    header: {
        alg: string
        typ: string
        kid: string
    }
    payload: T
    signature: string
}
