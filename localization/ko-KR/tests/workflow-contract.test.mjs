import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const customContract = join(repositoryRoot, 'localization', 'ko-KR', 'tests', 'custom-poe1-data.test.mjs');
const localeContract = join(repositoryRoot, 'tests', 'ko-KR', 'Test-KoreanLocale.ps1');
const termsContract = join(repositoryRoot, 'tests', 'ko-KR', 'Test-OfficialTerms.ps1');

function childEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

test('retained launcher dictionaries have the exact reviewed identities', () => {
  const launcherRoot = join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'launcher', 'ko-KR');
  assert.equal(sha256(join(launcherRoot, 'launcher.json')), '83401B058CD4F93029C5C87EE633DCE21D8A006357A1E02C483DD3E67ECCBBB0');
  assert.equal(sha256(join(launcherRoot, 'meta.json')), 'D7B59E5EB50FAA03877FC401393B18572AB89C7A296125D0D0D8B9751E3D790A');
});

test('custom-data contract rejects invalid explicit roots and reads supplied roots', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pobtools-custom-root-'));
  const missingRoot = join(fixtureRoot, 'missing');
  const invalid = spawnSync(process.execPath, ['--test', customContract], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: childEnvironment({ POBTOOLS_ENGINE_ROOT: missingRoot }),
  });
  assert.notEqual(invalid.status, 0, `${invalid.stdout}\n${invalid.stderr}`);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /POBTOOLS_ENGINE_ROOT must be an existing directory/u);

  const invalidReport = spawnSync(process.execPath, ['--test', customContract], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: childEnvironment({ POBTOOLS_ENGINE_ROOT: repositoryRoot, POBTOOLS_REPORT_ROOT: missingRoot }),
  });
  assert.notEqual(invalidReport.status, 0);
  assert.match(`${invalidReport.stdout}\n${invalidReport.stderr}`, /POBTOOLS_REPORT_ROOT must be an existing directory/u);

  const engineRoot = join(fixtureRoot, 'engine');
  const reportRoot = join(fixtureRoot, 'reports');
  writeJson(join(engineRoot, 'host', 'data', 'atlas_maps_poe1.json'), {
    maps: [{ id: 'SuppliedRoot', zhArea: '供應根', zhItem: '한국어' }],
  });
  writeJson(join(engineRoot, 'host', 'data', 'astrolabes_poe1.json'), { regions: [], astrolabes: [] });
  writeJson(join(engineRoot, 'host', 'data', 'scarabs_poe1.json'), { scarabs: [] });
  writeJson(join(engineRoot, 'host', 'data', 'regex_poe1.json'), { pages: [] });
  mkdirSync(join(engineRoot, 'host', 'data', 'atlas_versions'), { recursive: true });
  writeJson(join(engineRoot, 'host', 'data', 'timeless_jewels.json'), { conquerors: {}, additions: [], nodes: [] });
  writeJson(join(reportRoot, 'official-terms', 'custom-data.json'), {});
  const supplied = spawnSync(process.execPath, [
    '--test',
    '--test-name-pattern=PoE1 custom catalogues',
    customContract,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: childEnvironment({ POBTOOLS_ENGINE_ROOT: engineRoot, POBTOOLS_REPORT_ROOT: reportRoot }),
  });
  assert.notEqual(supplied.status, 0);
  assert.match(`${supplied.stdout}\n${supplied.stderr}`, /SuppliedRoot\.zhArea contains Han characters/u);
});

