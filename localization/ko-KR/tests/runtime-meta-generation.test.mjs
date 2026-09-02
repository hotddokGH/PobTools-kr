import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const localeRoot = join(repositoryRoot, 'localization', 'ko-KR');
const canonicalMetaPath = join(localeRoot, 'runtime-meta.json');
const builderPath = join(localeRoot, 'build-runtime-locale.mjs');
const auditPath = join(localeRoot, 'audit-display-closure.mjs');

function runTrusted(script, engineRoot, reportRoot) {
  return spawnSync(process.execPath, [
    script,
    '--engine-root', engineRoot,
    '--report-root', reportRoot,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
}

test('real runtime generation writes exact canonical metadata and passes its audit from a clean engine', (t) => {
  assert.equal(existsSync(canonicalMetaPath), true, 'canonical trusted runtime metadata must exist');
  const expectedMetaBytes = readFileSync(canonicalMetaPath);
  const expectedMeta = JSON.parse(expectedMetaBytes);
  assert.deepEqual(expectedMeta, {
    version: '0.1.0',
    locale: 'ko-KR',
    display_name: '한국어',
    source: 'poe1',
    load_order: [
      'tags.json',
      'items.json',
      'gems.json',
      'ui.json',
      'stats.json',
      'passives.json',
      'uniques.json',
      'monsters.json',
    ],
    incomplete_translation_whitelist: [
      'DPS', 'PoB', 'DoT', 'AoE', 'URL', 'DPI', 'POB', 'FullDPS', 'B', 'G', 'R', 'W', 'A',
    ],
    glossary_blacklist: ['UNUSED'],
  });

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pobtools-ko-runtime-meta-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const engineRoot = join(temporaryRoot, 'engine');
  const reportRoot = join(temporaryRoot, 'reports');
  cpSync(
    join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'zh-rTW'),
    join(engineRoot, 'dist', 'Data', 'poe1', 'zh-rTW'),
    { recursive: true },
  );
  cpSync(join(repositoryRoot, 'reports', 'official-terms'), join(reportRoot, 'official-terms'), { recursive: true });

  const targetMetaPath = join(engineRoot, 'dist', 'Data', 'poe1', 'ko-KR', 'meta.json');
  assert.equal(existsSync(targetMetaPath), false);
  const trustedMetaPath = join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR', 'meta.json');
  const trustedMetaBefore = readFileSync(trustedMetaPath);

  const firstBuild = runTrusted(builderPath, engineRoot, reportRoot);
  const firstMeta = existsSync(targetMetaPath) ? readFileSync(targetMetaPath) : undefined;
  const firstAudit = runTrusted(auditPath, engineRoot, reportRoot);
  const secondBuild = runTrusted(builderPath, engineRoot, reportRoot);
  const secondMeta = existsSync(targetMetaPath) ? readFileSync(targetMetaPath) : undefined;

  assert.deepEqual({
    firstBuild: firstBuild.status,
    firstMeta,
    firstAudit: firstAudit.status,
    secondBuild: secondBuild.status,
    secondMeta,
    trustedMetaAfter: readFileSync(trustedMetaPath),
  }, {
    firstBuild: 0,
    firstMeta: expectedMetaBytes,
    firstAudit: 0,
    secondBuild: 0,
    secondMeta: expectedMetaBytes,
    trustedMetaAfter: trustedMetaBefore,
  });
});
