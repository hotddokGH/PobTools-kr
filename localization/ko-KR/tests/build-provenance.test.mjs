import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  buildPreviewProvenance,
  serializePreviewProvenance,
} from '../write-build-provenance.mjs';

const UPSTREAM = 'ba33ed80de67d8301baad930456131d581df6ae1';
const AUTOMATION = '0123456789abcdef0123456789abcdef01234567';
const CUSTOM_OUTPUTS = [
  'host/data/astrolabes_poe1.json',
  'host/data/atlas_maps_poe1.json',
  'host/data/regex_poe1.json',
  'host/data/scarabs_poe1.json',
  'host/data/timeless_jewels.json',
].map((path, index) => ({ path, sha256: String.fromCharCode(65 + index).repeat(64) }));

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function fixture(t, suffix = '') {
  const root = mkdtempSync(join(tmpdir(), `pobtools-provenance-${suffix}`));
  t.after(() => {
    try { unlinkSync(join(root, 'engine', 'dist', 'Data', 'poe1', 'ko-KR', 'linked.json')); } catch {}
  });
  const repositoryRoot = join(root, 'trusted');
  const engineRoot = join(root, 'engine');
  const patch = Buffer.from('reviewed compatibility patch\n');
  write(join(repositoryRoot, 'localization/ko-KR/upstream-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    lastReviewedCommit: UPSTREAM,
    officialPoePatch: '3.29.3.2',
  })}\n`);
  write(join(repositoryRoot, 'localization/ko-KR/compat/pobtools-ko.patch'), patch);
  write(join(repositoryRoot, 'localization/ko-KR/compat/manifest.json'), `${JSON.stringify({
    version: 1,
    baseCommit: 'baf07d41d2df524d4330a58b411826339c93fac1',
    sha256: sha256(patch),
    allowedPaths: ['pob-zh-engine/CMakeLists.txt'],
    requiredContracts: ['korean-release-cmake'],
  })}\n`);
  write(join(repositoryRoot, 'localization/ko-KR/source-translations.json'), '{"entries":{"Open":"\uC5F4\uAE30"}}\n');
  write(join(repositoryRoot, 'localization/ko-KR/source-display-policy.json'), '{"schemaVersion":2}\n');
  write(join(repositoryRoot, 'localization/ko-KR/display-policy.json'), '{"schemaVersion":1}\n');
  write(join(repositoryRoot, 'localization/ko-KR/official-terms/custom-data/sources.json'), '{"sources":[]}\n');
  write(join(repositoryRoot, 'localization/ko-KR/official-terms/tables/Korean/ClientStrings.json'), '{"rows":[]}\n');
  write(join(repositoryRoot, 'localization/ko-KR/custom-poe1-output-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    officialPoePatch: '3.29.3.2',
    hashPolicy: 'crlf-to-lf-sha256',
    outputs: CUSTOM_OUTPUTS,
  })}\n`);

  const retained = {
    'dist/Data/launcher/ko-KR/launcher.json': Buffer.from('{"Open":"\uC5F4\uAE30"}\n'),
    'dist/Data/launcher/ko-KR/meta.json': Buffer.from('{"locale":"ko-KR"}\n'),
    'dist/Fonts/NotoSansKR-Variable.ttf': Buffer.from('fixture-font'),
    'dist/Fonts/OFL-NotoSansKR.txt': Buffer.from('fixture-ofl'),
    'dist/pob-zh.ini': Buffer.from('Game=poe1\r\nLocale=ko-KR\r\n'),
  };
  const entries = [];
  for (const [path, bytes] of Object.entries(retained)) {
    write(join(repositoryRoot, 'pob-zh-engine', ...path.split('/')), bytes);
    write(join(engineRoot, ...path.split('/')), bytes);
    entries.push({ path: `pob-zh-engine/${path}`, kind: 'file', sha256: sha256(bytes) });
  }
  write(join(repositoryRoot, 'localization/ko-KR/clean-branch-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    targetBaseCommit: UPSTREAM,
    entries,
  })}\n`);
  write(join(engineRoot, 'dist/Data/poe1/ko-KR/ui.json'), '{"Open":"\uC5F4\uAE30"}\n');
  write(join(engineRoot, 'dist/Data/poe1/ko-KR/items.json'), '{"Sword":"\uAC80"}\n');
  return { root, repositoryRoot, engineRoot };
}

function options(item) {
  const retainedAssetPaths = [
    'dist/Data/launcher/ko-KR/launcher.json',
    'dist/Data/launcher/ko-KR/meta.json',
    'dist/Fonts/NotoSansKR-Variable.ttf',
    'dist/Fonts/OFL-NotoSansKR.txt',
    'dist/pob-zh.ini',
  ];
  return {
    repositoryRoot: item.repositoryRoot,
    engineRoot: item.engineRoot,
    reviewedUpstreamCommit: UPSTREAM,
    koreanAutomationCommit: AUTOMATION,
    runnerImageLabel: 'windows-2025-vs2026',
    runnerImage: 'Windows Server 2025 10.0.26100',
    workflowRunId: '123456789',
    workflowRunAttempt: '2',
    configuration: 'Release',
    koreanReleaseCmake: 'ON',
    expectedRetainedAssets: Object.fromEntries(retainedAssetPaths.map((path) => [
      path,
      sha256(readFileSync(join(item.repositoryRoot, 'pob-zh-engine', ...path.split('/')))),
    ])),
  };
}

test('build provenance is root-independent, exact, sorted, and binds every named input', (t) => {
  const left = fixture(t, 'left-');
  const right = fixture(t, 'right-');
  cpSync(left.repositoryRoot, right.repositoryRoot, { recursive: true, force: true });
  cpSync(left.engineRoot, right.engineRoot, { recursive: true, force: true });
  const leftValue = buildPreviewProvenance(options(left));
  const rightValue = buildPreviewProvenance(options(right));
  const bytes = serializePreviewProvenance(leftValue);
  assert.equal(bytes, serializePreviewProvenance(rightValue));
  assert.deepEqual(Object.keys(leftValue), [
    'schemaVersion', 'reviewedUpstreamCommit', 'koreanAutomationCommit', 'officialPoePatch',
    'compatibilityPatch', 'inputs', 'generatedKoreanData', 'build',
  ]);
  assert.equal(leftValue.schemaVersion, 1);
  assert.equal(leftValue.reviewedUpstreamCommit, UPSTREAM);
  assert.equal(leftValue.koreanAutomationCommit, AUTOMATION);
  assert.equal(leftValue.officialPoePatch, '3.29.3.2');
  assert.equal(leftValue.compatibilityPatch.sha256, sha256(Buffer.from('reviewed compatibility patch\n')));
  assert.deepEqual(leftValue.inputs.map(({ name }) => name), [
    'canonical-source-translations', 'clean-branch-manifest', 'custom-poe1-output-manifest',
    'display-policy', 'official-terms-inputs', 'retained-font', 'retained-font-license',
    'retained-ini', 'retained-launcher-dictionary', 'retained-launcher-meta', 'source-display-policy',
  ]);
  assert.deepEqual(leftValue.generatedKoreanData.files.map(({ path }) => path), [
    'dist/Data/launcher/ko-KR/launcher.json', 'dist/Data/launcher/ko-KR/meta.json',
    'dist/Data/poe1/ko-KR/items.json', 'dist/Data/poe1/ko-KR/ui.json',
  ]);
  assert.deepEqual(leftValue.build, {
    runnerImageLabel: 'windows-2025-vs2026',
    runnerImage: 'Windows Server 2025 10.0.26100',
    workflowRunId: '123456789',
    workflowRunAttempt: 2,
    configuration: 'Release',
    koreanReleaseCmake: 'ON',
    unsigned: true,
  });
  assert.doesNotMatch(bytes, new RegExp(left.root.replaceAll('\\', '\\\\'), 'iu'));
});

test('changing a generated Korean byte changes its file and tree hashes', (t) => {
  const item = fixture(t, 'mutation-');
  const before = buildPreviewProvenance(options(item));
  write(join(item.engineRoot, 'dist/Data/poe1/ko-KR/ui.json'), '{"Open":"\uC5F4\uAE30!"}\n');
  const after = buildPreviewProvenance(options(item));
  const beforeFile = before.generatedKoreanData.files.find(({ path }) => path.endsWith('/ui.json'));
  const afterFile = after.generatedKoreanData.files.find(({ path }) => path.endsWith('/ui.json'));
  assert.notEqual(beforeFile.sha256, afterFile.sha256);
  assert.notEqual(before.generatedKoreanData.treeSha256, after.generatedKoreanData.treeSha256);
});

test('provenance rejects malformed identities and mismatched trusted state before output', (t) => {
  const item = fixture(t, 'invalid-');
  assert.throws(() => buildPreviewProvenance({ ...options(item), koreanAutomationCommit: 'main' }), /Korean automation commit/u);
  assert.throws(() => buildPreviewProvenance({ ...options(item), workflowRunAttempt: '0' }), /run attempt/u);
  assert.throws(() => buildPreviewProvenance({ ...options(item), configuration: 'Debug' }), /configuration/u);
  assert.throws(() => buildPreviewProvenance({ ...options(item), unexpected: true }), /unknown option/u);
  const statePath = join(item.repositoryRoot, 'localization/ko-KR/upstream-state.json');
  write(statePath, `${JSON.stringify({
    schemaVersion: 1,
    lastReviewedCommit: UPSTREAM,
    officialPoePatch: '3.29.3.2',
    unexpected: true,
  })}\n`);
  assert.throws(() => buildPreviewProvenance(options(item)), /upstream state keys/u);
  write(statePath, '{"schemaVersion":1,"lastReviewedCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","officialPoePatch":"3.29.3.2"}\n');
  assert.throws(() => buildPreviewProvenance(options(item)), /reviewed upstream commit/u);
});

test('provenance rejects a malformed custom PoE1 output manifest before hashing it', (t) => {
  const item = fixture(t, 'malformed-custom-manifest-');
  const manifestPath = join(item.repositoryRoot, 'localization/ko-KR/custom-poe1-output-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.outputs[0].sha256 = manifest.outputs[0].sha256.toLowerCase();
  write(manifestPath, `${JSON.stringify(manifest)}\n`);

  assert.throws(() => buildPreviewProvenance(options(item)), /custom PoE1 output manifest SHA-256/u);
});

test('provenance rejects tampered pins, missing data, and Korean data reparses', (t) => {
  const item = fixture(t, 'unsafe-');
  write(join(item.repositoryRoot, 'localization/ko-KR/compat/pobtools-ko.patch'), 'tampered\n');
  assert.throws(() => buildPreviewProvenance(options(item)), /compatibility patch SHA-256/u);
  write(join(item.repositoryRoot, 'localization/ko-KR/compat/pobtools-ko.patch'), 'reviewed compatibility patch\n');
  rmSync(join(item.engineRoot, 'dist/Data/poe1/ko-KR'), { recursive: true });
  assert.throws(() => buildPreviewProvenance(options(item)), /generated Korean data/u);
  write(join(item.engineRoot, 'dist/Data/poe1/ko-KR/ui.json'), '{"Open":"\uC5F4\uAE30"}\n');
  write(join(item.engineRoot, 'dist/Data/poe1/ko-KR/items.json'), '{"Sword":"\uAC80"}\n');
  write(join(item.engineRoot, 'dist/Data/poe2/ko-KR/ui.json'), '{}\n');
  assert.throws(() => buildPreviewProvenance(options(item)), /outside the exact launcher and PoE1 scopes/u);
  rmSync(join(item.engineRoot, 'dist/Data/poe2'), { recursive: true });
  const outside = join(item.root, 'outside.json');
  write(outside, '{}\n');
  try {
    symlinkSync(outside, join(item.engineRoot, 'dist/Data/poe1/ko-KR/linked.json'), 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`file symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => buildPreviewProvenance(options(item)), /symbolic link|reparse/u);
});
