import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalizeMaintenanceReport,
  classifyMaintenanceReport,
  prepareMaintenanceRun,
  validateCustomPoe1OutputManifest,
} from '../lib/upstream-maintenance.mjs';

const realRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliPath = join(realRepositoryRoot, 'localization', 'ko-KR', 'update-upstream.mjs');
const customOutputManifestPath = join(realRepositoryRoot, 'localization', 'ko-KR', 'custom-poe1-output-manifest.json');
const FIXED_CUSTOM_OUTPUT_PATHS = [
  'host/data/astrolabes_poe1.json',
  'host/data/atlas_maps_poe1.json',
  'host/data/regex_poe1.json',
  'host/data/scarabs_poe1.json',
  'host/data/timeless_jewels.json',
];
const REVIEWED_CUSTOM_OUTPUT_PATHS = [
  ...FIXED_CUSTOM_OUTPUT_PATHS,
  'host/data/atlas_versions/3.28.0/atlas_tree_zh.json',
  'host/data/atlas_versions/3.29.0/atlas_tree_zh.json',
  'host/data/atlas_versions/3.29.1/atlas_tree_zh.json',
].sort((left, right) => left.localeCompare(right, 'en'));
const UPPER_SHA256 = 'A'.repeat(64);

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function git(root, ...arguments_) {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' }).trim();
}

function commitAll(root, message) {
  git(root, 'add', '.');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function updateFixtureConfig(root, changes) {
  const path = join(root, 'localization', 'ko-KR', 'fixture-config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  write(path, `${JSON.stringify({ ...config, ...changes }, null, 2)}\n`);
}

function updateFixtureOutputManifest(root, mutate) {
  const path = join(root, 'localization', 'ko-KR', 'custom-poe1-output-manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  mutate(manifest);
  write(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function validCustomOutputManifest() {
  return {
    schemaVersion: 1,
    officialPoePatch: '3.29.3.2',
    hashPolicy: 'crlf-to-lf-sha256',
    outputs: FIXED_CUSTOM_OUTPUT_PATHS.map((path) => ({ path, sha256: UPPER_SHA256 })),
  };
}

function comparableCustomSha(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  const normalizedBytes = Buffer.from(bytes.toString('binary').replaceAll('\r\n', '\n'), 'binary');
  return createHash('sha256').update(normalizedBytes).digest('hex').toUpperCase();
}

const STABLE_CUSTOM_OUTPUT = '{"locale":"ko-KR","value":"stable"}\n';

test('maintenance report canonicalization preserves URI schemes and unrelated diagnostics', () => {
  const repositoryRoot = String.raw`C:\review space\신뢰-ko`;
  const workspaceRoot = String.raw`C:\review space\신뢰-ko\.ko-worktrees\작업`;
  const nodePath = String.raw`C:\Program Files\nodejs\node.exe`;
  const repositoryUrl = pathToFileURL(repositoryRoot).href;
  const workspaceUrl = pathToFileURL(workspaceRoot).href;
  const input = {
    phases: [{
      command: [
        nodePath,
        String.raw`C:\review space\신뢰-ko\.ko-worktrees\작업\pob-zh-engine\script.mjs`,
        'C:/review space/신뢰-ko/localization/ko-KR/source-translations.json',
        `${workspaceUrl}/pob-zh-engine/%ED%95%9C%EA%B8%80/script.mjs:12:3`,
        String.raw`prefixC:\review space\신뢰-ko\must-not-change`,
        `${repositoryUrl}ish/must-not-change.mjs`,
      ],
      stderr: String.raw`failed at C:\review space\신뢰-ko\.ko-worktrees\작업\pob-zh-engine\host\view.cpp; diagnostic \d+ stays`,
    }],
    auditFailures: [{
      detail: `repository ${repositoryUrl}/reports/detail.json and C:\\Program Files\\nodejs\\node.exe`,
    }],
  };
  const canonical = canonicalizeMaintenanceReport(input, { repositoryRoot, workspaceRoot, nodePath });
  assert.deepEqual(canonical, {
    phases: [{
      command: [
        '$NODE',
        '$WORKSPACE_ROOT/pob-zh-engine/script.mjs',
        '$REPOSITORY_ROOT/localization/ko-KR/source-translations.json',
        'file:///$WORKSPACE_ROOT/pob-zh-engine/%ED%95%9C%EA%B8%80/script.mjs:12:3',
        String.raw`prefixC:\review space\신뢰-ko\must-not-change`,
        `${repositoryUrl}ish/must-not-change.mjs`,
      ],
      stderr: String.raw`failed at $WORKSPACE_ROOT/pob-zh-engine/host/view.cpp; diagnostic \d+ stays`,
    }],
    auditFailures: [{
      detail: 'repository file:///$REPOSITORY_ROOT/reports/detail.json and $NODE',
    }],
  });
  assert.notEqual(canonical, input);
});

test('custom PoE1 output manifest schema and real inventory fail closed', () => {
  const state = { officialPoePatch: '3.29.3.2' };
  const realManifest = JSON.parse(readFileSync(customOutputManifestPath, 'utf8'));
  const validated = validateCustomPoe1OutputManifest(realManifest, state);
  assert.deepEqual(validated.map((row) => row.path), REVIEWED_CUSTOM_OUTPUT_PATHS);
  assert.equal(validated.every((row) => /^[0-9A-F]{64}$/u.test(row.sha256)), true);

  const invalidManifests = {
    malformed_root: [],
    unknown_root_key: { ...validCustomOutputManifest(), extra: true },
    wrong_schema: { ...validCustomOutputManifest(), schemaVersion: 2 },
    stale_patch: { ...validCustomOutputManifest(), officialPoePatch: '3.29.3.1' },
    wrong_policy: { ...validCustomOutputManifest(), hashPolicy: 'sha256' },
    unknown_entry_key: {
      ...validCustomOutputManifest(),
      outputs: validCustomOutputManifest().outputs.map((row, index) => index === 0 ? { ...row, extra: true } : row),
    },
    traversal: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, { path: 'host/data/atlas_versions/../atlas_tree_zh.json', sha256: UPPER_SHA256 }],
    },
    backslash: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, { path: 'host\\data\\atlas_versions\\3.30.0\\atlas_tree_zh.json', sha256: UPPER_SHA256 }],
    },
    absolute_posix: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, { path: '/host/data/atlas_maps_poe1.json', sha256: UPPER_SHA256 }],
    },
    absolute_windows: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, { path: 'C:/host/data/atlas_maps_poe1.json', sha256: UPPER_SHA256 }],
    },
    duplicate: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, validCustomOutputManifest().outputs[0]],
    },
    unsorted: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs].reverse(),
    },
    unknown_host_path: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, { path: 'host/data/new_output.json', sha256: UPPER_SHA256 }],
    },
    missing_fixed: {
      ...validCustomOutputManifest(),
      outputs: validCustomOutputManifest().outputs.slice(1),
    },
    lowercase_hash: {
      ...validCustomOutputManifest(),
      outputs: validCustomOutputManifest().outputs.map((row, index) => index === 0 ? { ...row, sha256: 'a'.repeat(64) } : row),
    },
    poe2: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, { path: 'host/data/regex_poe2.json', sha256: UPPER_SHA256 }],
    },
    nested_atlas_version: {
      ...validCustomOutputManifest(),
      outputs: [...validCustomOutputManifest().outputs, { path: 'host/data/atlas_versions/3.30.0/nested/atlas_tree_zh.json', sha256: UPPER_SHA256 }],
    },
  };
  for (const [name, manifest] of Object.entries(invalidManifests)) {
    assert.throws(
      () => validateCustomPoe1OutputManifest(manifest, state),
      { name: 'Error' },
      name,
    );
  }
});

