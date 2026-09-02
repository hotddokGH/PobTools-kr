import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const assembler = join(repositoryRoot, 'localization', 'ko-KR', 'Assemble-KoreanPackage.ps1');
const archiveVerifier = join(repositoryRoot, 'tests', 'ko-KR', 'Verify-KoreanPackageArchive.ps1');

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function run(script, arguments_) {
  return spawnSync('pwsh', ['-NoProfile', '-File', script, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function fixture(t, marker = 'A') {
  const fixtureParent = join(repositoryRoot, '.ko-worktrees');
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(join(fixtureParent, 'task10-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installRoot = join(root, 'install');
  const assetRoot = join(root, `assets-${marker}`);
  const outputRoot = join(root, 'output');
  const zipPath = join(root, 'PobTools-Korean-preview.zip');
  write(join(installRoot, 'pob-zh.exe'), Buffer.alloc(1024 * 1024, marker.charCodeAt(0)));
  write(join(installRoot, 'engine/SimpleGraphic.dll'), marker);
  write(join(installRoot, 'Data/poe2/forbidden.json'), '{}\n');
  write(join(installRoot, 'reports/private.txt'), 'forbidden');
  write(join(assetRoot, 'dist/Data/launcher/ko-KR/launcher.json'), `{"marker":"${marker}"}\n`);
  write(join(assetRoot, 'dist/Data/launcher/ko-KR/meta.json'), '{"locale":"ko-KR"}\n');
  for (const name of ['tags', 'items', 'gems', 'ui', 'stats', 'passives', 'uniques', 'monsters']) {
    write(join(assetRoot, `dist/Data/poe1/ko-KR/${name}.json`), `{"marker":"${marker}-${name}"}\n`);
  }
  write(join(assetRoot, 'dist/Fonts/NotoSansKR-Variable.ttf'), Buffer.alloc(1024 * 1024, marker.charCodeAt(0)));
  write(join(assetRoot, 'dist/Fonts/OFL-NotoSansKR.txt'), `OFL-${marker}\n`);
  write(join(assetRoot, 'dist/pob-zh.ini'), 'Game=poe1\r\nLocale=ko-KR\r\nUpdateTranslations=0\r\nFont=NotoSansKR-Variable.ttf\r\n');
  return { root, installRoot, assetRoot, outputRoot, zipPath };
}

function assemble(item) {
  return run(assembler, [
    '-InstallRoot', item.installRoot,
    '-AssetRoot', item.assetRoot,
    '-OutputRoot', item.outputRoot,
    '-ZipPath', item.zipPath,
  ]);
}

test('assembler uses only the explicit asset root and includes Korean install documents', (t) => {
  const first = fixture(t, 'A');
  const second = fixture(t, 'B');
  const firstRun = assemble(first);
  const secondRun = assemble(second);
  assert.equal(firstRun.status, 0, `${firstRun.stdout}\n${firstRun.stderr}`);
  assert.equal(secondRun.status, 0, `${secondRun.stdout}\n${secondRun.stderr}`);
  assert.equal(readFileSync(join(first.outputRoot, 'Data/launcher/ko-KR/launcher.json'), 'utf8'), '{"marker":"A"}\n');
  assert.equal(readFileSync(join(second.outputRoot, 'Data/launcher/ko-KR/launcher.json'), 'utf8'), '{"marker":"B"}\n');
  assert.equal(readFileSync(join(first.outputRoot, 'Fonts/OFL-NotoSansKR.txt'), 'utf8'), 'OFL-A\n');
  assert.match(readFileSync(join(first.outputRoot, 'INSTALL-KO.md'), 'utf8'), /Locale=ko-KR/u);
  assert.match(readFileSync(join(first.outputRoot, 'PREVIEW-NOTES-KO.md'), 'utf8'), /PoE1/u);
  assert.equal(existsSync(join(first.outputRoot, 'Data/poe2')), false);
  assert.equal(existsSync(join(first.outputRoot, 'reports')), false);
});

test('assembler replaces installed Korean locale trees instead of retaining stale files', (t) => {
  const item = fixture(t, 'S');
  write(join(item.installRoot, 'Data/launcher/ko-KR/stale-launcher.json'), '{"stale":true}\n');
  write(join(item.installRoot, 'Data/poe1/ko-KR/stale-poe1.json'), '{"stale":true}\n');

  const result = assemble(item);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(join(item.outputRoot, 'Data/launcher/ko-KR/stale-launcher.json')), false);
  assert.equal(existsSync(join(item.outputRoot, 'Data/poe1/ko-KR/stale-poe1.json')), false);
});

test('missing or overlapping AssetRoot fails before existing outputs are changed', (t) => {
  const item = fixture(t, 'C');
  mkdirSync(item.outputRoot);
  write(join(item.outputRoot, 'sentinel.txt'), 'keep-output');
  write(item.zipPath, 'keep-zip');
  write(`${item.zipPath}.sha256.json`, 'keep-manifest');
  for (const [badRoot, message] of [
    [join(item.root, 'missing'), /AssetRoot does not exist/u],
    [item.outputRoot, /AssetRoot and OutputRoot must not overlap/u],
  ]) {
    const result = run(assembler, [
      '-InstallRoot', item.installRoot,
      '-AssetRoot', badRoot,
      '-OutputRoot', item.outputRoot,
      '-ZipPath', item.zipPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, message);
    assert.equal(readFileSync(join(item.outputRoot, 'sentinel.txt'), 'utf8'), 'keep-output');
    assert.equal(readFileSync(item.zipPath, 'utf8'), 'keep-zip');
    assert.equal(readFileSync(`${item.zipPath}.sha256.json`, 'utf8'), 'keep-manifest');
  }
});

test('reparse AssetRoot fails before existing outputs are changed when junctions are available', (t) => {
  const item = fixture(t, 'D');
  const link = join(item.root, 'asset-link');
  try {
    symlinkSync(item.assetRoot, link, 'junction');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`junctions unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  mkdirSync(item.outputRoot);
  write(join(item.outputRoot, 'sentinel.txt'), 'keep-output');
  const result = run(assembler, [
    '-InstallRoot', item.installRoot,
    '-AssetRoot', link,
    '-OutputRoot', item.outputRoot,
    '-ZipPath', item.zipPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /AssetRoot must be a regular directory without reparse points/u);
  assert.equal(readFileSync(join(item.outputRoot, 'sentinel.txt'), 'utf8'), 'keep-output');
});

test('archive verifier retests extracted bytes and removes only its fixed extract directory', (t) => {
  const item = fixture(t, 'E');
  const assembled = assemble(item);
  assert.equal(assembled.status, 0, `${assembled.stdout}\n${assembled.stderr}`);
  const runnerTemp = join(item.root, 'runner-temp');
  mkdirSync(runnerTemp);
  write(join(runnerTemp, 'keep.txt'), 'keep');
  const verified = run(archiveVerifier, [
    '-ZipPath', item.zipPath,
    '-ManifestPath', `${item.zipPath}.sha256.json`,
    '-RunnerTemp', runnerTemp,
  ]);
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  assert.equal(readFileSync(join(runnerTemp, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(join(runnerTemp, 'pobtools-ko-package')), false);
});

test('archive verifier rejects a changed ZIP, duplicate manifest path, and unsafe runner temp', (t) => {
  const item = fixture(t, 'F');
  const assembled = assemble(item);
  assert.equal(assembled.status, 0, `${assembled.stdout}\n${assembled.stderr}`);
  const runnerTemp = join(item.root, 'runner-temp');
  mkdirSync(runnerTemp);
  const manifestPath = `${item.zipPath}.sha256.json`;
  writeFileSync(item.zipPath, Buffer.concat([readFileSync(item.zipPath), Buffer.from('tamper')]));
  const changed = run(archiveVerifier, ['-ZipPath', item.zipPath, '-ManifestPath', manifestPath, '-RunnerTemp', runnerTemp]);
  assert.notEqual(changed.status, 0);
  assert.match(`${changed.stdout}\n${changed.stderr}`, /archive (?:SHA-256|bytes)/u);

  const second = fixture(t, 'G');
  assert.equal(assemble(second).status, 0);
  const secondManifestPath = `${second.zipPath}.sha256.json`;
  const malformed = JSON.parse(readFileSync(secondManifestPath, 'utf8'));
  malformed.files.push({ ...malformed.files[0] });
  write(secondManifestPath, `${JSON.stringify(malformed, null, 2)}\n`);
  mkdirSync(join(second.root, 'runner-temp'));
  const duplicate = run(archiveVerifier, [
    '-ZipPath', second.zipPath,
    '-ManifestPath', secondManifestPath,
    '-RunnerTemp', join(second.root, 'runner-temp'),
  ]);
  assert.notEqual(duplicate.status, 0);
  assert.match(`${duplicate.stdout}\n${duplicate.stderr}`, /duplicate|sorted and unique/u);

  const unsafe = run(archiveVerifier, [
    '-ZipPath', second.zipPath,
    '-ManifestPath', secondManifestPath,
    '-RunnerTemp', second.zipPath,
  ]);
  assert.notEqual(unsafe.status, 0);
});

test('archive verifier rejects traversal manifests and ZIP reparse entries before extraction', (t) => {
  const traversal = fixture(t, 'H');
  assert.equal(assemble(traversal).status, 0);
  const traversalManifestPath = `${traversal.zipPath}.sha256.json`;
  const traversalManifest = JSON.parse(readFileSync(traversalManifestPath, 'utf8'));
  traversalManifest.files[0].path = '../escape';
  write(traversalManifestPath, `${JSON.stringify(traversalManifest, null, 2)}\n`);
  const traversalTemp = join(traversal.root, 'runner-temp');
  mkdirSync(traversalTemp);
  const traversalResult = run(archiveVerifier, [
    '-ZipPath', traversal.zipPath,
    '-ManifestPath', traversalManifestPath,
    '-RunnerTemp', traversalTemp,
  ]);
  assert.notEqual(traversalResult.status, 0);
  assert.match(`${traversalResult.stdout}\n${traversalResult.stderr}`, /unsafe segment|normalized relative path/u);
  assert.equal(existsSync(join(traversal.root, 'escape')), false);

  const reparse = fixture(t, 'I');
  assert.equal(assemble(reparse).status, 0);
  const mutationScript = join(reparse.root, 'add-reparse-entry.ps1');
  write(mutationScript, String.raw`param([string]$ZipPath)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Update)
try {
    $entry = $archive.CreateEntry('Data/poe1/ko-KR/reparse-link')
    $entry.ExternalAttributes = -1610612736
    $stream = $entry.Open()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes('outside')
        $stream.Write($bytes, 0, $bytes.Length)
    }
    finally { $stream.Dispose() }
}
finally { $archive.Dispose() }
`);
  const mutation = run(mutationScript, ['-ZipPath', reparse.zipPath]);
  assert.equal(mutation.status, 0, `${mutation.stdout}\n${mutation.stderr}`);
  const reparseManifestPath = `${reparse.zipPath}.sha256.json`;
  const reparseManifest = JSON.parse(readFileSync(reparseManifestPath, 'utf8'));
  reparseManifest.files.push({
    path: 'Data/poe1/ko-KR/reparse-link',
    sha256: sha256(Buffer.from('outside')),
  });
  reparseManifest.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const zipBytes = readFileSync(reparse.zipPath);
  reparseManifest.archive.bytes = zipBytes.length;
  reparseManifest.archive.sha256 = sha256(zipBytes);
  write(reparseManifestPath, `${JSON.stringify(reparseManifest, null, 2)}\n`);
  const reparseTemp = join(reparse.root, 'runner-temp');
  mkdirSync(reparseTemp);
  const reparseResult = run(archiveVerifier, [
    '-ZipPath', reparse.zipPath,
    '-ManifestPath', reparseManifestPath,
    '-RunnerTemp', reparseTemp,
  ]);
  assert.notEqual(reparseResult.status, 0);
  assert.match(`${reparseResult.stdout}\n${reparseResult.stderr}`, /ZIP entry is a reparse point/u);
  assert.equal(existsSync(join(reparseTemp, 'pobtools-ko-package')), false);
});
