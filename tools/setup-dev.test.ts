import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const {
  findAllPieceFolders,
  parseDevPieces,
  resolvePieceFilters,
} = require('./setup-dev');

describe('setup-dev', () => {
  describe('parseDevPieces', () => {
    it('1. AP_DEV_PIECES unset -> skips piece build, returns empty array without throwing', () => {
      expect(parseDevPieces(undefined)).toEqual([]);
      expect(parseDevPieces(null)).toEqual([]);
      expect(parseDevPieces('')).toEqual([]);
    });

    it('2. valid list (google-sheets,store) -> returns parsed piece names', () => {
      expect(parseDevPieces('google-sheets,store')).toEqual(['google-sheets', 'store']);
      expect(parseDevPieces('google-sheets, store')).toEqual(['google-sheets', 'store']);
    });

    it('3. whitespace-only (" ") -> graceful skip (regression test: previously crashed)', () => {
      expect(parseDevPieces('   ')).toEqual([]);
      expect(parseDevPieces('\t  \n')).toEqual([]);
    });

    it('4. empty segments ("a,,b") -> filtered out and deduplicated', () => {
      expect(parseDevPieces('a,,b')).toEqual(['a', 'b']);
      expect(parseDevPieces('a, ,b,  ')).toEqual(['a', 'b']);
      expect(parseDevPieces('a,b,a')).toEqual(['a', 'b']);
    });
  });

  describe('findAllPieceFolders', () => {
    it('5. missing packages/integrations dir -> throws friendly error, not raw ENOENT', () => {
      const nonExistentPath = path.resolve('packages', 'non_existent_integrations_folder_xyz');
      expect(() => findAllPieceFolders(nonExistentPath)).toThrowError(
        `Directory not found: "${nonExistentPath}". Expected pieces at packages/integrations.`
      );
    });

    it('discovers valid piece folders while skipping ignored dirs', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dev-test-'));
      try {
        fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'package.json'), '{}');
        fs.mkdirSync(path.join(tmpDir, 'framework', 'bar'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'framework', 'bar', 'package.json'), '{}');
        fs.mkdirSync(path.join(tmpDir, 'community', 'sample-piece'), { recursive: true });
        fs.writeFileSync(
          path.join(tmpDir, 'community', 'sample-piece', 'package.json'),
          JSON.stringify({ name: '@inboxfm-connect/piece-sample' })
        );

        const folders = findAllPieceFolders(tmpDir);
        expect(folders).toHaveLength(1);
        expect(folders[0]).toBe(path.join(tmpDir, 'community', 'sample-piece'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('resolvePieceFilters', () => {
    it('returns empty array when names list is empty', () => {
      expect(resolvePieceFilters([], [])).toEqual([]);
    });

    it('resolves valid pieces to turbo filter flags', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-filter-test-'));
      try {
        const sheetsDir = path.join(tmpDir, 'community', 'google-sheets');
        const storeDir = path.join(tmpDir, 'core', 'store');
        fs.mkdirSync(sheetsDir, { recursive: true });
        fs.writeFileSync(
          path.join(sheetsDir, 'package.json'),
          JSON.stringify({ name: '@inboxfm-connect/piece-google-sheets' })
        );
        fs.mkdirSync(storeDir, { recursive: true });
        fs.writeFileSync(
          path.join(storeDir, 'package.json'),
          JSON.stringify({ name: '@inboxfm-connect/piece-store' })
        );

        const folders = [sheetsDir, storeDir];
        const filters = resolvePieceFilters(['google-sheets', 'store'], folders);
        expect(filters).toEqual([
          '--filter=@inboxfm-connect/piece-google-sheets',
          '--filter=@inboxfm-connect/piece-store',
        ]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('6. unknown piece name -> throws Piece folder not found error', () => {
      const folders = ['/mock/packages/integrations/community/google-sheets'];
      expect(() => resolvePieceFilters(['unknown-piece'], folders)).toThrowError(
        'Piece folder not found for: "unknown-piece".'
      );
    });
  });
});
