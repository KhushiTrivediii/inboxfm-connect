#!/usr/bin/env node

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'framework', 'common']);

const findAllPieceFolders = (folderPath) => {
  if (!fs.existsSync(folderPath)) {
    throw new Error(`❌ Directory not found: "${folderPath}". Expected pieces at packages/integrations.`);
  }
  const results = [];
  for (const entry of fs.readdirSync(folderPath)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = path.join(folderPath, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    if (fs.existsSync(path.join(full, 'package.json'))) {
      results.push(full);
    } else {
      results.push(...findAllPieceFolders(full));
    }
  }
  return results;
};

const parseDevPieces = (rawDevPieces) => {
  if (typeof rawDevPieces !== 'string') {
    return [];
  }
  const trimmed = rawDevPieces.trim();
  if (!trimmed) {
    return [];
  }
  return [...new Set(trimmed.split(',').map(n => n.trim()).filter(Boolean))];
};

const resolvePieceFilters = (pieceNames, allFolders) => {
  if (!Array.isArray(pieceNames) || pieceNames.length === 0) {
    return [];
  }
  return pieceNames.map(name => {
    const dir = allFolders.find(p => {
      const normalized = path.normalize(p);
      return normalized.endsWith(path.sep + name);
    });
    if (!dir) {
      throw new Error(`❌ Piece folder not found for: "${name}".`);
    }
    const packageJsonPath = path.join(dir, 'package.json');
    const packageName = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).name;
    return `--filter=${packageName}`;
  });
};

const run = () => {
  // Check Node.js version
  const nodeVersion = execSync('node --version').toString().trim();
  const requiredVersions = ['v18', 'v22', 'v24'];

  // Check operating system
  const os = process.platform;
  console.log(`Running on ${os} operating system.`);

  if (requiredVersions.some(version => nodeVersion.startsWith(version))) {
    console.log(`Node.js version is compatible ${nodeVersion}.`);
  } else {
    console.log(`Node.js version is not compatible. Required version: ${requiredVersions.toString()}`);
    process.exit(1);
  }

  try {
    // Try to get bun version to check if installed
    execSync('bun --version', { stdio: 'ignore' });
    console.log('✅ Bun is already installed.');
  } catch {
    console.log('⚙️ Bun not found. Installing globally...');
    try {
      execSync('npm install -g bun', { stdio: 'inherit' });
      console.log('✅ Bun installed successfully.');
    } catch (err) {
      console.error('❌ Failed to install Bun:', err.message);
      process.exit(1);
    }
  }

  execSync('bun install --frozen-lockfile', {
    stdio: 'inherit',
    env: { ...process.env, REDISMS_VERSION: process.env.REDISMS_VERSION || '7.4.0' },
  });

  // Pre-build dev pieces so dist/ exists before the server starts
  const dotenv = require('dotenv');
  let envConfig = {};
  try {
    envConfig = dotenv.parse(fs.readFileSync('.env.dev', 'utf-8'));
  } catch { }

  const rawDevPieces = process.env.AP_DEV_PIECES || envConfig.AP_DEV_PIECES;
  const pieceNames = parseDevPieces(rawDevPieces);

  if (pieceNames.length > 0) {
    const integrationsPath = path.resolve('packages', 'integrations');
    const allFolders = findAllPieceFolders(integrationsPath);
    const pieceFilters = resolvePieceFilters(pieceNames, allFolders);

    if (pieceFilters.length > 0) {
      console.log(`Building dev pieces: ${pieceNames.join(', ')}`);
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      execFileSync(npxCmd, ['turbo', 'run', 'build', ...pieceFilters], { stdio: 'inherit' });
    }
  }
};

module.exports = {
  IGNORED_DIRS,
  findAllPieceFolders,
  parseDevPieces,
  resolvePieceFilters,
  run,
};

if (require.main === module) {
  run();
}
