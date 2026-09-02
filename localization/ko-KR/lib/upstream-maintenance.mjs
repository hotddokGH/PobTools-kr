import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 64 * 1024;
const PROCESS_BUFFER = 1024 * 1024;
const APPROVED_COMPATIBILITY_PATCH_SHA256 = '2D3963E980C2E48604BA7FA91CDF784AB3E70485FBFEFB51DC5195E25B123959';
const APPROVED_KOREAN_DISTRIBUTION_INI_SHA256 = 'A75345BD3CC9AB480BD55C5B10B35364160EA426D21BFA65C2870E08982E7669';
const REVIEW_CODES = new Set([
  'MISSING_MAPPING',
  'MISSING_COMPONENT_MAPPING',
  'SUGGESTION_ONLY',
  'SUGGESTED',
  'AMBIGUOUS',
]);
const CUSTOM_POE1_OUTPUTS = [
  'host/data/atlas_maps_poe1.json',
  'host/data/astrolabes_poe1.json',
  'host/data/scarabs_poe1.json',
  'host/data/regex_poe1.json',
  'host/data/timeless_jewels.json',
];
const CUSTOM_POE1_MANIFEST_KEYS = ['hashPolicy', 'officialPoePatch', 'outputs', 'schemaVersion'];
const CUSTOM_POE1_OUTPUT_KEYS = ['path', 'sha256'];
const CUSTOM_POE1_HASH_POLICY = 'crlf-to-lf-sha256';
const CUSTOM_POE1_ATLAS_PATH = /^host\/data\/atlas_versions\/([A-Za-z0-9][A-Za-z0-9._-]*)\/atlas_tree_zh\.json$/u;

const normalized = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const sameExistingPath = (left, right) => (
  normalized(realpathSync.native(left)) === normalized(realpathSync.native(right))
);
const bounded = (value) => String(value ?? '').slice(0, MAX_OUTPUT);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();

function assertExactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys must be exactly: ${expected.join(', ')}`);
  }
}

export function validateCustomPoe1OutputManifest(manifest, state) {
  assertExactObjectKeys(manifest, CUSTOM_POE1_MANIFEST_KEYS, 'custom PoE1 output manifest');
  if (manifest.schemaVersion !== 1) throw new Error('custom PoE1 output manifest schemaVersion must be 1');
  if (typeof state?.officialPoePatch !== 'string' || manifest.officialPoePatch !== state.officialPoePatch) {
    throw new Error('custom PoE1 output manifest officialPoePatch must match upstream state');
  }
  if (manifest.hashPolicy !== CUSTOM_POE1_HASH_POLICY) {
    throw new Error(`custom PoE1 output manifest hashPolicy must be ${CUSTOM_POE1_HASH_POLICY}`);
  }
  if (!Array.isArray(manifest.outputs)) throw new Error('custom PoE1 output manifest outputs must be an array');

  const fixed = new Set(CUSTOM_POE1_OUTPUTS);
  const seen = new Set();
  let previous = '';
  for (const [index, row] of manifest.outputs.entries()) {
    assertExactObjectKeys(row, CUSTOM_POE1_OUTPUT_KEYS, `custom PoE1 output manifest outputs[${index}]`);
    if (typeof row.path !== 'string' || row.path.length === 0) throw new Error(`custom PoE1 output manifest outputs[${index}].path must be a non-empty string`);
    if (row.path.includes('\\') || row.path.startsWith('/') || /^[A-Za-z]:\//u.test(row.path)) {
      throw new Error(`custom PoE1 output manifest path must be normalized and relative: ${row.path}`);
    }
    const atlasMatch = CUSTOM_POE1_ATLAS_PATH.exec(row.path);
    if (!fixed.has(row.path) && (!atlasMatch || atlasMatch[1] === '.' || atlasMatch[1] === '..')) {
      throw new Error(`custom PoE1 output manifest path is not authorized: ${row.path}`);
    }
    if (!/^[0-9A-F]{64}$/u.test(row.sha256)) throw new Error(`custom PoE1 output manifest SHA-256 must be uppercase: ${row.path}`);
    if (seen.has(row.path)) throw new Error(`custom PoE1 output manifest path is duplicated: ${row.path}`);
    if (previous && previous.localeCompare(row.path, 'en') >= 0) throw new Error('custom PoE1 output manifest outputs must be sorted by path');
    seen.add(row.path);
    previous = row.path;
  }
  for (const path of CUSTOM_POE1_OUTPUTS) {
    if (!seen.has(path)) throw new Error(`custom PoE1 output manifest is missing fixed path: ${path}`);
  }
  return manifest.outputs.map((row) => ({ path: row.path, sha256: row.sha256 }));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function canonicalPathForms(path, token) {
  const native = String(path).replace(/[\\/]+$/u, '');
  const posix = native.replaceAll('\\', '/');
  const href = pathToFileURL(native).href.replace(/\/+$/u, '');
  return [...new Map([
    [native, token],
    [posix, token],
    [href, `file:///${token}`],
  ]).entries()].map(([value, replacement]) => ({ value, replacement }));
}