const overlayScript = String.raw`import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=("audit", "apply"))
parser.add_argument("--source-root", type=Path, required=True)
parser.add_argument("--mapping", type=Path, required=True)
parser.add_argument("--policy", type=Path, required=True)
parser.add_argument("--report", type=Path, required=True)
parser.add_argument("--compatibility-patch", type=Path, required=True)
args = parser.parse_args()
trusted_root = Path(__file__).resolve().parents[3]
log = trusted_root / "localization" / "ko-KR" / "invocations.jsonl"
with log.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps({"script": str(Path(__file__).resolve()), "arguments": __import__("sys").argv[1:]}, ensure_ascii=False) + "\n")
fixture_config = json.loads((trusted_root / "localization" / "ko-KR" / "fixture-config.json").read_text(encoding="utf-8"))
required_lf_path = fixture_config.get("requiredLfSourcePath")
if required_lf_path and b"\r\n" in (args.source_root / required_lf_path).read_bytes():
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({"filesScanned": 0, "issues": [{"code": "CPP_BYTES_NOT_LF", "path": required_lf_path}]}, sort_keys=True) + "\n", encoding="utf-8")
    raise SystemExit(1)
required_post_patch_path = fixture_config.get("requiredPostPatchPath")
if required_post_patch_path:
    post_patch_bytes = (args.source_root / required_post_patch_path).read_bytes()
    actual_post_patch_sha = hashlib.sha256(post_patch_bytes).hexdigest().upper()
    expected_post_patch_sha = fixture_config["expectedPostPatchSha256"]
    if b"\r\n" in post_patch_bytes or actual_post_patch_sha != expected_post_patch_sha:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({"filesScanned": 0, "issues": [{"code": "POST_PATCH_BYTES_NOT_REVIEWED", "path": required_post_patch_path, "actualSha256": actual_post_patch_sha, "expectedSha256": expected_post_patch_sha}]}, sort_keys=True) + "\n", encoding="utf-8")
        raise SystemExit(1)
redirect_target = fixture_config.get("nestedRedirectTarget")
if redirect_target:
    redirect_path = args.source_root / "dist" / "Data" / "poe1" / "ko-KR"
    if not redirect_path.exists():
        redirect_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            fixture_config["nodePath"],
            "-e",
            "require('node:fs').symlinkSync(process.argv[1], process.argv[2], process.platform === 'win32' ? 'junction' : 'dir')",
            redirect_target,
            str(redirect_path),
        ], check=True)
mapping = json.loads(args.mapping.read_text(encoding="utf-8"))["entries"]
issues = []
plans = []
for path in sorted(args.source_root.rglob("view.cpp")):
    text = path.read_text(encoding="utf-8")
    relative = path.relative_to(args.source_root).as_posix()
    for line_number, line in enumerate(text.splitlines(), 1):
        for source in re.findall(r'u8"([^"\\]*)"', line):
            if not re.search(r'[\u3400-\u4dbf\u4e00-\u9fff]', source):
                continue
            row = mapping.get(source)
            if row is None:
                issues.append({"code": "MISSING_MAPPING", "path": relative, "function": "fixture", "line": line_number, "source": source})
            elif row.get("status") in ("suggested", "ambiguous"):
                issues.append({"code": row["status"].upper(), "path": relative, "function": "fixture", "line": line_number, "source": source})
            else:
                plans.append((path, source, row["target"]))
report = {"filesScanned": len(list(args.source_root.rglob("*.cpp"))), "issues": issues}
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
if not issues and args.mode == "apply":
    for path, source, target in plans:
        path.write_text(path.read_text(encoding="utf-8").replace('u8"' + source + '"', 'u8"' + target + '"'), encoding="utf-8")
raise SystemExit(1 if issues else 0)
`;

const runtimeBuilder = String.raw`import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const trustedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], resolve(process.argv[index + 1]));
if (!values.has('--engine-root') || !values.has('--report-root')) throw new Error('explicit roots required');
appendFileSync(join(trustedRoot, 'localization', 'ko-KR', 'invocations.jsonl'), JSON.stringify({ script: fileURLToPath(import.meta.url), arguments: process.argv.slice(2) }) + '\n');
const engineRoot = values.get('--engine-root');
const reportRoot = values.get('--report-root');
const config = JSON.parse(readFileSync(join(trustedRoot, 'localization', 'ko-KR', 'fixture-config.json'), 'utf8'));
let value = 'stable';
if (config.nondeterministic) {
  const sequencePath = join(reportRoot, 'runtime-sequence.txt');
  const sequence = Number(readFileSync(sequencePath, { encoding: 'utf8', flag: 'a+' }) || 0) + 1;
  writeFileSync(sequencePath, String(sequence));
  value = String(sequence);
}
const output = join(engineRoot, 'dist', 'Data', 'poe1', 'ko-KR', 'ui.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ value }) + '\n');
mkdirSync(reportRoot, { recursive: true });
writeFileSync(join(reportRoot, 'runtime-build.json'), JSON.stringify({ value }) + '\n');
`;

