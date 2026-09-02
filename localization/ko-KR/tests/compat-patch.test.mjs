import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const patchPath = join(repositoryRoot, 'localization', 'ko-KR', 'compat', 'pobtools-ko.patch');
const manifestPath = join(repositoryRoot, 'localization', 'ko-KR', 'compat', 'manifest.json');
const mappingPath = join(repositoryRoot, 'localization', 'ko-KR', 'source-translations.json');
const policyPath = join(repositoryRoot, 'localization', 'ko-KR', 'source-display-policy.json');

const BASE_COMMIT = 'baf07d41d2df524d4330a58b411826339c93fac1';
const APPROVED_PATCH_SHA256 = '2D3963E980C2E48604BA7FA91CDF784AB3E70485FBFEFB51DC5195E25B123959';
const ALLOWED_PATHS = [
  'pob-zh-engine/CMakeLists.txt',
  'pob-zh-engine/host/app_update.cpp',
  'pob-zh-engine/host/app_update.h',
  'pob-zh-engine/host/atlas_update.cpp',
  'pob-zh-engine/host/filter_i18n.cpp',
  'pob-zh-engine/host/filter_item_import.cpp',
];
const REQUIRED_CONTRACTS = [
  'korean-atlas-path',
  'korean-filter-maps',
  'korean-item-prefixes',
  'korean-release-cmake',
  'korean-update-disable',
];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const changedPaths = (patch) => [...patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]);
const addedDisplayLiterals = (patch) => patch.split(/\r?\n/u)
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .flatMap((line) => [...line.matchAll(/(?:u8|L|u|U)?"([^"\\]*(?:\\.[^"\\]*)*)"/gu)])
  .map((match) => match[1])
  .filter((value) => /[\p{Script=Han}가-힣]/u.test(value));

test('compatibility patch is pinned, path-limited, and contains only reviewed display literals', () => {
  const manifest = readJson(manifestPath);
  const patchBytes = readFileSync(patchPath);
  const patch = patchBytes.toString('utf8');
  const mapping = readJson(mappingPath);
  const policy = readJson(policyPath);
  const acceptedDisplayLiterals = new Set([
    ...Object.keys(mapping.entries),
    ...mapping.contexts.map((row) => row.source),
    ...Object.values(mapping.entries).map((row) => row.target),
    ...mapping.contexts.map((row) => row.target),
  ]);

  assert.equal(manifest.version, 1);
  assert.equal(manifest.baseCommit, BASE_COMMIT);
  assert.match(manifest.sha256, /^[0-9A-F]{64}$/u);
  assert.equal(manifest.sha256, APPROVED_PATCH_SHA256);
  assert.equal(sha256(patchBytes), APPROVED_PATCH_SHA256);
  assert.deepEqual(manifest.allowedPaths, ALLOWED_PATHS);
  assert.deepEqual(manifest.requiredContracts, REQUIRED_CONTRACTS);
  assert.deepEqual([...new Set(changedPaths(patch))].sort(), ALLOWED_PATHS);
  for (const literal of addedDisplayLiterals(patch)) {
    assert.equal(acceptedDisplayLiterals.has(literal), true, `patch literal is not owned by reviewed overlay: ${literal}`);
  }
  const compatibilityRecovery = policy.parseRecoveryAllowlist.find((row) => (
    row.path === 'host/app_update.cpp'
    && row.sourceRole === 'upstream'
    && row.sourceCommit === manifest.baseCommit
    && row.compatibilityPatchSha256 !== undefined
  ));
  assert.deepEqual(compatibilityRecovery, {
    path: 'host/app_update.cpp',
    sourceRole: 'upstream',
    sourceCommit: manifest.baseCommit,
    fileSha256: '7C2B6D329D066DFAE51FA34D64D2DDEBB2E6A777E683E7474D6BCB76157D4803',
    recoverySha256: '9F10D6FF8F79247D5AA82D3341DA8BA050A1DA20847754560EFFE49415EFBD09',
    compatibilityPatchSha256: APPROVED_PATCH_SHA256,
    reason: 'reviewed Korean compatibility patch updater-disable recovery',
  });
});

test('compatibility patch alone opts out of whitespace checking', () => {
  const attributes = execFileSync(
    'git',
    [
      'check-attr',
      'whitespace',
      '--',
      'localization/ko-KR/compat/pobtools-ko.patch',
      'localization/ko-KR/compat/manifest.json',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim().split(/\r?\n/u);

  assert.deepEqual(attributes, [
    'localization/ko-KR/compat/pobtools-ko.patch: whitespace: unset',
    'localization/ko-KR/compat/manifest.json: whitespace: unspecified',
  ]);
});
