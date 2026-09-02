import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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

function snapshotTree(root, relativeRoot = '') {
  if (!existsSync(root)) return [];
  const output = [];
  const visit = (absolute, relative) => {
    const metadata = lstatSync(absolute);
    if (metadata.isDirectory()) {
      output.push(['directory', relative]);
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), relative ? `${relative}/${name}` : name);
    } else if (metadata.isFile()) {
      output.push(['file', relative, readFileSync(absolute).toString('base64')]);
    } else if (metadata.isSymbolicLink()) {
      output.push(['link', relative]);
    }
  };
  visit(root, relativeRoot);
  return output;
}

function findTransactionTemporary(destinationRoot, relativePath) {
  const parent = dirname(join(destinationRoot, ...relativePath.split('/')));
  const names = readdirSync(parent).filter((name) => name.includes('.pobtools-') && name.endsWith('.tmp'));
  assert.equal(names.length, 1, `expected one transaction temporary file for ${relativePath}`);
  return join(parent, names[0]);
}

function assertNoTransactionTemporaries(destinationRoot) {
  assert.equal(snapshotTree(destinationRoot).some((row) => String(row[1]).includes('.pobtools-')), false);
}

function prepareUntouchedDestination(item) {
  mkdirSync(item.destinationRoot);
  write(join(item.destinationRoot, 'sentinel.txt'), 'destination-original');
  return snapshotTree(item.destinationRoot);
}

function assertUntouchedDestination(item, before, message) {
  assert.deepEqual(snapshotTree(item.destinationRoot), before, message);
  assertNoTransactionTemporaries(item.destinationRoot);
}

function brokenDirectoryLink(target, path) {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
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
  assert.deepEqual(verifyMaintenanceBundle({ bundleRoot: first.bundleRoot }).manifest, manifest);
});

test('stages a fully verified bundle before copying only allowlisted files to a destination', (t) => {
  const item = fixture(t);
  const stagingRoot = join(item.root, 'verified-staging');
  createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: item.bundleRoot, stagingRoot });
  const { manifest } = verifiedBundle;
  assert.deepEqual(readManifest(stagingRoot), manifest);
  copyVerifiedMaintenanceBundle({ verifiedBundle, destinationRoot: item.destinationRoot });
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

test('broken junctions below optional and exact source paths reject before bundle output', (t) => {
  const attacks = [
    ['optional prefix', (item, missingOutside) => {
      brokenDirectoryLink(missingOutside, join(item.sourceRoot, 'reports', 'display-closure', 'broken'));
    }],
    ['exact path ancestor', (item, missingOutside) => {
      rmSync(join(item.sourceRoot, 'localization'), { recursive: true });
      brokenDirectoryLink(missingOutside, join(item.sourceRoot, 'localization'));
    }],
  ];
  for (const [name, attack] of attacks) {
    const item = fixture(t);
    const before = prepareUntouchedDestination(item);
    const missingOutside = join(item.root, `missing-source-${name.replaceAll(' ', '-')}`);
    attack(item, missingOutside);
    assert.throws(
      () => createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot }),
      /symbolic link, junction, or reparse point/u,
      name,
    );
    assert.equal(existsSync(missingOutside), false, name);
    assert.equal(existsSync(item.bundleRoot), false, name);
    assertUntouchedDestination(item, before, name);
  }
});

test('an extra broken payload junction rejects before staging or destination writes', (t) => {
  const item = fixture(t);
  createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot });
  const missingOutside = join(item.root, 'missing-extra-payload-target');
  const extra = join(item.bundleRoot, 'payload', 'reports', 'display-closure', 'unmanifested');
  brokenDirectoryLink(missingOutside, extra);
  const stagingRoot = join(item.root, 'staging');
  const before = prepareUntouchedDestination(item);
  assert.throws(
    () => verifyMaintenanceBundle({ bundleRoot: item.bundleRoot, stagingRoot }),
    /symbolic link, junction, or reparse point/u,
  );
  assert.equal(existsSync(missingOutside), false);
  assert.equal(existsSync(stagingRoot), false);
  assertUntouchedDestination(item, before);
});