const customBuilder = String.raw`import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const trustedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], resolve(process.argv[index + 1]));
if (!values.has('--engine-root') || !values.has('--report-root')) throw new Error('explicit roots required');
appendFileSync(join(trustedRoot, 'localization', 'ko-KR', 'invocations.jsonl'), JSON.stringify({ script: fileURLToPath(import.meta.url), arguments: process.argv.slice(2) }) + '\n');
const config = JSON.parse(readFileSync(join(trustedRoot, 'localization', 'ko-KR', 'fixture-config.json'), 'utf8'));
const fixedOutputs = ${JSON.stringify(FIXED_CUSTOM_OUTPUT_PATHS)};
for (const path of fixedOutputs) {
  if (config.omitFixedOutput === path) continue;
  const output = join(values.get('--engine-root'), path);
  const contents = path === 'host/data/atlas_maps_poe1.json'
    ? (config.poe1OutputContents ?? JSON.stringify({ locale: 'ko-KR', value: config.poe1OutputChanged ? 'changed' : 'stable' }) + '\n')
    : ${JSON.stringify(STABLE_CUSTOM_OUTPUT)};
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, contents);
}
if (config.generatedAtlasVersion) {
  const output = join(values.get('--engine-root'), 'host', 'data', 'atlas_versions', config.generatedAtlasVersion, 'atlas_tree_zh.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ locale: 'ko-KR', version: config.generatedAtlasVersion }) + '\n');
}
for (const [enabled, path] of [
  [config.unknownRootOutput, 'host/data/future_output.json'],
  [config.nestedOutput, 'host/data/future/nested/output.json'],
]) {
  if (enabled) {
    const output = join(values.get('--engine-root'), path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, '{"value":"new"}\n');
  }
}
if (config.changedPoe2Output) writeFileSync(join(values.get('--engine-root'), 'host', 'data', 'regex_poe2.json'), '{"value":"changed"}\n');
if (config.nondeterministicCustomOutput) {
  const sequencePath = join(values.get('--report-root'), 'custom-sequence.txt');
  const sequence = Number(readFileSync(sequencePath, { encoding: 'utf8', flag: 'a+' }) || 0) + 1;
  writeFileSync(sequencePath, String(sequence));
  writeFileSync(join(values.get('--engine-root'), 'host', 'data', 'future_output.json'), String(sequence));
}
if (config.nestedHostDataReparse) {
  const reparsePath = join(values.get('--engine-root'), 'host', 'data', 'future', 'arbitrary', 'nested');
  mkdirSync(dirname(reparsePath), { recursive: true });
  symlinkSync(config.nestedHostDataReparseTarget, reparsePath, 'junction');
}
mkdirSync(values.get('--report-root'), { recursive: true });
writeFileSync(join(values.get('--report-root'), 'custom-data.json'), '{"unresolved":0}\n');
`;

function auditScript(sourceAudit = false) {
  return String.raw`import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const trustedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], resolve(process.argv[index + 1]));
if (!values.has('--engine-root') || !values.has('${sourceAudit ? '--report' : '--report-root'}')) throw new Error('explicit roots required');
appendFileSync(join(trustedRoot, 'localization', 'ko-KR', 'invocations.jsonl'), JSON.stringify({ script: fileURLToPath(import.meta.url), arguments: process.argv.slice(2) }) + '\n');
const reportPath = ${sourceAudit ? "values.get('--report')" : "join(values.get('--report-root'), 'locale-audit.json')"};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, '{"issues":[]}\n');
const config = JSON.parse(readFileSync(join(trustedRoot, 'localization', 'ko-KR', 'fixture-config.json'), 'utf8'));
if (${sourceAudit} && config.unsafeTrustedIniDestination) {
  symlinkSync(config.unsafeTrustedIniTarget, join(values.get('--engine-root'), 'dist', 'pob-zh.ini'), 'junction');
}
`;
}