function canonicalizePathString(value, replacements) {
  let output = value;
  for (const { path, token, root } of replacements) {
    if (!path) continue;
    for (const form of canonicalPathForms(path, token)) {
      const before = '(^|[\\s"\'=(:,;\\[])';
      const suffix = root ? '((?:[\\\\/][^\\s"\'),;:\\]]*)?)' : '()';
      const after = '(?=$|[\\s"\'),;:\\]])';
      const expression = new RegExp(
        `${before}${escapedPattern(form.value)}${suffix}${after}`,
        process.platform === 'win32' ? 'giu' : 'gu',
      );
      output = output.replace(expression, (_match, prefix, matchedSuffix) => (
        `${prefix}${form.replacement}${matchedSuffix.replaceAll('\\', '/')}`
      ));
    }
  }
  return output;
}

export function canonicalizeMaintenanceReport(report, {
  repositoryRoot,
  workspaceRoot,
  nodePath = process.execPath,
}) {
  const replacements = [
    { path: workspaceRoot, token: '$WORKSPACE_ROOT', root: true },
    { path: repositoryRoot, token: '$REPOSITORY_ROOT', root: true },
    { path: nodePath, token: '$NODE', root: false },
  ];
  const visit = (value) => {
    if (typeof value === 'string') return canonicalizePathString(value, replacements);
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, visit(nested)]));
    }
    return value;
  };
  return visit(report);
}

async function run(command, arguments_, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: PROCESS_BUFFER,
      timeout: 120_000,
      windowsHide: true,
    });
    return { command: [command, ...arguments_], exitCode: 0, stdout: bounded(stdout), stderr: bounded(stderr) };
  } catch (error) {
    return {
      command: [command, ...arguments_],
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: bounded(error.stdout),
      stderr: bounded(error.stderr || error.message),
    };
  }
}

function phase(name, result) {
  return { name, command: result.command, exitCode: result.exitCode, stderr: result.stderr };
}

function compareRows(left, right) {
  for (const key of ['path', 'function']) {
    const compared = String(left[key] ?? '').localeCompare(String(right[key] ?? ''), 'en');
    if (compared !== 0) return compared;
  }
  const line = Number(left.line ?? 0) - Number(right.line ?? 0);
  if (line !== 0) return line;
  return String(left.source ?? '').localeCompare(String(right.source ?? ''), 'en');
}

function sortReportRows(report) {
  for (const key of [
    'newStrings',
    'suggestedStrings',
    'ambiguousStrings',
    'officialDataChanges',
    'compatibilityFailures',
    'deterministicFailures',
    'commandFailures',
    'auditFailures',
  ]) {
    if (Array.isArray(report[key])) report[key].sort(compareRows);
  }
}

export function classifyMaintenanceReport(report, state = {}) {
  sortReportRows(report);
  const blocked = ['compatibilityFailures', 'deterministicFailures', 'commandFailures', 'auditFailures']
    .some((key) => (report[key]?.length ?? 0) > 0);
  if (blocked) return 'blocked';
  if (report.commit === state.lastReviewedCommit) return 'already-processed';
  const review = ['newStrings', 'suggestedStrings', 'ambiguousStrings', 'officialDataChanges']
    .some((key) => (report[key]?.length ?? 0) > 0);
  return review ? 'review-required' : 'ready';
}

function newReport(commit, upstreamRef) {
  return {
    schemaVersion: 1,
    commit,
    upstreamRef,
    classification: 'blocked',
    sourceSummary: {
      filesScanned: 0,
      displayLiterals: 0,
      reused: 0,
      official: 0,
      reviewed: 0,
      intentional: 0,
    },
    newStrings: [],
    suggestedStrings: [],
    ambiguousStrings: [],
    officialDataChanges: [],
    compatibilityFailures: [],
    deterministicFailures: [],
    commandFailures: [],
    auditFailures: [],
    phases: [],
  };
}

