import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAndExpandCleanBranchManifest,
  materializeCleanBranch,
} from '../lib/clean-branch-materializer.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliPath = join(repositoryRoot, 'localization', 'ko-KR', 'materialize-clean-branch.mjs');
const manifestRelativePath = 'localization/ko-KR/clean-branch-manifest.json';
const pinnedBase = 'ba33ed80de67d8301baad930456131d581df6ae1';
const fontRelativePath = 'pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf';
const fontSha256 = '194018E6B2B293A7964F037B25C0249CE1418BC9AB3C971060A03AA57861E252';

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function git(root, ...arguments_) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function gitBytes(root, ...arguments_) {
  return execFileSync('git', arguments_, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
}

function initRepository(root) {
  mkdirSync(root, { recursive: true });
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Clean Branch Test');
}

function commitAll(root, message) {
  git(root, 'add', '--all');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function makeManifest(targetBaseCommit, entries) {
  return {
    schemaVersion: 1,
    targetBaseCommit,
    entries,
  };
}

function makeFixture(t, {
  entries = [{ path: 'NOTICE.md', kind: 'file' }],
  sourceFiles = { 'NOTICE.md': 'committed source\n' },
  manifestTransform,
  targetFiles = { 'upstream.txt': 'upstream\n' },
} = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pobtools-clean-branch-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const targetRoot = join(temporaryRoot, 'target');
  initRepository(targetRoot);
  for (const [path, contents] of Object.entries(targetFiles)) write(join(targetRoot, path), contents);
  const targetBaseCommit = commitAll(targetRoot, 'target base');

  const sourceRoot = join(temporaryRoot, 'source');
  initRepository(sourceRoot);
  for (const [path, contents] of Object.entries(sourceFiles)) write(join(sourceRoot, path), contents);
  const manifest = makeManifest(targetBaseCommit, entries);
  write(
    join(sourceRoot, manifestRelativePath),
    `${JSON.stringify(manifestTransform ? manifestTransform(manifest) : manifest, null, 2)}\n`,
  );
  const sourceCommit = commitAll(sourceRoot, 'trusted source');
  return { sourceCommit, sourceRoot, targetBaseCommit, targetRoot, temporaryRoot };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

test('the exact real manifest expands only the reviewed inventory in sorted order', async (t) => {
  const realManifest = JSON.parse(readFileSync(join(repositoryRoot, manifestRelativePath), 'utf8'));
  const sourceFiles = {};
  for (const entry of realManifest.entries) {
    if (entry.kind === 'file') {
      sourceFiles[entry.path] = gitBytes(repositoryRoot, 'cat-file', 'blob', `HEAD:${entry.path}`);
    } else if (entry.required !== false) {
      sourceFiles[`${entry.path}/fixture.txt`] = `${entry.path}\n`;
    }
  }
  const fixture = makeFixture(t, { entries: realManifest.entries, sourceFiles });
  const expanded = await loadAndExpandCleanBranchManifest({
    repositoryRoot: fixture.sourceRoot,
    sourceRef: fixture.sourceCommit,
  });
  const paths = expanded.files.map((row) => row.path);
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right, 'en')));
  assert.equal(paths.includes('.gitattributes'), true);
  assert.equal(paths.includes('.github/workflows/fixture.txt'), true);
  assert.equal(paths.includes('docs/superpowers/plans/2026-09-01-pobtools-ko-maintenance-automation.md'), true);
  assert.equal(paths.includes('docs/superpowers/specs/2026-09-01-pobtools-ko-maintenance-automation-design.md'), true);
  assert.equal(paths.includes(fontRelativePath), true);
  assert.equal(paths.includes('pob-zh-engine/dist/pob-zh.ini'), true);
  assert.equal(paths.includes('pob-zh-engine/dist/Data/launcher/ko-KR/fixture.txt'), true);
  assert.equal(paths.some((path) => /^pob-zh-engine\/host\//u.test(path)), false);
  assert.equal(paths.some((path) => /(?:^|\/)poe2(?:\/|$)/iu.test(path)), false);
});

test('the committed real manifest accepts its own exact source objects', async () => {
  await loadAndExpandCleanBranchManifest({
    repositoryRoot,
    sourceRef: 'HEAD',
  });
});

test('malformed, traversal, duplicate, overlapping, and unauthorized manifest entries fail closed', async (t) => {
  const cases = {
    malformed_schema: (manifest) => ({ ...manifest, schemaVersion: '1' }),
    traversal: (manifest) => ({ ...manifest, entries: [{ path: '../NOTICE.md', kind: 'file' }] }),
    absolute: (manifest) => ({ ...manifest, entries: [{ path: 'C:/NOTICE.md', kind: 'file' }] }),
    duplicate: (manifest) => ({ ...manifest, entries: [manifest.entries[0], manifest.entries[0]] }),
    overlap: (manifest) => ({
      ...manifest,
      entries: [{ path: 'reports', kind: 'tree' }, { path: 'reports/a.json', kind: 'file' }],
    }),
    unauthorized: (manifest) => ({
      ...manifest,
      entries: [{ path: 'pob-zh-engine/host/view.cpp', kind: 'file' }],
    }),
    poe2: (manifest) => ({
      ...manifest,
      entries: [{ path: 'pob-zh-engine/dist/Data/poe2/ko-KR/ui.json', kind: 'file' }],
    }),
  };
  for (const [name, manifestTransform] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const fixture = makeFixture(t, { manifestTransform });
      await assert.rejects(
        loadAndExpandCleanBranchManifest({ repositoryRoot: fixture.sourceRoot, sourceRef: fixture.sourceCommit }),
        /manifest|path|duplicate|overlap|authorized|forbidden/iu,
      );
    });
  }
});