const contractTest = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
test('uses the explicit detached engine', () => assert.equal(existsSync(join(process.env.POBTOOLS_ENGINE_ROOT, 'host')), true));
`;

async function makeUpstreamFixture(t, {
  second = '',
  breakPatch = false,
  lastReviewed = 'first',
  nondeterministic = false,
  nestedRedirect = false,
  poe1OutputChanged = false,
  poe2Difference = false,
  trustedOnlyAtlasVersion = false,
  generatedAtlasVersion = undefined,
  omitFixedOutput = undefined,
  unknownRootOutput = false,
  nestedOutput = false,
  changedPoe2Output = false,
  nondeterministicCustomOutput = false,
  coreAutocrlf = false,
  unsafeTrustedIniDestination = false,
} = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pobtools-ko-maintenance-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const koRoot = join(temporaryRoot, 'trusted-ko');
  mkdirSync(koRoot, { recursive: true });
  git(koRoot, 'init');
  git(koRoot, 'config', 'user.email', 'test@example.invalid');
  git(koRoot, 'config', 'user.name', 'Maintenance Test');
  git(koRoot, 'config', 'core.autocrlf', coreAutocrlf ? 'true' : 'false');
  const reviewedManifest = JSON.parse(readFileSync(join(realRepositoryRoot, 'localization', 'ko-KR', 'compat', 'manifest.json'), 'utf8'));
  for (const path of reviewedManifest.allowedPaths) {
    write(join(koRoot, path), execFileSync('git', ['show', `${reviewedManifest.baseCommit}:${path}`], { cwd: realRepositoryRoot }));
  }
  write(join(koRoot, 'pob-zh-engine', 'host', 'view.cpp'), 'ImGui::Text(u8"設定");\n');
  if (coreAutocrlf) write(join(koRoot, 'pob-zh-engine', 'host', 'policy.cpp'), 'int policy_stable = 1;\n');
  if (poe2Difference || changedPoe2Output) write(join(koRoot, 'pob-zh-engine', 'host', 'data', 'regex_poe2.json'), '{"value":"upstream"}\n');
  write(join(koRoot, 'upstream-sequence.txt'), 'first\n');
  const firstCommit = commitAll(koRoot, 'upstream first');
  if (breakPatch) write(join(koRoot, 'pob-zh-engine', 'host', 'app_update.cpp'), 'int compatibility_is_broken = 99;\n');
  if (second) write(join(koRoot, 'pob-zh-engine', 'host', 'view.cpp'), `ImGui::Text(u8"設定");\n${second}\n`);
  write(join(koRoot, 'upstream-sequence.txt'), 'second\n');
  const secondCommit = commitAll(koRoot, 'upstream second');
  if (poe2Difference) write(join(koRoot, 'pob-zh-engine', 'host', 'data', 'regex_poe2.json'), '{"value":"trusted-only-change"}\n');
  write(join(koRoot, '.gitignore'), '.ko-worktrees/\n');
  write(join(koRoot, 'localization', 'ko-KR', 'compat', 'pobtools-ko.patch'), readFileSync(join(realRepositoryRoot, 'localization', 'ko-KR', 'compat', 'pobtools-ko.patch')));
  write(join(koRoot, 'localization', 'ko-KR', 'compat', 'manifest.json'), `${JSON.stringify(reviewedManifest, null, 2)}\n`);
  write(join(koRoot, 'localization', 'ko-KR', 'source-translations.json'), `${JSON.stringify({
    entries: { '設定': { target: '설정', status: 'reviewed' } },
    contexts: [],
  }, null, 2)}\n`);
  write(join(koRoot, 'localization', 'ko-KR', 'source-display-policy.json'), '{"parseRecoveryAllowlist":[]}\n');
  write(join(koRoot, 'localization', 'ko-KR', 'display-policy.json'), '{}\n');
  write(
    join(koRoot, 'pob-zh-engine', 'dist', 'pob-zh.ini'),
    readFileSync(join(realRepositoryRoot, 'pob-zh-engine', 'dist', 'pob-zh.ini'), 'utf8'),
  );
  const nestedRedirectTarget = nestedRedirect ? join(temporaryRoot, 'external-runtime') : undefined;
  if (nestedRedirectTarget) {
    mkdirSync(nestedRedirectTarget, { recursive: true });
    write(join(nestedRedirectTarget, 'ui.json'), '{"value":"external-original"}\n');
  }
  const unsafeTrustedIniTarget = unsafeTrustedIniDestination ? join(temporaryRoot, 'external-pob-zh.ini') : undefined;
  if (unsafeTrustedIniTarget) {
    mkdirSync(unsafeTrustedIniTarget);
    write(join(unsafeTrustedIniTarget, 'sentinel.txt'), 'external-original\n');
  }
  write(join(koRoot, 'localization', 'ko-KR', 'fixture-config.json'), `${JSON.stringify({
    nestedRedirectTarget,
    nodePath: process.execPath,
    nondeterministic,
    poe1OutputChanged,
    generatedAtlasVersion,
    omitFixedOutput,
    unknownRootOutput,
    nestedOutput,
    changedPoe2Output,
    nondeterministicCustomOutput,
    requiredLfSourcePath: coreAutocrlf ? 'host/policy.cpp' : undefined,
    requiredPostPatchPath: coreAutocrlf ? 'host/app_update.cpp' : undefined,
    expectedPostPatchSha256: coreAutocrlf
      ? '7C2B6D329D066DFAE51FA34D64D2DDEBB2E6A777E683E7474D6BCB76157D4803'
      : undefined,
    unsafeTrustedIniDestination,
    unsafeTrustedIniTarget,
  })}\n`);
  write(join(koRoot, 'localization', 'ko-KR', 'lib', 'source_overlay.py'), overlayScript);
  write(join(koRoot, 'localization', 'ko-KR', 'build-runtime-locale.mjs'), runtimeBuilder);
  write(join(koRoot, 'localization', 'ko-KR', 'build-custom-poe1-data.mjs'), customBuilder);
  write(join(koRoot, 'localization', 'ko-KR', 'audit-display-closure.mjs'), auditScript(false));
  write(join(koRoot, 'localization', 'ko-KR', 'audit-source-display.mjs'), auditScript(true));
  write(join(koRoot, 'localization', 'ko-KR', 'tests', 'korean-update-contract.test.mjs'), contractTest);
  write(join(koRoot, 'localization', 'ko-KR', 'tests', 'filter-i18n-contract.test.mjs'), contractTest);
  const outputManifest = validCustomOutputManifest();
  outputManifest.outputs = FIXED_CUSTOM_OUTPUT_PATHS.map((path) => ({
    path,
    sha256: comparableCustomSha(STABLE_CUSTOM_OUTPUT),
  }));
  if (trustedOnlyAtlasVersion) {
    outputManifest.outputs.push({
      path: 'host/data/atlas_versions/3.28.0/atlas_tree_zh.json',
      sha256: comparableCustomSha('{"locale":"ko-KR","version":"3.28.0"}\n'),
    });
    outputManifest.outputs.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  }
  write(
    join(koRoot, 'localization', 'ko-KR', 'custom-poe1-output-manifest.json'),
    `${JSON.stringify(outputManifest, null, 2)}\n`,
  );
  write(join(koRoot, 'localization', 'ko-KR', 'upstream-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    lastReviewedCommit: lastReviewed === 'second' ? secondCommit : firstCommit,
    officialPoePatch: '3.29.3.2',
  }, null, 2)}\n`);
  write(join(koRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR', 'ui.json'), '{"value":"stable"}\n');
  for (const path of FIXED_CUSTOM_OUTPUT_PATHS) write(join(koRoot, 'pob-zh-engine', path), STABLE_CUSTOM_OUTPUT);
  commitAll(koRoot, 'trusted Korean automation');
  const workspace = join(koRoot, '.ko-worktrees', 'update');
  return { firstCommit, koRoot, nestedRedirectTarget, secondCommit, unsafeTrustedIniTarget, workspace };
}

function cloneFixtureToIndependentRoot(t, fixture, label) {
  const cloneContainer = mkdtempSync(join(tmpdir(), `pobtools-ko-${label}-`));
  t.after(() => rmSync(cloneContainer, { recursive: true, force: true }));
  const clonedRoot = join(cloneContainer, 'trusted-ko-clone');
  execFileSync('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    'clone', '--quiet', fixture.koRoot, clonedRoot,
  ], { encoding: 'utf8' });
  return {
    repositoryRoot: clonedRoot,
    workspaceRoot: join(clonedRoot, '.ko-worktrees', 'update'),
  };
}

test('new upstream literal becomes one review row and exit class review-required', async (t) => {
  const fixture = await makeUpstreamFixture(t, { second: 'ImGui::Text(u8"新增");' });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'review-required');
  assert.deepEqual(result.report.newStrings.map((row) => row.source), ['新增']);
  assert.equal(result.report.compatibilityFailures.length, 0);
});

test('unchanged upstream prepares a reusable detached workspace and a ready report', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const first = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  const firstReport = readFileSync(join(fixture.koRoot, 'reports', 'maintenance', 'upstream-update.json'), 'utf8');
  const second = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  const secondReport = readFileSync(join(fixture.koRoot, 'reports', 'maintenance', 'upstream-update.json'), 'utf8');
  assert.equal(first.report.classification, 'ready');
  assert.equal(second.report.classification, 'ready');
  assert.equal(first.commit, fixture.secondCommit);
  assert.equal(git(fixture.workspace, 'rev-parse', 'HEAD'), fixture.secondCommit);
  assert.equal(firstReport, secondReport);
  assert.equal(firstReport.includes('timestamp'), false);
});

test('identical fixture runs persist byte-identical reports across checkout roots', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const clone = cloneFixtureToIndependentRoot(t, fixture, 'cross-root');

  const first = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
    forcePrepare: true,
  });
  const second = await prepareMaintenanceRun({
    repositoryRoot: clone.repositoryRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: clone.workspaceRoot,
    forcePrepare: true,
  });
  const firstBytes = readFileSync(join(fixture.koRoot, 'reports', 'maintenance', 'upstream-update.json'), 'utf8');
  const secondBytes = readFileSync(join(clone.repositoryRoot, 'reports', 'maintenance', 'upstream-update.json'), 'utf8');

  assert.equal(firstBytes, secondBytes);
  assert.deepEqual(first.report, second.report);
  for (const root of [fixture.koRoot, fixture.workspace, clone.repositoryRoot, clone.workspaceRoot]) {
    for (const form of new Set([root, root.replaceAll('\\', '/'), pathToFileURL(root).href])) {
      assert.equal(firstBytes.includes(form), false);
    }
  }
  assert.match(firstBytes, /\$WORKSPACE_ROOT/u);
  assert.match(firstBytes, /\$REPOSITORY_ROOT/u);
  assert.match(firstBytes, /\$NODE/u);
});