test('PowerShell contracts reject invalid roots and report supplied root paths', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pobtools-pwsh-root-'));
  const missingRoot = join(fixtureRoot, 'missing');
  for (const [script, arguments_, variableName] of [
    [localeContract, ['-EngineRoot', missingRoot], 'EngineRoot'],
    [termsContract, ['-EngineRoot', missingRoot], 'EngineRoot'],
    [termsContract, ['-ReportRoot', missingRoot], 'ReportRoot'],
  ]) {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', script, ...arguments_], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`${variableName} must be an existing directory`, 'u'));
  }

  const emptyEngine = join(fixtureRoot, 'empty-engine');
  const emptyReports = join(fixtureRoot, 'empty-reports');
  mkdirSync(emptyEngine);
  mkdirSync(emptyReports);
  const locale = spawnSync('pwsh', ['-NoProfile', '-File', localeContract, '-EngineRoot', emptyEngine], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.notEqual(locale.status, 0);
  assert.match(`${locale.stdout}\n${locale.stderr}`, new RegExp(emptyEngine.replaceAll('\\', '\\\\'), 'u'));

  const terms = spawnSync('pwsh', [
    '-NoProfile', '-File', termsContract,
    '-EngineRoot', emptyEngine,
    '-ReportRoot', emptyReports,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.notEqual(terms.status, 0);
  assert.match(`${terms.stdout}\n${terms.stderr}`, new RegExp(emptyReports.replaceAll('\\', '\\\\'), 'u'));
});

test('validate-ko workflow is a semantic read-only pinned validation contract', () => {
  const workflowPath = join(repositoryRoot, '.github', 'workflows', 'validate-ko.yml');
  const text = readFileSync(workflowPath, 'utf8');
  const lines = text.split(/\r?\n/u);
  const topLevelBlock = (name) => {
    const start = lines.findIndex((line) => line === `${name}:`);
    assert.notEqual(start, -1, `missing top-level ${name} block`);
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/u.test(lines[end]))) end += 1;
    return lines.slice(start, end).join('\n');
  };

  const triggers = topLevelBlock('on');
  assert.match(triggers, /\n  push:\n    branches: \[ko\/main\]/u);
  assert.match(triggers, /\n  pull_request:\n    branches: \[ko\/main\]/u);
  assert.match(triggers, /\n  workflow_dispatch:/u);

  assert.equal((text.match(/^permissions:/gmu) ?? []).length, 1);
  assert.equal(topLevelBlock('permissions').trim(), 'permissions:\n  contents: read');
  assert.doesNotMatch(text, /(?:contents|pull-requests|actions|checks|issues):\s*write/iu);
  assert.match(text, /runs-on:\s*(?:ubuntu-24\.04|windows-2025-vs2026)/u);

  const expectedActions = [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ];
  const actions = [...text.matchAll(/^\s*uses:\s*([^\s]+)\s*$/gmu)].map((match) => match[1]);
  assert.deepEqual(actions, expectedActions);
  for (const action of actions) assert.match(action, /^[^@]+@[0-9a-f]{40}$/u);

  assert.match(text, /python -m pip install -r localization\/ko-KR\/requirements-overlay\.txt/u);
  assert.match(text, /test_source_overlay\.py/u);
  assert.match(text, /test_overlay_remediation\.py/u);
  assert.match(text, /--upstream-ref ba33ed80de67d8301baad930456131d581df6ae1/u);
  assert.match(text, /--force-prepare/u);
  assert.match(text, /phases\.Count -ne 12/u);
  for (const arrayName of [
    'newStrings', 'suggestedStrings', 'ambiguousStrings', 'officialDataChanges',
    'compatibilityFailures', 'deterministicFailures', 'commandFailures', 'auditFailures',
  ]) assert.match(text, new RegExp(`'${arrayName}'`, 'u'));
  for (const phaseName of [
    'runtime-locale-build-1', 'runtime-locale-build-2',
    'custom-poe1-data-build-1', 'custom-poe1-data-build-2',
  ]) assert.match(text, new RegExp(`'${phaseName}'`, 'u'));

  assert.match(text, /POBTOOLS_ENGINE_ROOT/u);
  assert.match(text, /POBTOOLS_REPORT_ROOT/u);
  for (const retainedAsset of [
    'dist/Data/launcher/ko-KR/launcher.json',
    'dist/Data/launcher/ko-KR/meta.json',
    'dist/Fonts/NotoSansKR-Variable.ttf',
    'dist/Fonts/OFL-NotoSansKR.txt',
  ]) assert.match(text, new RegExp(retainedAsset.replaceAll('/', '\\/'), 'u'));
  assert.match(text, /Copy-Item -LiteralPath \$source -Destination \$destination/u);
  assert.match(text, /node --test localization\/ko-KR\/tests\/\*\.test\.mjs/u);
  assert.match(text, /Test-KoreanLocale\.ps1 -EngineRoot \$engineRoot/u);
  assert.match(text, /Test-OfficialTerms\.ps1 -EngineRoot \$engineRoot -ReportRoot \$reportRoot/u);

  assert.match(text, /\$\{\{ runner\.temp \}\}\/ko-validation-evidence/u);
  assert.match(text, /git restore --worktree -- reports\/display-closure\/locale-audit-summary\.json/u);
  assert.match(text, /Remove-Item -LiteralPath \$generatedReport -Force/u);
  const uploadIndex = lines.findIndex((line) => line.includes('actions/upload-artifact@'));
  assert.notEqual(uploadIndex, -1);
  const uploadBlock = lines.slice(uploadIndex, uploadIndex + 8).join('\n');
  assert.match(uploadBlock, /path:\s*\$\{\{ runner\.temp \}\}\/ko-validation-evidence/u);
  assert.doesNotMatch(uploadBlock, /reports\//u);

  assert.doesNotMatch(text, /\b(?:gh\s+release|git\s+push|git\s+commit|cmake|msbuild|\.exe\b|softprops\/action-gh-release)\b/iu);
  assert.doesNotMatch(text, /pull_request_target|create-pull-request|repository_dispatch/iu);
  assert.doesNotMatch(text, /git\s+(?:clean|reset)|Remove-Item\s+-Recurse/iu);
});