test('broken source, bundle-output, bundle-input, and staging roots are recognized as present reparse entries', (t) => {
  const sourceAttack = fixture(t);
  const sourceBefore = prepareUntouchedDestination(sourceAttack);
  const missingSource = join(sourceAttack.root, 'missing-source-root');
  rmSync(sourceAttack.sourceRoot, { recursive: true });
  brokenDirectoryLink(missingSource, sourceAttack.sourceRoot);
  assert.throws(
    () => createMaintenanceBundle({ sourceRoot: sourceAttack.sourceRoot, bundleRoot: sourceAttack.bundleRoot }),
    /source root must be a regular directory/u,
  );
  assert.equal(existsSync(missingSource), false);
  assert.equal(existsSync(sourceAttack.bundleRoot), false);
  assertUntouchedDestination(sourceAttack, sourceBefore);

  const outputAttack = fixture(t);
  const outputBefore = prepareUntouchedDestination(outputAttack);
  const missingOutput = join(outputAttack.root, 'missing-bundle-output');
  brokenDirectoryLink(missingOutput, outputAttack.bundleRoot);
  assert.throws(
    () => createMaintenanceBundle({ sourceRoot: outputAttack.sourceRoot, bundleRoot: outputAttack.bundleRoot }),
    /bundle root must not exist or must be an empty regular directory/u,
  );
  assert.equal(existsSync(missingOutput), false);
  assert.equal(lstatSync(outputAttack.bundleRoot).isSymbolicLink(), true);
  assertUntouchedDestination(outputAttack, outputBefore);

  const inputAttack = fixture(t);
  const inputBefore = prepareUntouchedDestination(inputAttack);
  createMaintenanceBundle({ sourceRoot: inputAttack.sourceRoot, bundleRoot: inputAttack.bundleRoot });
  rmSync(inputAttack.bundleRoot, { recursive: true });
  const missingInput = join(inputAttack.root, 'missing-bundle-input');
  brokenDirectoryLink(missingInput, inputAttack.bundleRoot);
  const inputStaging = join(inputAttack.root, 'input-staging');
  assert.throws(
    () => verifyMaintenanceBundle({ bundleRoot: inputAttack.bundleRoot, stagingRoot: inputStaging }),
    /bundle root must be a regular directory/u,
  );
  assert.equal(existsSync(missingInput), false);
  assert.equal(existsSync(inputStaging), false);
  assertUntouchedDestination(inputAttack, inputBefore);

  const stagingAttack = fixture(t);
  createMaintenanceBundle({ sourceRoot: stagingAttack.sourceRoot, bundleRoot: stagingAttack.bundleRoot });
  const missingStaging = join(stagingAttack.root, 'missing-staging-root');
  const stagingRoot = join(stagingAttack.root, 'staging');
  brokenDirectoryLink(missingStaging, stagingRoot);
  const before = prepareUntouchedDestination(stagingAttack);
  assert.throws(
    () => verifyMaintenanceBundle({ bundleRoot: stagingAttack.bundleRoot, stagingRoot }),
    /staging root must not exist or must be an empty regular directory/u,
  );
  assert.equal(existsSync(missingStaging), false);
  assert.equal(existsSync(join(stagingRoot, 'payload')), false);
  assertUntouchedDestination(stagingAttack, before);
});

test('broken manifest and manifested payload leaves reject as reparse entries before staging writes', (t) => {
  const attacks = [
    ['manifest', (item, missingOutside) => {
      rmSync(join(item.bundleRoot, manifestName));
      brokenDirectoryLink(missingOutside, join(item.bundleRoot, manifestName));
    }, /bundle manifest must be a regular file/u],
    ['manifested payload', (item, missingOutside) => {
      const target = join(item.bundleRoot, 'payload', 'reports', 'maintenance', 'upstream-update.json');
      rmSync(target);
      brokenDirectoryLink(missingOutside, target);
    }, /symbolic link, junction, or reparse point/u],
  ];
  for (const [name, attack, expected] of attacks) {
    const item = fixture(t);
    createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot });
    const missingOutside = join(item.root, `missing-${name.replaceAll(' ', '-')}`);
    attack(item, missingOutside);
    const stagingRoot = join(item.root, 'staging');
    const before = prepareUntouchedDestination(item);
    assert.throws(() => verifyMaintenanceBundle({ bundleRoot: item.bundleRoot, stagingRoot }), expected, name);
    assert.equal(existsSync(missingOutside), false, name);
    assert.equal(existsSync(stagingRoot), false, name);
    assertUntouchedDestination(item, before, name);
  }
});