test('worktree preparation keeps policy-reviewed C++ bytes LF under core.autocrlf=true', async (t) => {
  const fixture = await makeUpstreamFixture(t, { coreAutocrlf: true });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  const checkedOutSource = readFileSync(join(fixture.workspace, 'pob-zh-engine', 'host', 'policy.cpp'), 'utf8');
  const postPatchBytes = readFileSync(join(fixture.workspace, 'pob-zh-engine', 'host', 'app_update.cpp'));
  const expectedGitPrefix = ['git', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply'];
  assert.equal(git(fixture.koRoot, 'config', 'core.autocrlf'), 'true');
  assert.equal(checkedOutSource, 'int policy_stable = 1;\n');
  assert.equal(result.report.phases.find((row) => row.name === 'source-overlay-audit')?.exitCode, 0);
  assert.equal(result.report.phases.some((row) => row.name === 'runtime-locale-build-1'), true);
  assert.equal(postPatchBytes.includes(Buffer.from('\r\n')), false);
  assert.equal(createHash('sha256').update(postPatchBytes).digest('hex').toUpperCase(), '7C2B6D329D066DFAE51FA34D64D2DDEBB2E6A777E683E7474D6BCB76157D4803');
  assert.deepEqual(result.report.phases.find((row) => row.name === 'compatibility-patch-check')?.command.slice(0, 6), expectedGitPrefix);
  assert.deepEqual(result.report.phases.find((row) => row.name === 'compatibility-patch-apply')?.command.slice(0, 6), expectedGitPrefix);
  assert.equal(result.report.classification, 'ready');
});

test('trusted Korean distribution input is staged when the upstream commit has no ini', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const relativeIni = 'pob-zh-engine/dist/pob-zh.ini';
  assert.equal(spawnSync('git', ['cat-file', '-e', `${fixture.secondCommit}:${relativeIni}`], { cwd: fixture.koRoot }).status, 128);
  assert.equal(git(fixture.koRoot, 'ls-files', '--error-unmatch', relativeIni), relativeIni);
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  const trustedBytes = readFileSync(join(fixture.koRoot, relativeIni));
  const stagedBytes = readFileSync(join(fixture.workspace, relativeIni));
  assert.equal(createHash('sha256').update(trustedBytes).digest('hex').toUpperCase(), 'A75345BD3CC9AB480BD55C5B10B35364160EA426D21BFA65C2870E08982E7669');
  assert.deepEqual(stagedBytes, trustedBytes);
  assert.equal(result.report.phases.find((row) => row.name === 'trusted-distribution-input-stage')?.exitCode, 0);
  assert.equal(result.report.phases.find((row) => row.name === 'static-korean-behavior-contracts')?.exitCode, 0);
  assert.equal(result.report.classification, 'ready');
});

test('tampered trusted Korean distribution input blocks before behavior contracts', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const trustedIni = join(fixture.koRoot, 'pob-zh-engine', 'dist', 'pob-zh.ini');
  write(trustedIni, `${readFileSync(trustedIni, 'utf8')}tampered=1\n`);
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.deepEqual(result.report.commandFailures.map((row) => row.phase), ['trusted-distribution-input-stage']);
  assert.equal(result.report.phases.find((row) => row.name === 'trusted-distribution-input-stage')?.exitCode, 1);
  assert.equal(result.report.phases.some((row) => row.name === 'static-korean-behavior-contracts'), false);
});

test('missing, untracked, or non-regular trusted Korean distribution input blocks before behavior contracts', async (t) => {
  for (const sourceKind of ['missing', 'untracked', 'directory']) {
    await t.test(sourceKind, async (t) => {
      const fixture = await makeUpstreamFixture(t);
      const trustedIni = join(fixture.koRoot, 'pob-zh-engine', 'dist', 'pob-zh.ini');
      if (sourceKind === 'untracked') git(fixture.koRoot, 'rm', '--cached', '--', 'pob-zh-engine/dist/pob-zh.ini');
      else {
        rmSync(trustedIni);
        if (sourceKind === 'directory') mkdirSync(trustedIni);
      }
      const result = await prepareMaintenanceRun({
        repositoryRoot: fixture.koRoot,
        upstreamRef: fixture.secondCommit,
        workspaceRoot: fixture.workspace,
      });
      assert.equal(result.report.classification, 'blocked');
      assert.deepEqual(result.report.commandFailures.map((row) => row.phase), ['trusted-distribution-input-stage']);
      assert.equal(result.report.phases.some((row) => row.name === 'static-korean-behavior-contracts'), false);
    });
  }
});

test('unsafe staged ini destination blocks before behavior contracts and preserves external bytes', async (t) => {
  const fixture = await makeUpstreamFixture(t, { unsafeTrustedIniDestination: true });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.deepEqual(result.report.commandFailures.map((row) => row.phase), ['trusted-distribution-input-stage']);
  assert.equal(result.report.phases.find((row) => row.name === 'trusted-distribution-input-stage')?.exitCode, 1);
  assert.equal(result.report.phases.some((row) => row.name === 'static-korean-behavior-contracts'), false);
  assert.equal(readFileSync(join(fixture.unsafeTrustedIniTarget, 'sentinel.txt'), 'utf8'), 'external-original\n');
});

test('already processed commit returns without preparing a workspace', async (t) => {
  const fixture = await makeUpstreamFixture(t, { lastReviewed: 'second' });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'already-processed');
  assert.equal(existsSync(fixture.workspace), false);
  assert.deepEqual(result.report.phases, []);
});

test('force prepare runs an already processed commit through a fresh detached workspace', async (t) => {
  const fixture = await makeUpstreamFixture(t, { lastReviewed: 'second' });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
    forcePrepare: true,
  });
  assert.equal(result.report.classification, 'already-processed');
  assert.equal(git(fixture.workspace, 'rev-parse', 'HEAD'), fixture.secondCommit);
  assert.ok(result.report.phases.length > 0);
});

test('workspace equality and traversal are rejected before worktree creation', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const allowedRoot = join(fixture.koRoot, '.ko-worktrees');
  await assert.rejects(
    prepareMaintenanceRun({ repositoryRoot: fixture.koRoot, upstreamRef: fixture.secondCommit, workspaceRoot: allowedRoot }),
    /workspace must be a direct child/u,
  );
  await assert.rejects(
    prepareMaintenanceRun({ repositoryRoot: fixture.koRoot, upstreamRef: fixture.secondCommit, workspaceRoot: join(fixture.koRoot, 'outside') }),
    /workspace must be a direct child/u,
  );
  assert.equal(existsSync(join(fixture.koRoot, 'outside')), false);
});