test('non-regular source Git modes and unapproved binary blobs are rejected', async (t) => {
  const symlinkFixture = makeFixture(t, {
    entries: [{ path: 'NOTICE.md', kind: 'file' }],
    sourceFiles: { 'NOTICE.md': 'destination.txt\n' },
  });
  const linkBlob = git(symlinkFixture.sourceRoot, 'hash-object', '-w', '--stdin');
  git(symlinkFixture.sourceRoot, 'update-index', '--add', '--cacheinfo', `120000,${linkBlob},NOTICE.md`);
  git(symlinkFixture.sourceRoot, 'commit', '-m', 'make source a symlink');
  const symlinkCommit = git(symlinkFixture.sourceRoot, 'rev-parse', 'HEAD');
  await assert.rejects(
    loadAndExpandCleanBranchManifest({ repositoryRoot: symlinkFixture.sourceRoot, sourceRef: symlinkCommit }),
    /regular Git blob mode/iu,
  );

  const binaryFixture = makeFixture(t, {
    entries: [{ path: 'reports/output.bin', kind: 'file' }],
    sourceFiles: { 'reports/output.bin': Buffer.from([0, 1, 2, 3]) },
  });
  await assert.rejects(
    loadAndExpandCleanBranchManifest({ repositoryRoot: binaryFixture.sourceRoot, sourceRef: binaryFixture.sourceCommit }),
    /binary|text extension/iu,
  );

  for (const [name, path, bytes] of [
    ['nul-free invalid UTF-8', 'reports/invalid.json', Buffer.from([0xC3, 0x28])],
    ['ASCII data extension', 'reports/output.dat', Buffer.from('plain ASCII\n')],
  ]) {
    await t.test(name, async (t) => {
      const fixture = makeFixture(t, { entries: [{ path, kind: 'file' }], sourceFiles: { [path]: bytes } });
      await assert.rejects(
        loadAndExpandCleanBranchManifest({ repositoryRoot: fixture.sourceRoot, sourceRef: fixture.sourceCommit }),
        /text|UTF-8|extension|binary/iu,
      );
    });
  }

  const maliciousOfl = Buffer.from([0xC3, 0x28]);
  const oflPath = 'pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt';
  const oflFixture = makeFixture(t, {
    entries: [{ path: oflPath, kind: 'file', sha256: sha256(maliciousOfl) }],
    sourceFiles: { [oflPath]: maliciousOfl },
  });
  await assert.rejects(
    loadAndExpandCleanBranchManifest({ repositoryRoot: oflFixture.sourceRoot, sourceRef: oflFixture.sourceCommit }),
    /UTF-8|binary/iu,
  );

  const changedValidOfl = Buffer.from('Open Font License replacement with valid UTF-8 text.\n', 'utf8');
  const changedValidOflFixture = makeFixture(t, {
    entries: [{ path: oflPath, kind: 'file', sha256: sha256(changedValidOfl) }],
    sourceFiles: { [oflPath]: changedValidOfl },
  });
  await assert.rejects(
    loadAndExpandCleanBranchManifest({ repositoryRoot: changedValidOflFixture.sourceRoot, sourceRef: changedValidOflFixture.sourceCommit }),
    /approved asset.*OFL-NotoSansKR\.txt/iu,
  );
});

