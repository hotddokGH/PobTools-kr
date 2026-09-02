import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowPath = join(repositoryRoot, '.github', 'workflows', 'build-ko-preview.yml');

test('preview workflow is manual, read-only, pinned, and bound to exact ko/main identity', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule|release):/mu);
  assert.equal((workflow.match(/^permissions:/gmu) ?? []).length, 1);
  assert.match(workflow, /^permissions:\n  contents: read\s*$/mu);
  assert.doesNotMatch(workflow, /(?:contents|pull-requests|actions|checks|issues|packages):\s*write/iu);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/ko\/main'/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /git fetch --no-tags origin refs\/heads\/ko\/main/u);
  assert.match(workflow, /git rev-parse HEAD/u);
  assert.match(workflow, /git rev-parse origin\/ko\/main/u);
  assert.match(workflow, /github\.sha/u);

  const expectedActions = [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ];
  assert.deepEqual([...workflow.matchAll(/^\s*uses:\s*([^\s]+)\s*$/gmu)].map((match) => match[1]), expectedActions);
  for (const action of expectedActions) assert.match(action, /^[^@]+@[0-9a-f]{40}$/u);
});

test('preview workflow prepares and gates the reviewed detached engine before native build', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /upstream-state\.json/u);
  assert.match(workflow, /lastReviewedCommit/u);
  assert.match(workflow, /update-upstream\.mjs[\s\S]*--force-prepare/u);
  assert.match(workflow, /\.ko-worktrees\/release\/pob-zh-engine/u);
  assert.match(workflow, /classification[\s\S]*(?:already-processed|ready)/u);
  assert.match(workflow, /phases\.Count -ne 12/u);
  for (const name of [
    'newStrings', 'suggestedStrings', 'ambiguousStrings', 'officialDataChanges',
    'compatibilityFailures', 'deterministicFailures', 'commandFailures', 'auditFailures',
  ]) assert.match(workflow, new RegExp(`'${name}'`, 'u'));
  assert.match(workflow, /PSObject\.Properties\.Name[\s\S]*-cnotcontains/u);
  assert.match(workflow, /\$report\.phases -isnot \[array\]/u);
  assert.match(workflow, /\$report\.\$arrayName -isnot \[array\]/u);
  assert.match(workflow, /git -C \$engineRoot rev-parse HEAD/u);
  assert.doesNotMatch(workflow, /cmake\s+(?:-S|--build|--install)\s+pob-zh-engine(?:\s|$)/u);
  assert.match(workflow, /git clone[^\n]*microsoft\/vcpkg[^\n]*\.ko-worktrees\/release\/pob-zh-engine\/vcpkg/u);
  assert.match(workflow, /3d72d8c930e1b6a1b2432b262c61af7d3287dcd0/u);
  assert.match(workflow, /cmake -S \$engineRoot -B \$buildRoot[\s\S]*-DPOBTOOLS_KOREAN_RELEASE=ON/u);
  assert.match(workflow, /cmake --build \$buildRoot --config Release/u);
  assert.match(workflow, /cmake --install \$buildRoot --config Release --prefix \$installRoot/u);
});

test('preview workflow verifies offline unsigned executable, generated assets, package, provenance, and extracted ZIP', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const path of [
    'dist/Data/launcher/ko-KR/launcher.json', 'dist/Data/launcher/ko-KR/meta.json',
    'dist/Fonts/NotoSansKR-Variable.ttf', 'dist/Fonts/OFL-NotoSansKR.txt', 'dist/pob-zh.ini',
  ]) assert.match(workflow, new RegExp(path.replaceAll('/', '\\/'), 'u'));
  assert.match(workflow, /A75345BD3CC9AB480BD55C5B10B35364160EA426D21BFA65C2870E08982E7669/u);
  assert.match(workflow, /& \(Join-Path \$installRoot 'pob-zh\.exe'\) --font-coverage-selftest/u);
  assert.match(workflow, /font coverage self-test failed/u);
  assert.match(workflow, /& \(Join-Path \$installRoot 'pob-zh\.exe'\) --app-update-selftest/u);
  assert.match(workflow, /offline updater self-test failed/u);
  assert.match(workflow, /Get-AuthenticodeSignature/u);
  assert.match(workflow, /NotSigned/u);
  assert.doesNotMatch(workflow, /(?:--update-source|--app-update-check|--app-update)(?!-selftest)/u);
  assert.match(workflow, /Assemble-KoreanPackage\.ps1[\s\S]*-AssetRoot \$engineRoot/u);
  assert.match(workflow, /write-build-provenance\.mjs/u);
  assert.match(workflow, /--korean-automation-commit '\$\{\{ github\.sha \}\}'/u);
  assert.match(workflow, /Verify-KoreanPackageArchive\.ps1/u);
  assert.match(workflow, /preview-provenance\.json/u);
  assert.match(workflow, /PREVIEW-NOTES\.md/u);
  assert.match(workflow, /PobTools-Korean-preview\.zip\.sha256\.json/u);
  assert.match(workflow, /Remove-PreviewArtifacts/u);
  assert.match(workflow, /if: failure\(\)/u);
  const upload = workflow.slice(workflow.indexOf('actions/upload-artifact@'));
  for (const name of [
    'PobTools-Korean-preview.zip', 'PobTools-Korean-preview.zip.sha256.json',
    'preview-provenance.json', 'PREVIEW-NOTES.md',
  ]) assert.match(upload, new RegExp(name.replaceAll('.', '\\.')), `missing upload ${name}`);
  assert.doesNotMatch(workflow, /(?:gh\s+release|softprops\/action-gh-release|create-release|upload-release|git\s+push)/iu);
});