function assertNotReparse(path, label) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link, junction, or reparse point`);
  }
}

function isPathInside(path, root) {
  return normalized(path) === normalized(root) || normalized(path).startsWith(`${normalized(root)}${sep}`);
}

function preflightExistingScope(scope, allowedRoot) {
  const resolvedScope = resolve(scope);
  const resolvedAllowedRoot = resolve(allowedRoot);
  if (!isPathInside(resolvedScope, resolvedAllowedRoot)) throw new Error(`writable scope escapes its allowed root: ${resolvedScope}`);
  assertNotReparse(resolvedAllowedRoot, 'writable root');
  const realAllowedRoot = realpathSync(resolvedAllowedRoot);
  const components = relative(resolvedAllowedRoot, resolvedScope).split(sep).filter(Boolean);
  let cursor = resolvedAllowedRoot;
  for (const component of components) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    assertNotReparse(cursor, 'writable path component');
    if (!isPathInside(realpathSync(cursor), realAllowedRoot)) throw new Error(`writable path resolves outside its allowed root: ${cursor}`);
  }
  if (!existsSync(resolvedScope)) return;
  const visit = (path) => {
    assertNotReparse(path, 'writable scope entry');
    if (!isPathInside(realpathSync(path), realAllowedRoot)) throw new Error(`writable entry resolves outside its allowed root: ${path}`);
    if (!lstatSync(path).isDirectory()) return;
    for (const name of readdirSync(path).sort((left, right) => left.localeCompare(right, 'en'))) visit(join(path, name));
  };
  visit(resolvedScope);
}

function customPoe1OutputPaths(engineRoot) {
  const paths = CUSTOM_POE1_OUTPUTS.map((path) => join(engineRoot, path));
  const versionsRoot = join(engineRoot, 'host', 'data', 'atlas_versions');
  if (!existsSync(versionsRoot)) return paths;
  for (const name of readdirSync(versionsRoot).sort((left, right) => left.localeCompare(right, 'en'))) {
    const versionRoot = join(versionsRoot, name);
    if (statSync(versionRoot).isDirectory()) paths.push(join(versionRoot, 'atlas_tree_zh.json'));
  }
  return paths;
}

function preflightWritableScopes({ engineRoot, reportsRoot }) {
  preflightExistingScope(join(engineRoot, 'dist', 'Data', 'poe1', 'ko-KR'), engineRoot);
  for (const path of CUSTOM_POE1_OUTPUTS) preflightExistingScope(join(engineRoot, path), engineRoot);
  preflightExistingScope(join(engineRoot, 'host', 'data', 'atlas_versions'), engineRoot);
  for (const scope of [
    join(reportsRoot, 'display-closure'),
    join(reportsRoot, 'maintenance'),
    join(reportsRoot, 'official-terms'),
  ]) preflightExistingScope(scope, reportsRoot);
  return [
    join(engineRoot, 'host', 'data'),
  ];
}

async function stageTrustedDistributionInput({ repositoryRoot, engineRoot }) {
  const trustedRelativePath = 'pob-zh-engine/dist/pob-zh.ini';
  const source = join(repositoryRoot, ...trustedRelativePath.split('/'));
  const destination = join(engineRoot, 'dist', 'pob-zh.ini');
  if (!existsSync(source)) throw new Error('trusted Korean distribution input is missing');
  const tracked = await run('git', ['ls-files', '--error-unmatch', '--', trustedRelativePath], { cwd: repositoryRoot });
  if (tracked.exitCode !== 0 || tracked.stdout.trim() !== trustedRelativePath) {
    throw new Error('trusted Korean distribution input must be tracked at its reviewed path');
  }
  preflightExistingScope(source, repositoryRoot);
  const sourceMetadata = lstatSync(source);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
    throw new Error('trusted Korean distribution input must be a regular file');
  }
  if (sha256(readFileSync(source)) !== APPROVED_KOREAN_DISTRIBUTION_INI_SHA256) {
    throw new Error('trusted Korean distribution input hash does not match the reviewed identity');
  }
  preflightExistingScope(destination, engineRoot);
  try {
    mkdirSync(dirname(destination), { recursive: true });
    preflightExistingScope(destination, engineRoot);
    copyFileSync(source, destination);
  } catch {
    throw new Error('trusted Korean distribution input copy failed');
  }
  const destinationMetadata = lstatSync(destination);
  if (destinationMetadata.isSymbolicLink() || !destinationMetadata.isFile()) {
    throw new Error('staged Korean distribution input must be a regular file');
  }
  if (sha256(readFileSync(destination)) !== APPROVED_KOREAN_DISTRIBUTION_INI_SHA256) {
    throw new Error('staged Korean distribution input hash does not match the reviewed identity');
  }
}

async function resolveCommit(repositoryRoot, upstreamRef) {
  if (typeof upstreamRef !== 'string' || upstreamRef.length === 0 || /[\r\n\0]/u.test(upstreamRef)) {
    throw new Error('upstreamRef must be a non-empty Git revision');
  }
  const result = await run('git', ['rev-parse', '--verify', `${upstreamRef}^{commit}`], { cwd: repositoryRoot });
  if (result.exitCode !== 0) throw new Error(`cannot resolve upstream commit: ${result.stderr}`);
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('git returned an invalid commit identity');
  return commit;
}

async function prepareWorktree(repositoryRoot, workspaceRoot, commit) {
  const allowedRoot = resolve(repositoryRoot, '.ko-worktrees');
  const workspace = resolve(workspaceRoot);
  if (normalized(workspace) === normalized(allowedRoot)
      || !normalized(workspace).startsWith(`${normalized(allowedRoot)}${sep}`)
      || normalized(dirname(workspace)) !== normalized(allowedRoot)) {
    throw new Error('workspace must be a direct child of the repository .ko-worktrees directory');
  }
  assertNotReparse(allowedRoot, 'allowed workspace root');
  mkdirSync(allowedRoot, { recursive: true });
  assertNotReparse(allowedRoot, 'allowed workspace root');
  assertNotReparse(workspace, 'workspace');
  if (normalized(realpathSync(dirname(workspace))) !== normalized(realpathSync(allowedRoot))) {
    throw new Error('workspace parent must resolve to the allowed workspace root');
  }

  const listed = await run('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: repositoryRoot });
  if (listed.exitCode !== 0) return { workspace, failure: { name: 'worktree-list', result: listed } };
  const registered = listed.stdout.split('\0')
    .filter((row) => row.startsWith('worktree '))
    .map((row) => row.slice('worktree '.length));
  const isRegistered = existsSync(workspace) && registered.some((path) => (
    existsSync(path) && sameExistingPath(path, workspace)
  ));
  if (existsSync(workspace) && !isRegistered) throw new Error('existing workspace is not a registered Git worktree');
  if (isRegistered) {
    const removed = await run('git', ['worktree', 'remove', '--force', workspace], { cwd: repositoryRoot });
    if (removed.exitCode !== 0) return { workspace, failure: { name: 'worktree-remove', result: removed } };
  }
  const added = await run('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    'worktree', 'add', '--detach', workspace, commit,
  ], { cwd: repositoryRoot });
  if (added.exitCode !== 0) return { workspace, failure: { name: 'worktree-add', result: added } };
  assertNotReparse(workspace, 'prepared workspace');
  return { workspace };
}

function patchPaths(patch) {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]);
}

export async function applyCompatibilityPatch({ repositoryRoot, workspace, report }) {
  const localeRoot = join(repositoryRoot, 'localization', 'ko-KR');
  const patchPath = join(localeRoot, 'compat', 'pobtools-ko.patch');
  const manifest = readJson(join(localeRoot, 'compat', 'manifest.json'));
  const patchBytes = readFileSync(patchPath);
  const actualSha = sha256(patchBytes);
  const actualPaths = [...new Set(patchPaths(patchBytes.toString('utf8')))].sort();
  const allowedPaths = [...manifest.allowedPaths].sort();
  if (actualSha !== APPROVED_COMPATIBILITY_PATCH_SHA256
      || manifest.sha256 !== APPROVED_COMPATIBILITY_PATCH_SHA256
      || JSON.stringify(actualPaths) !== JSON.stringify(allowedPaths)) {
    report.compatibilityFailures.push({ path: 'localization/ko-KR/compat/pobtools-ko.patch', detail: 'patch hash or allowed paths do not match its reviewed manifest' });
    return false;
  }
  const checked = await run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--check', '--whitespace=nowarn', patchPath], { cwd: workspace });
  report.phases.push(phase('compatibility-patch-check', checked));
  if (checked.exitCode !== 0) {
    report.compatibilityFailures.push({ path: 'localization/ko-KR/compat/pobtools-ko.patch', detail: checked.stderr });
    return false;
  }
  const applied = await run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', patchPath], { cwd: workspace });
  report.phases.push(phase('compatibility-patch-apply', applied));
  if (applied.exitCode !== 0) {
    report.compatibilityFailures.push({ path: 'localization/ko-KR/compat/pobtools-ko.patch', detail: applied.stderr });
    return false;
  }
  return true;
}

function hashPath(path, root = path, hash = createHash('sha256')) {
  const identity = relative(root, path).split(sep).join('/');
  if (!existsSync(path)) return hash.update(`missing:${identity}\0`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error(`generated path is a symbolic link or reparse point: ${path}`);
  if (metadata.isDirectory()) {
    for (const name of readdirSync(path).sort((left, right) => left.localeCompare(right, 'en'))) {
      hash.update(`directory:${relative(root, join(path, name)).split(sep).join('/')}\0`);
      hashPath(join(path, name), root, hash);
    }
  } else if (metadata.isFile()) {
    hash.update(`file:${identity}\0`);
    hash.update(readFileSync(path));
  }
  return hash;
}

function digestScopes(scopes) {
  const hash = createHash('sha256');
  for (const [index, scope] of scopes.entries()) {
    hash.update(`scope:${index}\0`);
    hashPath(scope, scope, hash);
  }
  return hash.digest('hex').toUpperCase();
}

function directoryFiles(root) {
  if (!existsSync(root)) return [];
  assertNotReparse(root, 'comparison root');
  const output = [];
  for (const name of readdirSync(root).sort((left, right) => left.localeCompare(right, 'en'))) {
    const path = join(root, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`comparison path is a symbolic link or reparse point: ${path}`);
    if (metadata.isDirectory()) output.push(...directoryFiles(path));
    else if (metadata.isFile()) output.push(path);
  }
  return output;
}

function changedFiles(trustedRoot, generatedRoot, label) {
  const trusted = new Map(directoryFiles(trustedRoot).map((path) => [relative(trustedRoot, path), sha256(readFileSync(path))]));
  const generated = new Map(directoryFiles(generatedRoot).map((path) => [relative(generatedRoot, path), sha256(readFileSync(path))]));
  const paths = [...new Set([...trusted.keys(), ...generated.keys()])].sort((left, right) => left.localeCompare(right, 'en'));
  return paths.filter((path) => trusted.get(path) !== generated.get(path)).map((path) => ({ path: `${label}/${path}` }));
}

function comparableCustomOutputSha(path) {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  const comparable = Buffer.allocUnsafe(bytes.length);
  let outputIndex = 0;
  for (let inputIndex = 0; inputIndex < bytes.length; inputIndex += 1) {
    if (bytes[inputIndex] === 0x0D && bytes[inputIndex + 1] === 0x0A) inputIndex += 1;
    comparable[outputIndex] = bytes[inputIndex];
    outputIndex += 1;
  }
  return sha256(comparable.subarray(0, outputIndex));
}

function snapshotFiles(root) {
  return new Map(directoryFiles(root).map((path) => [
    relative(root, path).replaceAll('\\', '/'),
    sha256(readFileSync(path)),
  ]));
}

function captureHostDataBoundary(report, phaseName, operation) {
  try {
    return { value: operation() };
  } catch (error) {
    const detail = bounded(error?.message ?? error);
    report.phases.push({ name: phaseName, command: [], exitCode: 1, stderr: detail });
    report.auditFailures.push({
      path: 'pob-zh-engine/host/data',
      phase: phaseName,
      detail,
    });
    return { failed: true };
  }
}

function changedSnapshotPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function changedCustomPoe1Outputs(manifestOutputs, generatedEngineRoot, generatedChanges) {
  const expected = new Map(manifestOutputs.map((row) => [row.path, row.sha256]));
  const relativePaths = [...new Set([...expected.keys(), ...generatedChanges])]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const output = [];
  for (const path of relativePaths) {
    const generatedPath = join(generatedEngineRoot, path);
    if (!expected.has(path) || expected.get(path) !== comparableCustomOutputSha(generatedPath)) {
      output.push({ path: `pob-zh-engine/${path}` });
    }
  }
  return output;
}

function collectOverlayRows(report, overlayReport) {
  const summaryKeys = ['filesScanned', 'displayLiterals', 'reused', 'official', 'reviewed', 'intentional'];
  const summary = {};
  for (const key of summaryKeys) {
    const value = overlayReport[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      report.auditFailures.push({
        path: 'reports/maintenance/source-overlay.json',
        phase: 'source-overlay-audit',
        detail: `source overlay report ${key} must be a non-negative safe integer`,
      });
      return false;
    }
    summary[key] = value;
  }
  report.sourceSummary = summary;
  if (!Array.isArray(overlayReport.issues)) {
    report.auditFailures.push({
      path: 'reports/maintenance/source-overlay.json',
      phase: 'source-overlay-audit',
      detail: 'source overlay report issues must be an array',
    });
    return false;
  }
  for (const row of overlayReport.issues) {
    if (row.code === 'SUGGESTION_ONLY' || row.code === 'SUGGESTED') report.suggestedStrings.push(row);
    else if (row.code === 'AMBIGUOUS') report.ambiguousStrings.push(row);
    else if (row.code === 'MISSING_MAPPING' || row.code === 'MISSING_COMPONENT_MAPPING') report.newStrings.push(row);
    else report.auditFailures.push(row);
  }
  return true;
}

function recordOverlayEvidenceFailure(report, phaseName, detail) {
  const safeDetail = bounded(detail);
  report.phases.push({ name: phaseName, command: [], exitCode: 1, stderr: safeDetail });
  report.auditFailures.push({
    path: 'reports/maintenance/source-overlay.json',
    phase: phaseName,
    detail: safeDetail,
  });
}

function removeStaleOverlayEvidence(report, overlayReportPath, reportsRoot) {
  try {
    preflightExistingScope(overlayReportPath, reportsRoot);
    if (!existsSync(overlayReportPath)) return true;
    const metadata = lstatSync(overlayReportPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('pre-existing source overlay report must be a regular file');
    }
    unlinkSync(overlayReportPath);
    preflightExistingScope(overlayReportPath, reportsRoot);
    if (existsSync(overlayReportPath)) throw new Error('pre-existing source overlay report could not be removed');
    return true;
  } catch (error) {
    recordOverlayEvidenceFailure(report, 'source-overlay-report-preflight', error.message);
    return false;
  }
}

function readFreshOverlayEvidence(report, overlayReportPath, reportsRoot) {
  try {
    preflightExistingScope(overlayReportPath, reportsRoot);
    if (!existsSync(overlayReportPath)) throw new Error('fresh source overlay report is missing');
    const metadata = lstatSync(overlayReportPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('fresh source overlay report must be a regular file');
    let overlayReport;
    try {
      overlayReport = readJson(overlayReportPath);
    } catch {
      throw new Error('fresh source overlay report is not valid JSON');
    }
    if (overlayReport === null || typeof overlayReport !== 'object' || Array.isArray(overlayReport)) {
      throw new Error('fresh source overlay report must be an object');
    }
    return { valid: collectOverlayRows(report, overlayReport) };
  } catch (error) {
    recordOverlayEvidenceFailure(report, 'source-overlay-report-read', error.message);
    return { valid: false };
  }
}

async function runTrusted(report, name, command, arguments_, options = {}) {
  const result = await run(command, arguments_, options);
  report.phases.push(phase(name, result));
  return result;
}

function finish(report, state, reportPath, roots) {
  report.classification = classifyMaintenanceReport(report, state);
  const canonical = canonicalizeMaintenanceReport(report, roots);
  writeJson(reportPath, canonical);
  return canonical;
}

export async function prepareMaintenanceRun({
  repositoryRoot,
  upstreamRef,
  workspaceRoot,
  forcePrepare = false,
  reportPath,
}) {
  const trustedRoot = resolve(repositoryRoot);
  if (!statSync(trustedRoot).isDirectory()) throw new Error('repositoryRoot must be a directory');
  const commit = await resolveCommit(trustedRoot, upstreamRef);
  const localeRoot = join(trustedRoot, 'localization', 'ko-KR');
  const state = readJson(join(localeRoot, 'upstream-state.json'));
  const outputPath = resolve(reportPath ?? join(trustedRoot, 'reports', 'maintenance', 'upstream-update.json'));
  const report = newReport(commit, upstreamRef);
  const finishReport = () => finish(report, state, outputPath, {
    repositoryRoot: trustedRoot,
    workspaceRoot: resolve(workspaceRoot),
  });
  if (commit === state.lastReviewedCommit && !forcePrepare) {
    return { commit, workspace: resolve(workspaceRoot), report: finishReport() };
  }

  const trustedManifestPhase = 'trusted-custom-poe1-output-manifest';
  const customManifestPath = join(localeRoot, 'custom-poe1-output-manifest.json');
  let customOutputManifest;
  try {
    if (!existsSync(customManifestPath)) throw new Error('custom PoE1 output manifest is missing');
    let manifest;
    try {
      manifest = readJson(customManifestPath);
    } catch {
      throw new Error('custom PoE1 output manifest is not valid JSON');
    }
    customOutputManifest = validateCustomPoe1OutputManifest(manifest, state);
  } catch (error) {
    const detail = bounded(error.message);
    report.phases.push({ name: trustedManifestPhase, command: [], exitCode: 1, stderr: detail });
    report.auditFailures.push({
      path: 'localization/ko-KR/custom-poe1-output-manifest.json',
      phase: trustedManifestPhase,
      detail,
    });
    return { commit, workspace: resolve(workspaceRoot), report: finishReport() };
  }

  const preparedWorktree = await prepareWorktree(trustedRoot, workspaceRoot, commit);
  const workspace = preparedWorktree.workspace;
  if (preparedWorktree.failure) {
    const { name, result } = preparedWorktree.failure;
    report.phases.push(phase(name, result));
    report.commandFailures.push({
      path: relative(trustedRoot, workspace).replaceAll('\\', '/'),
      phase: name,
      detail: result.stderr,
    });
    return { commit, workspace, report: finishReport() };
  }
  const engineRoot = join(workspace, 'pob-zh-engine');
  const reportsRoot = join(trustedRoot, 'reports');
  assertNotReparse(engineRoot, 'engine root');
  if (!existsSync(reportsRoot)) mkdirSync(reportsRoot);
  assertNotReparse(reportsRoot, 'report root');

  if (!await applyCompatibilityPatch({ repositoryRoot: trustedRoot, workspace, report })) {
    return { commit, workspace, report: finishReport() };
  }

  const overlayReportPath = join(reportsRoot, 'maintenance', 'source-overlay.json');
  if (!removeStaleOverlayEvidence(report, overlayReportPath, reportsRoot)) {
    return { commit, workspace, report: finishReport() };
  }
  const overlayBase = [
    '--source-root', engineRoot,
    '--mapping', join(localeRoot, 'source-translations.json'),
    '--policy', join(localeRoot, 'source-display-policy.json'),
    '--report', overlayReportPath,
    '--compatibility-patch', join(localeRoot, 'compat', 'pobtools-ko.patch'),
  ];
  const overlayScript = join(localeRoot, 'lib', 'source_overlay.py');
  const audit = await runTrusted(report, 'source-overlay-audit', 'python', [overlayScript, 'audit', ...overlayBase], { cwd: trustedRoot });
  const overlayEvidence = readFreshOverlayEvidence(report, overlayReportPath, reportsRoot);
  if (!overlayEvidence.valid) return { commit, workspace, report: finishReport() };
  if (audit.exitCode !== 0) {
    if (report.newStrings.length + report.suggestedStrings.length + report.ambiguousStrings.length === 0) {
      report.commandFailures.push({ path: 'localization/ko-KR/lib/source_overlay.py', phase: 'source-overlay-audit', detail: audit.stderr });
    }
    return { commit, workspace, report: finishReport() };
  }
  const apply = await runTrusted(report, 'source-overlay-apply', 'python', [overlayScript, 'apply', ...overlayBase], { cwd: trustedRoot });
  if (apply.exitCode !== 0) {
    report.commandFailures.push({ path: 'localization/ko-KR/lib/source_overlay.py', phase: 'source-overlay-apply', detail: apply.stderr });
    return { commit, workspace, report: finishReport() };
  }

  let customOutputScopes;
  try {
    customOutputScopes = preflightWritableScopes({ engineRoot, reportsRoot });
  } catch (error) {
    report.phases.push({ name: 'writable-scope-preflight', command: [], exitCode: 1, stderr: bounded(error.message) });
    report.auditFailures.push({ path: 'pob-zh-engine', phase: 'writable-scope-preflight', detail: bounded(error.message) });
    return { commit, workspace, report: finishReport() };
  }

  const runtimeScript = join(localeRoot, 'build-runtime-locale.mjs');
  const runtimeArguments = [runtimeScript, '--engine-root', engineRoot, '--report-root', reportsRoot];
  const runtimeScopes = [join(engineRoot, 'dist', 'Data', 'poe1', 'ko-KR')];
  const runtime1 = await runTrusted(report, 'runtime-locale-build-1', process.execPath, runtimeArguments, { cwd: trustedRoot });
  if (runtime1.exitCode !== 0) {
    report.commandFailures.push({ path: 'localization/ko-KR/build-runtime-locale.mjs', phase: 'runtime-locale-build', detail: runtime1.stderr });
    return { commit, workspace, report: finishReport() };
  }
  const runtimeHash1 = digestScopes(runtimeScopes);
  const runtime2 = await runTrusted(report, 'runtime-locale-build-2', process.execPath, runtimeArguments, { cwd: trustedRoot });
  const runtimeHash2 = runtime2.exitCode === 0 ? digestScopes(runtimeScopes) : '';
  if (runtime2.exitCode !== 0 || runtimeHash1 !== runtimeHash2) {
    report.deterministicFailures.push({ path: 'pob-zh-engine/dist/Data/poe1/ko-KR', phase: 'runtime-locale-build', firstSha256: runtimeHash1, secondSha256: runtimeHash2, detail: runtime2.stderr });
    return { commit, workspace, report: finishReport() };
  }

  const customScript = join(localeRoot, 'build-custom-poe1-data.mjs');
  const customArguments = [customScript, '--engine-root', engineRoot, '--report-root', reportsRoot];
  const customScopes = customOutputScopes;
  const customDataRoot = join(engineRoot, 'host', 'data');
  const customBeforeBoundary = captureHostDataBoundary(
    report,
    'custom-poe1-data-host-data-snapshot-before-build-1',
    () => snapshotFiles(customDataRoot),
  );
  if (customBeforeBoundary.failed) return { commit, workspace, report: finishReport() };
  const customBefore = customBeforeBoundary.value;
  const custom1 = await runTrusted(report, 'custom-poe1-data-build-1', process.execPath, customArguments, { cwd: trustedRoot });
  if (custom1.exitCode !== 0) {
    report.commandFailures.push({ path: 'localization/ko-KR/build-custom-poe1-data.mjs', phase: 'custom-poe1-data-build', detail: custom1.stderr });
    return { commit, workspace, report: finishReport() };
  }
  const customAfter1Boundary = captureHostDataBoundary(
    report,
    'custom-poe1-data-host-data-snapshot-after-build-1',
    () => snapshotFiles(customDataRoot),
  );
  if (customAfter1Boundary.failed) return { commit, workspace, report: finishReport() };
  const customAfter1 = customAfter1Boundary.value;
  const customChangedPaths = changedSnapshotPaths(customBefore, customAfter1);
  const customHash1Boundary = captureHostDataBoundary(
    report,
    'custom-poe1-data-host-data-digest-after-build-1',
    () => digestScopes(customScopes),
  );
  if (customHash1Boundary.failed) return { commit, workspace, report: finishReport() };
  const customHash1 = customHash1Boundary.value;
  const custom2 = await runTrusted(report, 'custom-poe1-data-build-2', process.execPath, customArguments, { cwd: trustedRoot });
  const customHash2Boundary = custom2.exitCode === 0
    ? captureHostDataBoundary(
      report,
      'custom-poe1-data-host-data-digest-after-build-2',
      () => digestScopes(customScopes),
    )
    : { value: '' };
  if (customHash2Boundary.failed) return { commit, workspace, report: finishReport() };
  const customHash2 = customHash2Boundary.value;
  if (custom2.exitCode !== 0 || customHash1 !== customHash2) {
    report.deterministicFailures.push({ path: 'pob-zh-engine/host/data/*_poe1.json', phase: 'custom-poe1-data-build', firstSha256: customHash1, secondSha256: customHash2, detail: custom2.stderr });
    return { commit, workspace, report: finishReport() };
  }
  const changedPoe2Paths = customChangedPaths.filter((path) => /(?:^|[/_-])poe2(?:[/_.-]|$)/iu.test(path));
  if (changedPoe2Paths.length) {
    for (const path of changedPoe2Paths) report.auditFailures.push({
      path: `pob-zh-engine/host/data/${path}`,
      phase: 'custom-poe1-data-output-boundary',
      detail: 'custom PoE1 builder changed a PoE2-labelled output',
    });
    return { commit, workspace, report: finishReport() };
  }

  const displayScript = join(localeRoot, 'audit-display-closure.mjs');
  const display = await runTrusted(report, 'runtime-display-audit', process.execPath, [displayScript, '--engine-root', engineRoot, '--report-root', reportsRoot], { cwd: trustedRoot });
  if (display.exitCode !== 0) {
    report.auditFailures.push({ path: 'pob-zh-engine/dist/Data/poe1/ko-KR', phase: 'runtime-display-audit', detail: display.stderr });
    return { commit, workspace, report: finishReport() };
  }

  const sourceScript = join(localeRoot, 'audit-source-display.mjs');
  const sourceReportPath = join(reportsRoot, 'maintenance', 'source-display.json');
  const source = await runTrusted(report, 'generated-source-display-audit', process.execPath, [sourceScript, '--engine-root', engineRoot, '--overlay-report', overlayReportPath, '--report', sourceReportPath], { cwd: trustedRoot });
  if (source.exitCode !== 0) {
    report.auditFailures.push({ path: 'pob-zh-engine', phase: 'generated-source-display-audit', detail: source.stderr });
    return { commit, workspace, report: finishReport() };
  }

  const trustedInputPhase = 'trusted-distribution-input-stage';
  try {
    await stageTrustedDistributionInput({ repositoryRoot: trustedRoot, engineRoot });
    report.phases.push({ name: trustedInputPhase, command: [], exitCode: 0, stderr: '' });
  } catch (error) {
    const detail = bounded(error.message);
    report.phases.push({ name: trustedInputPhase, command: [], exitCode: 1, stderr: detail });
    report.commandFailures.push({ path: 'pob-zh-engine/dist/pob-zh.ini', phase: trustedInputPhase, detail });
    return { commit, workspace, report: finishReport() };
  }

  const contractPaths = [
    join(localeRoot, 'tests', 'korean-update-contract.test.mjs'),
    join(localeRoot, 'tests', 'filter-i18n-contract.test.mjs'),
  ];
  const contractEnvironment = { ...process.env, POBTOOLS_ENGINE_ROOT: engineRoot };
  delete contractEnvironment.NODE_TEST_CONTEXT;
  const contracts = await runTrusted(report, 'static-korean-behavior-contracts', process.execPath, ['--test', ...contractPaths], {
    cwd: trustedRoot,
    env: contractEnvironment,
  });
  if (contracts.exitCode !== 0) {
    report.commandFailures.push({ path: 'localization/ko-KR/tests', phase: 'static-korean-behavior-contracts', detail: contracts.stderr });
    return { commit, workspace, report: finishReport() };
  }

  report.officialDataChanges.push(
    ...changedFiles(join(trustedRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR'), runtimeScopes[0], 'pob-zh-engine/dist/Data/poe1/ko-KR'),
    ...changedCustomPoe1Outputs(customOutputManifest, engineRoot, customChangedPaths.map((path) => `host/data/${path}`)),
  );
  return { commit, workspace, report: finishReport() };
}