test('dirty and wrong-base targets are rejected before the first write', async (t) => {
  await t.test('dirty', async (t) => {
    const fixture = makeFixture(t);
    write(join(fixture.targetRoot, 'dirty.txt'), 'dirty\n');
    await assert.rejects(materializeCleanBranch({
      repositoryRoot: fixture.sourceRoot,
      sourceRef: fixture.sourceCommit,
      targetRoot: fixture.targetRoot,
    }), /clean Git worktree/iu);
    assert.equal(readFileSync(join(fixture.targetRoot, 'upstream.txt'), 'utf8'), 'upstream\n');
    assert.equal(spawnSync('git', ['-C', fixture.targetRoot, 'ls-files', '--error-unmatch', 'NOTICE.md']).status, 1);
  });

  await t.test('wrong base', async (t) => {
    const fixture = makeFixture(t);
    write(join(fixture.targetRoot, 'second.txt'), 'second\n');
    commitAll(fixture.targetRoot, 'wrong target head');
    await assert.rejects(materializeCleanBranch({
      repositoryRoot: fixture.sourceRoot,
      sourceRef: fixture.sourceCommit,
      targetRoot: fixture.targetRoot,
    }), /pinned base/iu);
    assert.equal(spawnSync('git', ['-C', fixture.targetRoot, 'ls-files', '--error-unmatch', 'NOTICE.md']).status, 1);
  });
});

test('materialization reads committed Git objects instead of dirty source bytes', async (t) => {
  const fixture = makeFixture(t);
  write(join(fixture.sourceRoot, 'NOTICE.md'), 'dirty working-copy bytes\n');
  const summary = await materializeCleanBranch({
    repositoryRoot: fixture.sourceRoot,
    sourceRef: fixture.sourceCommit,
    targetRoot: fixture.targetRoot,
  });
  assert.equal(readFileSync(join(fixture.targetRoot, 'NOTICE.md'), 'utf8'), 'committed source\n');
  assert.equal(summary.sourceCommit, fixture.sourceCommit);
});