test('locked registered worktree failure overwrites stale reports as blocked for library and CLI', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  mkdirSync(dirname(fixture.workspace), { recursive: true });
  git(fixture.koRoot, 'worktree', 'add', '--detach', fixture.workspace, fixture.secondCommit);
  git(fixture.koRoot, 'worktree', 'lock', '--reason', 'fixture lock', fixture.workspace);
  const reportPath = join(fixture.koRoot, 'reports', 'maintenance', 'locked.json');
  write(reportPath, '{"stale":true}\n');
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
    reportPath,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.deepEqual(result.report.commandFailures.map((row) => row.phase), ['worktree-remove']);
  assert.deepEqual(result.report.phases.map((row) => row.name), ['worktree-remove']);
  assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), result.report);

  const cliFixture = await makeUpstreamFixture(t);
  mkdirSync(dirname(cliFixture.workspace), { recursive: true });
  git(cliFixture.koRoot, 'worktree', 'add', '--detach', cliFixture.workspace, cliFixture.secondCommit);
  git(cliFixture.koRoot, 'worktree', 'lock', '--reason', 'fixture lock', cliFixture.workspace);
  const cliReportPath = join(cliFixture.koRoot, 'reports', 'maintenance', 'locked-cli.json');
  write(cliReportPath, '{"stale":true}\n');
  const cli = spawnSync(process.execPath, [
    cliPath,
    '--repository-root', cliFixture.koRoot,
    '--upstream-ref', cliFixture.secondCommit,
    '--workspace', cliFixture.workspace,
    '--report', cliReportPath,
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  const cliReport = JSON.parse(readFileSync(cliReportPath, 'utf8'));
  assert.equal(cliReport.classification, 'blocked');
  assert.deepEqual(cliReport.commandFailures.map((row) => row.phase), ['worktree-remove']);
});

test('existing workspace reparse point is rejected', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const target = join(fixture.koRoot, 'junction-target');
  mkdirSync(dirname(fixture.workspace), { recursive: true });
  mkdirSync(target);
  symlinkSync(target, fixture.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    prepareMaintenanceRun({ repositoryRoot: fixture.koRoot, upstreamRef: fixture.secondCommit, workspaceRoot: fixture.workspace }),
    /symbolic link|junction|reparse/u,
  );
});

test('nested writable-scope junction blocks before the runtime builder can write outside the engine', async (t) => {
  const fixture = await makeUpstreamFixture(t, { nestedRedirect: true });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.equal(result.report.phases.some((row) => row.name === 'runtime-locale-build-1'), false);
  assert.equal(readFileSync(join(fixture.nestedRedirectTarget, 'ui.json'), 'utf8'), '{"value":"external-original"}\n');
});

test('failed compatibility hunk produces a blocked report and stops later phases', async (t) => {
  const fixture = await makeUpstreamFixture(t, { breakPatch: true });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.equal(result.report.compatibilityFailures.length, 1);
  assert.deepEqual(result.report.phases.map((phase) => phase.name), ['compatibility-patch-check']);
  assert.equal(existsSync(join(fixture.workspace, 'preview.zip')), false);
});

test('coordinated compatibility patch and manifest mutation is rejected before Git apply', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const patchPath = join(fixture.koRoot, 'localization', 'ko-KR', 'compat', 'pobtools-ko.patch');
  const manifestPath = join(fixture.koRoot, 'localization', 'ko-KR', 'compat', 'manifest.json');
  const mutatedPatch = `${readFileSync(patchPath, 'utf8')}\n`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.sha256 = createHash('sha256').update(mutatedPatch).digest('hex').toUpperCase();
  write(patchPath, mutatedPatch);
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.equal(result.report.compatibilityFailures.length, 1);
  assert.equal(result.report.phases.some((row) => row.name.startsWith('compatibility-patch-')), false);
});

test('nondeterministic runtime generation is hash-compared and blocked', async (t) => {
  const fixture = await makeUpstreamFixture(t, { nondeterministic: true });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.deepEqual(result.report.deterministicFailures.map((row) => row.phase), ['runtime-locale-build']);
  assert.equal(result.report.phases.some((phase) => phase.name === 'custom-poe1-data-build-1'), false);
});

test('nondeterministic blocked reports are byte-identical across checkout roots', async (t) => {
  for (const [label, options, expectedPhase] of [
    ['runtime', { nondeterministic: true }, 'runtime-locale-build'],
    ['custom', { nondeterministicCustomOutput: true }, 'custom-poe1-data-build'],
  ]) {
    await t.test(label, async (t) => {
      const fixture = await makeUpstreamFixture(t, options);
      const clone = cloneFixtureToIndependentRoot(t, fixture, `blocked-${label}`);
      const first = await prepareMaintenanceRun({
        repositoryRoot: fixture.koRoot,
        upstreamRef: fixture.secondCommit,
        workspaceRoot: fixture.workspace,
        forcePrepare: true,
      });
      const second = await prepareMaintenanceRun({
        repositoryRoot: clone.repositoryRoot,
        upstreamRef: fixture.secondCommit,
        workspaceRoot: clone.workspaceRoot,
        forcePrepare: true,
      });
      const firstBytes = readFileSync(join(fixture.koRoot, 'reports', 'maintenance', 'upstream-update.json'));
      const secondBytes = readFileSync(join(clone.repositoryRoot, 'reports', 'maintenance', 'upstream-update.json'));

      assert.equal(first.report.classification, 'blocked');
      assert.equal(second.report.classification, 'blocked');
      assert.deepEqual(first.report.deterministicFailures.map((row) => row.phase), [expectedPhase]);
      assert.deepEqual(first.report.deterministicFailures, second.report.deterministicFailures);
      assert.deepEqual(firstBytes, secondBytes);
      const persisted = firstBytes.toString('utf8');
      for (const root of [fixture.koRoot, fixture.workspace, clone.repositoryRoot, clone.workspaceRoot]) {
        for (const form of new Set([root, root.replaceAll('\\', '/'), pathToFileURL(root).href])) {
          assert.equal(persisted.includes(form), false);
        }
      }
      assert.match(persisted, /\$WORKSPACE_ROOT/u);
      assert.match(persisted, /\$REPOSITORY_ROOT/u);
    });
  }
});

