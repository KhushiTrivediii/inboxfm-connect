import semverMajor from 'semver/functions/major'
import semverMinor from 'semver/functions/minor'
import semverMinVersion from 'semver/ranges/min-version'

/**
 * Resolves the `major.minor` pair of a piece version. The version may be an
 * exact semver (`1.2.3`) or a range (`^1.2.3`, `~2.5.0`), in which case the
 * minimum satisfying version is used. semver throws a TypeError for anything
 * else (`latest`, branch names, garbage), and the previous fallback branch
 * re-threw on the very inputs it existed for — return the raw tag instead so
 * callers can surface it instead of crashing.
 */
export const getPieceMajorAndMinorVersion = (pieceVersion: string): string => {
    const minimumSemver = tryGetMinimumSemver(pieceVersion)
    return minimumSemver
        ? `${semverMajor(minimumSemver)}.${semverMinor(minimumSemver)}`
        : pieceVersion
}

const tryGetMinimumSemver = (pieceVersion: string): ReturnType<typeof semverMinVersion> => {
    try {
        return semverMinVersion(pieceVersion)
    }
    catch {
        return null
    }
}
