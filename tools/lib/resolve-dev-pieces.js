const fs = require('fs');
const path = require('path');

/**
 * Resolve the integrations catalog directory used for dev-piece discovery.
 * Returns undefined when no dev pieces are requested (discovery skipped).
 * Throws a clear, actionable error naming the resolved path and the current
 * AP_DEV_PIECES value instead of the raw ENOENT readdirSync would produce.
 */
function resolveIntegrationsDir({ cwd, devPieces }) {
  if (!devPieces) {
    return undefined;
  }
  const integrationsDir = path.resolve(cwd, 'packages', 'integrations');
  // Single stat call (no existsSync/statSync pair): atomic for our purposes
  // and collapses the missing-path and not-a-directory cases.
  const stats = fs.statSync(integrationsDir, { throwIfNoEntry: false });
  if (!stats || !stats.isDirectory()) {
    throw new Error(`❌ Integrations directory not found at "${integrationsDir}". Cannot resolve AP_DEV_PIECES="${devPieces}".`);
  }
  return integrationsDir;
}

module.exports = { resolveIntegrationsDir };
