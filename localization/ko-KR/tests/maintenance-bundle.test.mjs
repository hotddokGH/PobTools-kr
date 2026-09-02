import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  copyVerifiedMaintenanceBundle,
  createMaintenanceBundle,
  verifyMaintenanceBundle,
} from '../lib/maintenance-bundle.mjs';

const manifestName = 'maintenance-bundle-manifest.json';

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pobtools-maintenance-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  write(join(sourceRoot, 'reports', 'maintenance', 'upstream-update.json'), '{"classification":"ready"}\n');
  write(join(sourceRoot, 'localization', 'ko-KR', 'source-translation-suggestions.json'), '{"rows":[]}\n');
  write(join(sourceRoot, 'pob-zh-engine', 'dist', 'Data', 'launcher', 'ko-KR', 'launcher.json'), '{"hello":"안녕"}\n');
  write(join(sourceRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR', 'ui.json'), '{"entries":{}}\n');
  write(join(sourceRoot, 'reports', 'display-closure', 'summary.json'), '{}\n');
  write(join(sourceRoot, 'reports', 'official-terms', 'summary.json'), '{}\n');
  return { root, sourceRoot, bundleRoot: join(root, 'bundle'), destinationRoot: join(root, 'destination') };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function readManifest(bundleRoot) {
  return JSON.parse(readFileSync(join(bundleRoot, manifestName), 'utf8'));
}

test('creates a deterministic sorted data-only bundle and reproduces it across roots', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  createMaintenanceBundle({ sourceRoot: first.sourceRoot, bundleRoot: first.bundleRoot });
  createMaintenanceBundle({ sourceRoot: second.sourceRoot, bundleRoot: second.bundleRoot });
  const manifest = readManifest(first.bundleRoot);
  assert.deepEqual(manifest, readManifest(second.bundleRoot));
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'files']);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.files.map((row) => row.path), [...manifest.files.map((row) => row.path)].sort());
  assert.equal(new Set(manifest.files.map((row) => row.path)).size, manifest.files.length);
  for (const row of manifest.files) {
    assert.deepEqual(Object.keys(row), ['path', 'sha256', 'size']);
    const bytes = readFileSync(join(first.bundleRoot, 'payload', ...row.path.split('/')));
    assert.equal(row.sha256, sha256(bytes));
    assert.equal(row.size, bytes.length);
  }
  assert.deepEqual(verifyMaintenanceBundle({ bundleRoot: first.bundleRoot }), manifest);
});

test('stages a fully verified bundle before copying only allowlisted files to a destination', (t) => {
  const item = fixture(t);
  const stagingRoot = join(item.root, 'verified-staging');
  createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot });
  const manifest = verifyMaintenanceBundle({ bundleRoot: item.bundleRoot, stagingRoot });
  assert.deepEqual(readManifest(stagingRoot), manifest);
  copyVerifiedMaintenanceBundle({ stagingRoot, destinationRoot: item.destinationRoot });
  for (const row of manifest.files) {
    assert.deepEqual(
      readFileSync(join(item.destinationRoot, ...row.path.split('/'))),
      readFileSync(join(item.sourceRoot, ...row.path.split('/'))),
    );
  }
  assert.equal(existsSync(join(item.destinationRoot, '.github')), false);
});

test('rejects malformed, traversal, absolute, backslash, duplicate, colliding, unlisted, missing, extra, and damaged bundles', (t) => {
  const attacks = [
    ['unknown manifest key', (manifest) => { manifest.unknown = true; }],
    ['traversal', (manifest) => { manifest.files[0].path = '../outside'; }],
    ['absolute', (manifest) => { manifest.files[0].path = '/outside'; }],
    ['drive path', (manifest) => { manifest.files[0].path = 'C:/outside'; }],
    ['UNC path', (manifest) => { manifest.files[0].path = '//server/share'; }],
    ['backslash', (manifest) => { manifest.files[0].path = 'reports\\maintenance\\upstream-update.json'; }],
    ['control character', (manifest) => { manifest.files[0].path = 'reports/maintenance/bad\nfile.json'; }],
    ['empty segment', (manifest) => { manifest.files[0].path = 'reports//maintenance/x.json'; }],
    ['dot segment', (manifest) => { manifest.files[0].path = 'reports/./maintenance/x.json'; }],
    ['duplicate', (manifest) => { manifest.files.push({ ...manifest.files[0] }); }],
    ['case-fold collision', (manifest) => { manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.toUpperCase() }); }],
    ['unlisted', (manifest) => { manifest.files[0].path = '.github/workflows/pwn.yml'; }],
    ['bad hash', (manifest) => { manifest.files[0].sha256 = '0'.repeat(64); }],
    ['bad size', (manifest) => { manifest.files[0].size += 1; }],
  ];
  for (const [name, mutate] of attacks) {
    const item = fixture(t);
    createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot });
    const manifest = readManifest(item.bundleRoot);
    mutate(manifest);
    writeFileSync(join(item.bundleRoot, manifestName), `${JSON.stringify(manifest)}\n`);
    assert.throws(() => verifyMaintenanceBundle({ bundleRoot: item.bundleRoot }), { name: 'Error' }, name);
  }

  for (const name of ['missing', 'extra', 'damaged']) {
    const item = fixture(t);
    createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot });
    const path = join(item.bundleRoot, 'payload', 'reports', 'maintenance', 'upstream-update.json');
    if (name === 'missing') rmSync(path);
    if (name === 'extra') write(join(item.bundleRoot, 'payload', 'reports', 'maintenance', 'extra.json'), '{}');
    if (name === 'damaged') write(path, 'changed');
    assert.throws(() => verifyMaintenanceBundle({ bundleRoot: item.bundleRoot }), { name: 'Error' }, name);
  }
});