test('copy consumes immutable verified bytes even when staged bytes mutate afterward', (t) => {
  const item = fixture(t);
  const stagingRoot = join(item.root, 'staging');
  createMaintenanceBundle({ sourceRoot: item.sourceRoot, bundleRoot: item.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: item.bundleRoot, stagingRoot });
  write(join(stagingRoot, 'payload', 'reports', 'maintenance', 'upstream-update.json'), 'tampered after verification');
  copyVerifiedMaintenanceBundle({ verifiedBundle, destinationRoot: item.destinationRoot });
  assert.equal(
    readFileSync(join(item.destinationRoot, 'reports', 'maintenance', 'upstream-update.json'), 'utf8'),
    '{"classification":"ready"}\n',
  );
});

test('a later replacement failure rolls back every earlier file and created directory', (t) => {
  const damaged = fixture(t);
  createMaintenanceBundle({ sourceRoot: damaged.sourceRoot, bundleRoot: damaged.bundleRoot });
  const stagingRoot = join(damaged.root, 'staging');
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: damaged.bundleRoot, stagingRoot });
  write(join(damaged.destinationRoot, 'sentinel.txt'), 'unchanged');
  write(join(damaged.destinationRoot, 'localization', 'ko-KR', 'source-translation-suggestions.json'), 'pre-existing destination bytes');
  const before = snapshotTree(damaged.destinationRoot);
  let replacements = 0;
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: damaged.destinationRoot,
    operations: {
      beforeReplace() {
        replacements += 1;
        if (replacements === 2) throw new Error('injected later replacement failure');
      },
    },
  }), /injected later replacement failure/u);
  assert.deepEqual(snapshotTree(damaged.destinationRoot), before);
});

test('an ancestor replacement race is caught immediately and leaves destination and external bytes unchanged', (t) => {
  const redirected = fixture(t);
  createMaintenanceBundle({ sourceRoot: redirected.sourceRoot, bundleRoot: redirected.bundleRoot });
  const redirectedStaging = join(redirected.root, 'staging');
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: redirected.bundleRoot, stagingRoot: redirectedStaging });
  const outside = join(redirected.root, 'outside');
  mkdirSync(outside);
  write(join(outside, 'sentinel.txt'), 'external-original');
  mkdirSync(redirected.destinationRoot);
  write(join(redirected.destinationRoot, 'sentinel.txt'), 'destination-original');
  const before = snapshotTree(redirected.destinationRoot);
  let raced = false;
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: redirected.destinationRoot,
    operations: {
      beforeReplace({ relativePath }) {
        if (!raced && relativePath.startsWith('reports/')) {
          raced = true;
          const reports = join(redirected.destinationRoot, 'reports');
          rmSync(reports, { recursive: true, force: true });
          symlinkSync(outside, reports, process.platform === 'win32' ? 'junction' : 'dir');
        }
      },
    },
  }), /bundle transaction/u);
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'external-original');
  assert.equal(existsSync(join(outside, 'maintenance', 'upstream-update.json')), false);
  const reports = join(redirected.destinationRoot, 'reports');
  if (existsSync(reports)) rmSync(reports, { recursive: true, force: true });
  assert.deepEqual(snapshotTree(redirected.destinationRoot), before);
});