test('custom-data hashes and review changes include exact PoE1 outputs but ignore PoE2', async (t) => {
  const poe2 = await makeUpstreamFixture(t, { poe2Difference: true });
  const unrelated = await prepareMaintenanceRun({
    repositoryRoot: poe2.koRoot,
    upstreamRef: poe2.secondCommit,
    workspaceRoot: poe2.workspace,
  });
  assert.equal(unrelated.report.classification, 'ready');
  assert.deepEqual(unrelated.report.deterministicFailures, []);
  assert.deepEqual(unrelated.report.officialDataChanges, []);

  const poe1 = await makeUpstreamFixture(t, { poe1OutputChanged: true });
  const intended = await prepareMaintenanceRun({
    repositoryRoot: poe1.koRoot,
    upstreamRef: poe1.secondCommit,
    workspaceRoot: poe1.workspace,
  });
  assert.equal(intended.report.classification, 'review-required');
  assert.deepEqual(intended.report.officialDataChanges.map((row) => row.path), [
    'pob-zh-engine/host/data/atlas_maps_poe1.json',
  ]);

  const newAtlas = await makeUpstreamFixture(t, { generatedAtlasVersion: '3.30.0' });
  const addition = await prepareMaintenanceRun({
    repositoryRoot: newAtlas.koRoot,
    upstreamRef: newAtlas.secondCommit,
    workspaceRoot: newAtlas.workspace,
  });
  assert.equal(addition.report.classification, 'review-required');
  assert.deepEqual(addition.report.officialDataChanges, [{
    path: 'pob-zh-engine/host/data/atlas_versions/3.30.0/atlas_tree_zh.json',
  }]);

  for (const [name, options, expectedPath] of [
    ['unknown root output', { unknownRootOutput: true }, 'pob-zh-engine/host/data/future_output.json'],
    ['unknown nested output', { nestedOutput: true }, 'pob-zh-engine/host/data/future/nested/output.json'],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await makeUpstreamFixture(t, options);
      const result = await prepareMaintenanceRun({ repositoryRoot: fixture.koRoot, upstreamRef: fixture.secondCommit, workspaceRoot: fixture.workspace });
      assert.equal(result.report.classification, 'review-required');
      assert.deepEqual(result.report.officialDataChanges, [{ path: expectedPath }]);
    });
  }

  const changedPoe2 = await makeUpstreamFixture(t, { changedPoe2Output: true });
  const blocked = await prepareMaintenanceRun({ repositoryRoot: changedPoe2.koRoot, upstreamRef: changedPoe2.secondCommit, workspaceRoot: changedPoe2.workspace });
  assert.equal(blocked.report.classification, 'blocked');
  assert.deepEqual(blocked.report.auditFailures.map((row) => row.path), ['pob-zh-engine/host/data/regex_poe2.json']);
});

test('an unregistered nondeterministic custom output blocks whole host/data determinism', async (t) => {
  const fixture = await makeUpstreamFixture(t, { nondeterministicCustomOutput: true });
  const result = await prepareMaintenanceRun({ repositoryRoot: fixture.koRoot, upstreamRef: fixture.secondCommit, workspaceRoot: fixture.workspace });
  assert.equal(result.report.classification, 'blocked');
  assert.deepEqual(result.report.deterministicFailures.map((row) => row.phase), ['custom-poe1-data-build']);
});

test('nested host/data reparse after custom build replaces stale ready report with blocked evidence', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  const target = join(fixture.koRoot, 'external-host-data');
  mkdirSync(target, { recursive: true });
  updateFixtureConfig(fixture.koRoot, {
    nestedHostDataReparse: true,
    nestedHostDataReparseTarget: target,
  });
  const reportPath = join(fixture.koRoot, 'reports', 'maintenance', 'host-data-failure.json');
  write(reportPath, '{"classification":"ready"}\n');
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
    reportPath,
  });
  assert.equal(result.report.classification, 'blocked');
  assert.deepEqual(result.report.phases.map((row) => row.name).filter((name) => name.startsWith('custom-poe1-data-host-data-')), [
    'custom-poe1-data-host-data-snapshot-after-build-1',
  ]);
  assert.deepEqual(result.report.auditFailures.map((row) => row.phase), ['custom-poe1-data-host-data-snapshot-after-build-1']);
  const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(persisted.classification, 'blocked');
  assert.deepEqual(persisted.auditFailures.map((row) => row.phase), ['custom-poe1-data-host-data-snapshot-after-build-1']);
});

test('exact PoE1 custom comparison canonicalizes only raw CRLF pairs', async (t) => {
  const relativeCustomPath = 'host/data/atlas_maps_poe1.json';
  const expectedReportPath = `pob-zh-engine/${relativeCustomPath}`;
  const crlf = await makeUpstreamFixture(t);
  updateFixtureConfig(crlf.koRoot, { poe1OutputContents: STABLE_CUSTOM_OUTPUT.replaceAll('\n', '\r\n') });
  const equivalent = await prepareMaintenanceRun({
    repositoryRoot: crlf.koRoot,
    upstreamRef: crlf.secondCommit,
    workspaceRoot: crlf.workspace,
  });
  assert.equal(equivalent.report.classification, 'ready');
  assert.deepEqual(equivalent.report.officialDataChanges, []);

  const meaningfulDifferences = {
    content: '{"locale":"ko-KR","value":"changed"}\n',
    whitespace: '{"locale": "ko-KR","value":"stable"}\n',
    escaped_crlf: '{"locale":"ko-KR","value":"stable\\r\\n"}\n',
    bare_cr: '{"locale":"ko-KR","value":"stable"}\r',
  };
  for (const [name, generatedContents] of Object.entries(meaningfulDifferences)) {
    await t.test(name, async (t) => {
      const fixture = await makeUpstreamFixture(t);
      updateFixtureConfig(fixture.koRoot, { poe1OutputContents: generatedContents });
      const result = await prepareMaintenanceRun({
        repositoryRoot: fixture.koRoot,
        upstreamRef: fixture.secondCommit,
        workspaceRoot: fixture.workspace,
      });
      assert.equal(result.report.classification, 'review-required');
      assert.deepEqual(result.report.officialDataChanges, [{ path: expectedReportPath }]);
    });
  }

  await t.test('missing', async (t) => {
    const fixture = await makeUpstreamFixture(t, { omitFixedOutput: relativeCustomPath });
    const result = await prepareMaintenanceRun({
      repositoryRoot: fixture.koRoot,
      upstreamRef: fixture.secondCommit,
      workspaceRoot: fixture.workspace,
    });
    assert.equal(result.report.classification, 'review-required');
    assert.deepEqual(result.report.officialDataChanges, [{ path: expectedReportPath }]);
  });

  const runtime = await makeUpstreamFixture(t);
  const runtimePath = join(runtime.koRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR', 'ui.json');
  write(runtimePath, readFileSync(runtimePath, 'utf8').replaceAll('\n', '\r\n'));
  const outsideExactCustomBoundary = await prepareMaintenanceRun({
    repositoryRoot: runtime.koRoot,
    upstreamRef: runtime.secondCommit,
    workspaceRoot: runtime.workspace,
  });
  assert.equal(outsideExactCustomBoundary.report.classification, 'review-required');
  assert.deepEqual(outsideExactCustomBoundary.report.officialDataChanges, [{
    path: 'pob-zh-engine/dist/Data/poe1/ko-KR/ui.json',
  }]);
});

test('custom PoE1 review uses manifest hashes and never repository host/data bytes', async (t) => {
  const ignoredTrustedBytes = await makeUpstreamFixture(t);
  for (const path of FIXED_CUSTOM_OUTPUT_PATHS) {
    write(join(ignoredTrustedBytes.koRoot, 'pob-zh-engine', path), `trusted bytes must be ignored: ${path}\n`);
  }
  const ignored = await prepareMaintenanceRun({
    repositoryRoot: ignoredTrustedBytes.koRoot,
    upstreamRef: ignoredTrustedBytes.secondCommit,
    workspaceRoot: ignoredTrustedBytes.workspace,
  });
  assert.equal(ignored.report.classification, 'ready');
  assert.deepEqual(ignored.report.officialDataChanges, []);

  const changedManifest = await makeUpstreamFixture(t);
  updateFixtureOutputManifest(changedManifest.koRoot, (manifest) => {
    manifest.outputs.find((row) => row.path === 'host/data/atlas_maps_poe1.json').sha256 = 'B'.repeat(64);
  });
  const changed = await prepareMaintenanceRun({
    repositoryRoot: changedManifest.koRoot,
    upstreamRef: changedManifest.secondCommit,
    workspaceRoot: changedManifest.workspace,
  });
  assert.equal(changed.report.classification, 'review-required');
  assert.deepEqual(changed.report.officialDataChanges, [{
    path: 'pob-zh-engine/host/data/atlas_maps_poe1.json',
  }]);
});

test('missing, malformed, and stale custom PoE1 manifests block in the trusted-manifest phase', async (t) => {
  const cases = {
    missing(root) {
      rmSync(join(root, 'localization', 'ko-KR', 'custom-poe1-output-manifest.json'));
    },
    malformed(root) {
      write(join(root, 'localization', 'ko-KR', 'custom-poe1-output-manifest.json'), '{not-json}\n');
    },
    stale_patch(root) {
      updateFixtureOutputManifest(root, (manifest) => { manifest.officialPoePatch = '3.29.3.1'; });
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const fixture = await makeUpstreamFixture(t);
      mutate(fixture.koRoot);
      const result = await prepareMaintenanceRun({
        repositoryRoot: fixture.koRoot,
        upstreamRef: fixture.secondCommit,
        workspaceRoot: fixture.workspace,
      });
      assert.equal(result.report.classification, 'blocked');
      assert.deepEqual(result.report.phases.map((row) => row.name), ['trusted-custom-poe1-output-manifest']);
      assert.deepEqual(result.report.auditFailures.map((row) => row.phase), ['trusted-custom-poe1-output-manifest']);
    });
  }
});