test('rejects source and payload links or non-regular entries', (t) => {
  const source = fixture(t);
  const external = join(source.root, 'external');
  mkdirSync(external);
  symlinkSync(external, join(source.sourceRoot, 'reports', 'official-terms', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createMaintenanceBundle({ sourceRoot: source.sourceRoot, bundleRoot: source.bundleRoot }), { name: 'Error' });

  const payload = fixture(t);
  createMaintenanceBundle({ sourceRoot: payload.sourceRoot, bundleRoot: payload.bundleRoot });
  const payloadPath = join(payload.bundleRoot, 'payload', 'reports', 'maintenance');
  rmSync(payloadPath, { recursive: true });
  symlinkSync(join(payload.sourceRoot, 'reports', 'maintenance'), payloadPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyMaintenanceBundle({ bundleRoot: payload.bundleRoot }), { name: 'Error' });
});

test('any failed verification leaves destination bytes unchanged and rejects destination reparse ancestors', (t) => {
  const damaged = fixture(t);
  createMaintenanceBundle({ sourceRoot: damaged.sourceRoot, bundleRoot: damaged.bundleRoot });
  const stagingRoot = join(damaged.root, 'staging');
  verifyMaintenanceBundle({ bundleRoot: damaged.bundleRoot, stagingRoot });
  write(join(damaged.destinationRoot, 'sentinel.txt'), 'unchanged');
  write(join(stagingRoot, 'payload', 'reports', 'maintenance', 'upstream-update.json'), 'tampered');
  assert.throws(() => copyVerifiedMaintenanceBundle({ stagingRoot, destinationRoot: damaged.destinationRoot }), { name: 'Error' });
  assert.equal(readFileSync(join(damaged.destinationRoot, 'sentinel.txt'), 'utf8'), 'unchanged');
  assert.equal(existsSync(join(damaged.destinationRoot, 'reports')), false);

  const redirected = fixture(t);
  createMaintenanceBundle({ sourceRoot: redirected.sourceRoot, bundleRoot: redirected.bundleRoot });
  const redirectedStaging = join(redirected.root, 'staging');
  verifyMaintenanceBundle({ bundleRoot: redirected.bundleRoot, stagingRoot: redirectedStaging });
  const outside = join(redirected.root, 'outside');
  mkdirSync(outside);
  mkdirSync(redirected.destinationRoot);
  symlinkSync(outside, join(redirected.destinationRoot, 'reports'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyVerifiedMaintenanceBundle({ stagingRoot: redirectedStaging, destinationRoot: redirected.destinationRoot }), { name: 'Error' });
  assert.deepEqual(existsSync(join(outside, 'maintenance', 'upstream-update.json')), false);
});

test('rejects non-empty output directories instead of overwriting existing bundle or staging data', (t) => {
  const item = fixture(t);
  mkdirSync(item.bundleRoot);
  write(join(item.bundleRoot, 'keep.txt'), 'keep');
  assert.throws(() => createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot }), { name: 'Error' });
  assert.equal(readFileSync(join(item.bundleRoot, 'keep.txt'), 'utf8'), 'keep');

  const cleanBundle = join(item.root, 'clean-bundle');
  createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: cleanBundle });
  const staging = join(item.root, 'staging');
  cpSync(cleanBundle, staging, { recursive: true });
  write(join(staging, 'keep.txt'), 'keep');
  assert.throws(() => verifyMaintenanceBundle({ bundleRoot: cleanBundle, stagingRoot: staging }), { name: 'Error' });
});