test('a matching-byte hard-link substitution is rejected without binding destination to outside bytes', (t) => {
  const attacked = fixture(t);
  createMaintenanceBundle({ sourceRoot: attacked.sourceRoot, bundleRoot: attacked.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: attacked.bundleRoot, stagingRoot: join(attacked.root, 'staging') });
  mkdirSync(attacked.destinationRoot);
  write(join(attacked.destinationRoot, 'sentinel.txt'), 'destination-original');
  const outside = join(attacked.root, 'outside-hard-link.json');
  write(outside, readFileSync(join(attacked.sourceRoot, 'localization', 'ko-KR', 'source-translation-suggestions.json')));
  const before = snapshotTree(attacked.destinationRoot);
  let substituted = false;
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: attacked.destinationRoot,
    operations: {
      beforeReplace({ relativePath }) {
        if (substituted) return;
        substituted = true;
        const temporary = findTransactionTemporary(attacked.destinationRoot, relativePath);
        unlinkSync(temporary);
        linkSync(outside, temporary);
      },
    },
  }), /independent regular file with exactly one hard link/u);
  assert.equal(readFileSync(outside, 'utf8'), '{"rows":[]}\n');
  assert.deepEqual(snapshotTree(attacked.destinationRoot), before);
  assertNoTransactionTemporaries(attacked.destinationRoot);
  write(outside, 'outside mutated after rejected copy');
  assert.deepEqual(snapshotTree(attacked.destinationRoot), before);
});