test('trusted-only removed atlas version is one normalized official-data review row', async (t) => {
  const fixture = await makeUpstreamFixture(t, { trustedOnlyAtlasVersion: true });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'review-required');
  assert.deepEqual(result.report.officialDataChanges, [{
    path: 'pob-zh-engine/host/data/atlas_versions/3.28.0/atlas_tree_zh.json',
  }]);
});

test('classification sorts review rows and applies blocked, processed, review, ready precedence', () => {
  const report = {
    commit: 'new',
    compatibilityFailures: [],
    deterministicFailures: [],
    commandFailures: [],
    auditFailures: [],
    newStrings: [
      { path: 'z.cpp', function: '', line: 2, source: '가' },
      { path: 'a.cpp', function: 'z', line: 5, source: '나' },
      { path: 'a.cpp', function: 'a', line: 9, source: '다' },
    ],
    suggestedStrings: [],
    ambiguousStrings: [],
    officialDataChanges: [],
  };
  assert.equal(classifyMaintenanceReport(report, { lastReviewedCommit: 'old' }), 'review-required');
  assert.deepEqual(report.newStrings.map((row) => `${row.path}:${row.function}:${row.line}:${row.source}`), [
    'a.cpp:a:9:다',
    'a.cpp:z:5:나',
    'z.cpp::2:가',
  ]);
  assert.equal(classifyMaintenanceReport({ ...report, compatibilityFailures: [{ path: 'x' }] }, { lastReviewedCommit: 'old' }), 'blocked');
  assert.equal(classifyMaintenanceReport({ ...report, newStrings: [], commit: 'same' }, { lastReviewedCommit: 'same' }), 'already-processed');
  assert.equal(classifyMaintenanceReport({ ...report, newStrings: [] }, { lastReviewedCommit: 'old' }), 'ready');
});

test('all programs resolve from the trusted checkout and builders receive explicit roots', async (t) => {
  const fixture = await makeUpstreamFixture(t);
  await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  const invocations = readFileSync(join(fixture.koRoot, 'localization', 'ko-KR', 'invocations.jsonl'), 'utf8')
    .trim().split(/\r?\n/u).map(JSON.parse);
  assert.ok(invocations.length >= 8);
  for (const invocation of invocations) {
    assert.equal(resolve(invocation.script).startsWith(`${resolve(fixture.koRoot)}${process.platform === 'win32' ? '\\' : '/'}`), true);
    assert.equal(resolve(invocation.script).startsWith(`${resolve(fixture.workspace)}${process.platform === 'win32' ? '\\' : '/'}`), false);
  }
  const builders = invocations.filter((row) => /build-(?:runtime-locale|custom-poe1-data)\.mjs$/u.test(row.script));
  for (const invocation of builders) {
    assert.equal(invocation.arguments[invocation.arguments.indexOf('--engine-root') + 1], join(fixture.workspace, 'pob-zh-engine'));
    assert.equal(invocation.arguments[invocation.arguments.indexOf('--report-root') + 1], join(fixture.koRoot, 'reports'));
  }
  const overlay = invocations.find((row) => /source_overlay\.py$/u.test(row.script));
  assert.equal(overlay.arguments[overlay.arguments.indexOf('--compatibility-patch') + 1], join(fixture.koRoot, 'localization', 'ko-KR', 'compat', 'pobtools-ko.patch'));
});

test('CLI returns 0 for ready, 2 for review-required, and 1 for blocked or malformed input', async (t) => {
  const ready = await makeUpstreamFixture(t);
  const review = await makeUpstreamFixture(t, { second: 'ImGui::Text(u8"新增");' });
  const blocked = await makeUpstreamFixture(t, { breakPatch: true });
  const invoke = (fixture) => spawnSync(process.execPath, [
    cliPath,
    '--repository-root', fixture.koRoot,
    '--upstream-ref', fixture.secondCommit,
    '--workspace', fixture.workspace,
    '--report', join(fixture.koRoot, 'reports', 'maintenance', 'cli.json'),
  ], { encoding: 'utf8' });
  assert.equal(invoke(ready).status, 0);
  assert.equal(invoke(review).status, 2);
  assert.equal(invoke(blocked).status, 1);
  assert.equal(spawnSync(process.execPath, [cliPath, '--unknown'], { encoding: 'utf8' }).status, 1);
});