test('an existing target junction is rejected before external bytes can be changed', async (t) => {
  const fixture = makeFixture(t, {
    entries: [{ path: 'reports/new.json', kind: 'file' }],
    sourceFiles: { 'reports/new.json': '{}\n' },
    targetFiles: { 'reports/existing.json': '{"kept":true}\n' },
  });
  const external = join(fixture.temporaryRoot, 'external');
  mkdirSync(external);
  write(join(external, 'existing.json'), '{"kept":true}\n');
  rmSync(join(fixture.targetRoot, 'reports'), { recursive: true });
  symlinkSync(external, join(fixture.targetRoot, 'reports'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(materializeCleanBranch({
    repositoryRoot: fixture.sourceRoot,
    sourceRef: fixture.sourceCommit,
    targetRoot: fixture.targetRoot,
  }), /symbolic link|junction|reparse/iu);
  assert.equal(readFileSync(join(external, 'existing.json'), 'utf8'), '{"kept":true}\n');
  assert.equal(spawnSync('git', ['-C', fixture.targetRoot, 'status', '--porcelain=v1']).stdout.toString(), '');
});

test('dry-run and CLI summaries are deterministic, sorted, and perform no writes', async (t) => {
  const fixture = makeFixture(t, {
    entries: [{ path: 'reports', kind: 'tree' }],
    sourceFiles: { 'reports/z.json': '{}\n', 'reports/a.json': '{}\n' },
  });
  const first = await materializeCleanBranch({
    repositoryRoot: fixture.sourceRoot,
    sourceRef: fixture.sourceCommit,
    targetRoot: fixture.targetRoot,
    dryRun: true,
  });
  const second = await materializeCleanBranch({
    repositoryRoot: fixture.sourceRoot,
    sourceRef: fixture.sourceCommit,
    targetRoot: fixture.targetRoot,
    dryRun: true,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map((row) => row.path), ['reports/a.json', 'reports/z.json']);
  assert.equal(spawnSync('git', ['-C', fixture.targetRoot, 'status', '--porcelain=v1']).stdout.toString(), '');

  const cli = spawnSync(process.execPath, [
    cliPath,
    '--repository-root', fixture.sourceRoot,
    '--source-ref', fixture.sourceCommit,
    '--target-root', fixture.targetRoot,
    '--dry-run',
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), first);
});

test('the approved binary font is hash-pinned and byte-identical after materialization', async (t) => {
  const fontBytes = readFileSync(join(repositoryRoot, fontRelativePath));
  assert.equal(sha256(fontBytes), fontSha256);
  const fixture = makeFixture(t, {
    entries: [{ path: fontRelativePath, kind: 'file', sha256: fontSha256 }],
    sourceFiles: { [fontRelativePath]: fontBytes },
  });
  const summary = await materializeCleanBranch({
    repositoryRoot: fixture.sourceRoot,
    sourceRef: fixture.sourceCommit,
    targetRoot: fixture.targetRoot,
  });
  const copiedBytes = readFileSync(join(fixture.targetRoot, fontRelativePath));
  assert.equal(sha256(copiedBytes), fontSha256);
  assert.equal(summary.files[0].sha256, fontSha256);
  assert.equal(summary.files[0].size, 10_414_588);
});

test('only the exact retained OFL license opts out of whitespace lint', () => {
  const attributes = execFileSync('git', [
    'check-attr', 'whitespace', '--',
    'pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt',
    manifestRelativePath,
  ], { cwd: repositoryRoot, encoding: 'utf8' }).trim().split(/\r?\n/u);
  assert.deepEqual(attributes, [
    'pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt: whitespace: unset',
    `${manifestRelativePath}: whitespace: unspecified`,
  ]);
});

test('the retained OFL license stays byte-identical under auto-CRLF checkout', (t) => {
  const licenseRelativePath = 'pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt';
  const checkoutRoot = mkdtempSync(join(tmpdir(), 'pobtools-ko-license-checkout-'));
  t.after(() => rmSync(checkoutRoot, { recursive: true, force: true }));
  const checkout = spawnSync('git', [
    '-c',
    'core.autocrlf=true',
    'checkout-index',
    `--prefix=${checkoutRoot}${sep}`,
    '--',
    licenseRelativePath,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(checkout.status, 0, checkout.stderr);
  assert.equal(
    sha256(readFileSync(join(checkoutRoot, ...licenseRelativePath.split('/')))),
    '1C05C68C34F9708415AADA51F17E1B0092D2CEA709BF4A94CD38114F9E73D7D9',
  );
});

test('the committed distribution INI preserves the reviewed CRLF identity', () => {
  const iniPath = 'pob-zh-engine/dist/pob-zh.ini';
  const committedBytes = execFileSync('git', ['cat-file', 'blob', `:${iniPath}`], {
    cwd: repositoryRoot,
    encoding: null,
  });
  assert.equal(sha256(committedBytes), 'A75345BD3CC9AB480BD55C5B10B35364160EA426D21BFA65C2870E08982E7669');
  assert.equal(
    execFileSync('git', ['check-attr', 'text', '--', iniPath], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    `${iniPath}: text: unset`,
  );
  assert.equal(
    execFileSync('git', ['check-attr', 'whitespace', '--', iniPath], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    `${iniPath}: whitespace: unset`,
  );
});
