const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const { resolveIntegrationsDir } = require('./resolve-dev-pieces');

const tmpRoots = [];

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-dev-pieces-'));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveIntegrationsDir', () => {
  it('throws with the resolved path and AP_DEV_PIECES value when missing', () => {
    const cwd = makeTmpRoot();
    assert.throws(
      () => resolveIntegrationsDir({ cwd, devPieces: 'google-sheets,store' }),
      (error) => {
        assert.match(String(error.message), /integrations/);
        assert.match(String(error.message), /google-sheets,store/);
        return true;
      },
    );
  });

  it('throws when the path exists but is a regular file', () => {
    const cwd = makeTmpRoot();
    fs.mkdirSync(path.join(cwd, 'packages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'packages', 'integrations'), 'not a dir');
    assert.throws(() => resolveIntegrationsDir({ cwd, devPieces: 'store' }), /Integrations directory not found/);
  });

  it('does not fire when AP_DEV_PIECES is unset', () => {
    const cwd = makeTmpRoot();
    assert.equal(resolveIntegrationsDir({ cwd, devPieces: undefined }), undefined);
    assert.equal(resolveIntegrationsDir({ cwd, devPieces: '' }), undefined);
  });

  it('returns the directory when present', () => {
    const cwd = makeTmpRoot();
    const expected = path.join(cwd, 'packages', 'integrations');
    fs.mkdirSync(expected, { recursive: true });
    assert.equal(resolveIntegrationsDir({ cwd, devPieces: 'store' }), expected);
  });
});