test('a matching-byte file-symlink substitution is rejected when file symlinks are available', (t) => {
  const attacked = fixture(t);
  const probeTarget = join(attacked.root, 'symlink-probe-target');
  const probeLink = join(attacked.root, 'symlink-probe-link');
  write(probeTarget, 'probe');
  try {
    symlinkSync(probeTarget, probeLink, 'file');
    unlinkSync(probeLink);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`file symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  createMaintenanceBundle({ sourceRoot: attacked.sourceRoot, bundleRoot: attacked.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: attacked.bundleRoot, stagingRoot: join(attacked.root, 'staging') });
  mkdirSync(attacked.destinationRoot);
  write(join(attacked.destinationRoot, 'sentinel.txt'), 'destination-original');
  const outside = join(attacked.root, 'outside-symlink.json');
  write(outside, readFileSync(join(attacked.sourceRoot, 'localization', 'ko-KR', 'source-translation-suggestions.json')));
  const before = snapshotTree(attacked.destinationRoot);
  let substituted = false;
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: attacked.destinationRoot,
    operations: {
      beforeReplace({ relativePath }) {
        if (substituted) return;
        substituted = true;
        const temporary = findTransactionTemporary(attacked.destinationRoot, relativePath);
        unlinkSync(temporary);
        symlinkSync(outside, temporary, 'file');
      },
    },
  }), /independent regular file with exactly one hard link/u);
  assert.equal(readFileSync(outside, 'utf8'), '{"rows":[]}\n');
  assert.deepEqual(snapshotTree(attacked.destinationRoot), before);
  assertNoTransactionTemporaries(attacked.destinationRoot);
  write(outside, 'outside mutated after rejected copy');
  assert.deepEqual(snapshotTree(attacked.destinationRoot), before);
});

test('a partial temporary write failure leaves no destination changes or temporary residue', (t) => {
  const damaged = fixture(t);
  createMaintenanceBundle({ sourceRoot: damaged.sourceRoot, bundleRoot: damaged.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: damaged.bundleRoot, stagingRoot: join(damaged.root, 'staging') });
  mkdirSync(damaged.destinationRoot);
  write(join(damaged.destinationRoot, 'sentinel.txt'), 'destination-original');
  const before = snapshotTree(damaged.destinationRoot);
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: damaged.destinationRoot,
    operations: {
      writeTemporary({ temporaryPath, bytes }) {
        writeFileSync(temporaryPath, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        throw new Error('injected partial temporary write failure');
      },
    },
  }), /injected partial temporary write failure/u);
  assert.deepEqual(snapshotTree(damaged.destinationRoot), before);
  assertNoTransactionTemporaries(damaged.destinationRoot);
});

test('a broken junction substituted for a verified temporary is removed without residue or traversal', (t) => {
  const attacked = fixture(t);
  createMaintenanceBundle({ sourceRoot: attacked.sourceRoot, bundleRoot: attacked.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: attacked.bundleRoot, stagingRoot: join(attacked.root, 'staging') });
  mkdirSync(attacked.destinationRoot);
  write(join(attacked.destinationRoot, 'sentinel.txt'), 'destination-original');
  const before = snapshotTree(attacked.destinationRoot);
  const missingOutside = join(attacked.root, 'missing-outside-directory');
  let substituted = false;
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: attacked.destinationRoot,
    operations: {
      beforeReplace({ relativePath }) {
        if (substituted) return;
        substituted = true;
        const temporary = findTransactionTemporary(attacked.destinationRoot, relativePath);
        unlinkSync(temporary);
        brokenDirectoryLink(missingOutside, temporary);
      },
    },
  }));
  assert.equal(existsSync(missingOutside), false);
  assert.deepEqual(snapshotTree(attacked.destinationRoot), before);
  assertNoTransactionTemporaries(attacked.destinationRoot);
});

test('a broken junction occupying the first temporary name is treated as a collision without traversal', (t) => {
  const attacked = fixture(t);
  createMaintenanceBundle({ sourceRoot: attacked.sourceRoot, bundleRoot: attacked.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: attacked.bundleRoot, stagingRoot: join(attacked.root, 'staging') });
  const firstRelative = 'localization/ko-KR/source-translation-suggestions.json';
  const parent = dirname(join(attacked.destinationRoot, ...firstRelative.split('/')));
  mkdirSync(parent, { recursive: true });
  const collision = join(parent, `.source-translation-suggestions.json.pobtools-${process.pid}-0-0.tmp`);
  const missingOutside = join(attacked.root, 'missing-collision-target');
  brokenDirectoryLink(missingOutside, collision);
  copyVerifiedMaintenanceBundle({ verifiedBundle, destinationRoot: attacked.destinationRoot });
  assert.equal(existsSync(missingOutside), false);
  assert.equal(lstatSync(collision).isSymbolicLink(), true);
  assert.equal(readFileSync(join(attacked.destinationRoot, ...firstRelative.split('/')), 'utf8'), '{"rows":[]}\n');
  unlinkSync(collision);
  assertNoTransactionTemporaries(attacked.destinationRoot);
});

test('a broken junction appearing on a newly installed target is rolled back exactly', (t) => {
  const attacked = fixture(t);
  createMaintenanceBundle({ sourceRoot: attacked.sourceRoot, bundleRoot: attacked.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: attacked.bundleRoot, stagingRoot: join(attacked.root, 'staging') });
  mkdirSync(attacked.destinationRoot);
  write(join(attacked.destinationRoot, 'sentinel.txt'), 'destination-original');
  const before = snapshotTree(attacked.destinationRoot);
  const missingOutside = join(attacked.root, 'missing-post-install-target');
  let substituted = false;
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: attacked.destinationRoot,
    operations: {
      afterInstall({ relativePath }) {
        if (substituted) return;
        substituted = true;
        const target = join(attacked.destinationRoot, ...relativePath.split('/'));
        unlinkSync(target);
        brokenDirectoryLink(missingOutside, target);
      },
    },
  }));
  assert.equal(existsSync(missingOutside), false);
  assert.deepEqual(snapshotTree(attacked.destinationRoot), before);
  assertNoTransactionTemporaries(attacked.destinationRoot);
});

test('a broken junction appearing after replacement restores pre-existing destination bytes', (t) => {
  const attacked = fixture(t);
  createMaintenanceBundle({ sourceRoot: attacked.sourceRoot, bundleRoot: attacked.bundleRoot });
  const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: attacked.bundleRoot, stagingRoot: join(attacked.root, 'staging') });
  const firstRelative = 'localization/ko-KR/source-translation-suggestions.json';
  write(join(attacked.destinationRoot, ...firstRelative.split('/')), 'pre-existing destination bytes');
  write(join(attacked.destinationRoot, 'sentinel.txt'), 'destination-original');
  const before = snapshotTree(attacked.destinationRoot);
  const missingOutside = join(attacked.root, 'missing-restore-target');
  let substituted = false;
  assert.throws(() => copyVerifiedMaintenanceBundle({
    verifiedBundle,
    destinationRoot: attacked.destinationRoot,
    operations: {
      afterInstall({ relativePath }) {
        if (substituted) return;
        substituted = true;
        const target = join(attacked.destinationRoot, ...relativePath.split('/'));
        unlinkSync(target);
        brokenDirectoryLink(missingOutside, target);
      },
    },
  }));
  assert.equal(existsSync(missingOutside), false);
  assert.deepEqual(snapshotTree(attacked.destinationRoot), before);
  assertNoTransactionTemporaries(attacked.destinationRoot);
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
