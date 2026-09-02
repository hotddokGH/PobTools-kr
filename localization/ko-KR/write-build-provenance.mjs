#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateCustomPoe1OutputManifest } from './lib/upstream-maintenance.mjs';

const RETAINED_ASSET_NAMES = new Map([
  ['dist/Data/launcher/ko-KR/launcher.json', 'retained-launcher-dictionary'],
  ['dist/Data/launcher/ko-KR/meta.json', 'retained-launcher-meta'],
  ['dist/Fonts/NotoSansKR-Variable.ttf', 'retained-font'],
  ['dist/Fonts/OFL-NotoSansKR.txt', 'retained-font-license'],
  ['dist/pob-zh.ini', 'retained-ini'],
]);

const REVIEWED_RETAINED_ASSETS = Object.freeze({
  'dist/Data/launcher/ko-KR/launcher.json': '83401B058CD4F93029C5C87EE633DCE21D8A006357A1E02C483DD3E67ECCBBB0',
  'dist/Data/launcher/ko-KR/meta.json': 'D7B59E5EB50FAA03877FC401393B18572AB89C7A296125D0D0D8B9751E3D790A',
  'dist/Fonts/NotoSansKR-Variable.ttf': '194018E6B2B293A7964F037B25C0249CE1418BC9AB3C971060A03AA57861E252',
  'dist/Fonts/OFL-NotoSansKR.txt': '1C05C68C34F9708415AADA51F17E1B0092D2CEA709BF4A94CD38114F9E73D7D9',
  'dist/pob-zh.ini': 'A75345BD3CC9AB480BD55C5B10B35364160EA426D21BFA65C2870E08982E7669',
});

const OPTION_KEYS = [
  'repositoryRoot', 'engineRoot', 'reviewedUpstreamCommit', 'koreanAutomationCommit',
  'runnerImageLabel', 'runnerImage', 'workflowRunId', 'workflowRunAttempt',
  'configuration', 'koreanReleaseCmake', 'expectedRetainedAssets',
];

function compare(left, right) {
  return left.localeCompare(right, 'en');
}

function normalized(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInside(path, root) {
  return normalized(path) === normalized(root) || normalized(path).startsWith(`${normalized(root)}${sep}`);
}

function metadata(path, label) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} does not exist`);
    throw error;
  }
}

function assertRegularDirectory(path, label) {
  const item = metadata(path, label);
  if (item.isSymbolicLink() || !item.isDirectory() || normalized(realpathSync(path)) !== normalized(path)) {
    throw new Error(`${label} must be a regular directory without a symbolic link, junction, or reparse point`);
  }
}

function assertSafePathChain(root, path, label) {
  if (!isInside(path, root)) throw new Error(`${label} escapes its root`);
  const segments = relative(root, path).split(sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const item = metadata(cursor, label);
    if (item.isSymbolicLink()) throw new Error(`${label} contains a symbolic link, junction, or reparse point`);
  }
}

function readRegularFile(root, relativePath, label) {
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} path is not normalized and relative`);
  }
  const path = join(root, ...relativePath.split('/'));
  assertSafePathChain(root, path, label);
  const item = metadata(path, label);
  if (!item.isFile()) throw new Error(`${label} must be a regular file`);
  return readFileSync(path);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function collectFiles(root, relativeRoot, label) {
  const start = join(root, ...relativeRoot.split('/'));
  assertSafePathChain(root, start, label);
  assertRegularDirectory(start, label);
  const files = [];
  function visit(absolute, relativePath) {
    for (const name of readdirSync(absolute).sort(compare)) {
      const child = join(absolute, name);
      const childRelative = `${relativePath}/${name}`;
      const item = metadata(child, label);
      if (item.isSymbolicLink()) throw new Error(`${label} contains a symbolic link, junction, or reparse point: ${childRelative}`);
      if (item.isDirectory()) visit(child, childRelative);
      else if (item.isFile()) {
        const bytes = readFileSync(child);
        files.push({ path: childRelative, sha256: sha256(bytes), bytes: bytes.length });
      } else throw new Error(`${label} contains a non-regular entry: ${childRelative}`);
    }
  }
  visit(start, relativeRoot);
  return files;
}

function treeSha256(files) {
  const index = files.map(({ path, sha256: hash, bytes }) => `${path}\0${hash}\0${bytes}\n`).join('');
  return sha256(Buffer.from(index, 'utf8'));
}

function assertNoKoreanDataOutsideScopes(engineRoot) {
  const dataRoot = join(engineRoot, 'dist', 'Data');
  assertSafePathChain(engineRoot, dataRoot, 'generated data root');
  assertRegularDirectory(dataRoot, 'generated data root');
  const allowed = new Set(['dist/Data/launcher/ko-KR', 'dist/Data/poe1/ko-KR']);
  function visit(absolute, relativePath) {
    for (const name of readdirSync(absolute).sort(compare)) {
      const child = join(absolute, name);
      const childRelative = `${relativePath}/${name}`;
      const item = metadata(child, 'generated Korean data');
      if (item.isSymbolicLink()) throw new Error(`generated Korean data contains a symbolic link, junction, or reparse point: ${childRelative}`);
      if (!item.isDirectory()) continue;
      if (name.toLocaleLowerCase('en-US') === 'ko-kr') {
        if (!allowed.has(childRelative)) throw new Error(`generated Korean data is outside the exact launcher and PoE1 scopes: ${childRelative}`);
      } else visit(child, childRelative);
    }
  }
  visit(dataRoot, 'dist/Data');
}

function validateHashMap(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected retained assets must be an object');
  const keys = Object.keys(value).sort(compare);
  const expected = [...RETAINED_ASSET_NAMES.keys()].sort(compare);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('expected retained assets must name the exact reviewed inventory');
  }
  for (const key of keys) if (!/^[0-9A-F]{64}$/u.test(value[key])) throw new Error(`retained asset SHA-256 is invalid: ${key}`);
  return value;
}

function assertScalar(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys must be exactly ${expected.join(', ')}`);
  }
}

export function buildPreviewProvenance(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object');
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unknown.length) throw new Error(`unknown option: ${unknown.sort(compare)[0]}`);
  for (const key of OPTION_KEYS.filter((key) => key !== 'expectedRetainedAssets')) {
    if (options[key] === undefined) throw new Error(`missing option: ${key}`);
  }
  const repositoryRoot = resolve(options.repositoryRoot);
  const engineRoot = resolve(options.engineRoot);
  assertRegularDirectory(repositoryRoot, 'repository root');
  assertRegularDirectory(engineRoot, 'engine root');
  if (normalized(repositoryRoot) === normalized(engineRoot)) throw new Error('repository root and engine root must differ');
  assertScalar(options.reviewedUpstreamCommit, /^[0-9a-f]{40}$/u, 'reviewed upstream commit');
  assertScalar(options.koreanAutomationCommit, /^[0-9a-f]{40}$/u, 'Korean automation commit');
  assertScalar(options.runnerImageLabel, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 'runner image label');
  assertScalar(options.runnerImage, /^[^\u0000-\u001f\u007f-\u009f]{1,256}$/u, 'runner image');
  assertScalar(options.workflowRunId, /^[1-9][0-9]*$/u, 'workflow run ID');
  assertScalar(options.workflowRunAttempt, /^[1-9][0-9]*$/u, 'workflow run attempt');
  if (options.configuration !== 'Release') throw new Error('configuration must be Release');
  if (options.koreanReleaseCmake !== 'ON') throw new Error('Korean release CMake flag must be ON');

  const expectedAssets = validateHashMap(options.expectedRetainedAssets ?? REVIEWED_RETAINED_ASSETS);
  const localeRoot = join(repositoryRoot, 'localization', 'ko-KR');
  const state = parseJson(readRegularFile(localeRoot, 'upstream-state.json', 'upstream state'), 'upstream state');
  assertExactKeys(state, ['schemaVersion', 'lastReviewedCommit', 'officialPoePatch'], 'upstream state');
  if (state?.schemaVersion !== 1 || state.lastReviewedCommit !== options.reviewedUpstreamCommit) {
    throw new Error('reviewed upstream commit does not match validated upstream state');
  }
  assertScalar(state.officialPoePatch, /^[0-9]+(?:\.[0-9]+){2,3}$/u, 'official PoE patch');

  const compatibilityManifest = parseJson(
    readRegularFile(localeRoot, 'compat/manifest.json', 'compatibility manifest'),
    'compatibility manifest',
  );
  const patchBytes = readRegularFile(localeRoot, 'compat/pobtools-ko.patch', 'compatibility patch');
  const patchHash = sha256(patchBytes);
  if (!/^[0-9A-F]{64}$/u.test(compatibilityManifest?.sha256) || compatibilityManifest.sha256 !== patchHash) {
    throw new Error('compatibility patch SHA-256 does not match its trusted manifest');
  }

  const customManifestBytes = readRegularFile(localeRoot, 'custom-poe1-output-manifest.json', 'custom PoE1 output manifest');
  const customManifest = parseJson(customManifestBytes, 'custom PoE1 output manifest');
  validateCustomPoe1OutputManifest(customManifest, state);
  const cleanManifestBytes = readRegularFile(localeRoot, 'clean-branch-manifest.json', 'clean branch manifest');
  const cleanManifest = parseJson(cleanManifestBytes, 'clean branch manifest');
  if (cleanManifest?.schemaVersion !== 1 || cleanManifest.targetBaseCommit !== options.reviewedUpstreamCommit || !Array.isArray(cleanManifest.entries)) {
    throw new Error('clean branch manifest does not match the reviewed upstream commit');
  }

  const inputs = [
    { name: 'canonical-source-translations', path: 'localization/ko-KR/source-translations.json', bytes: readRegularFile(repositoryRoot, 'localization/ko-KR/source-translations.json', 'canonical source translations') },
    { name: 'clean-branch-manifest', path: 'localization/ko-KR/clean-branch-manifest.json', bytes: cleanManifestBytes },
    { name: 'custom-poe1-output-manifest', path: 'localization/ko-KR/custom-poe1-output-manifest.json', bytes: customManifestBytes },
    { name: 'display-policy', path: 'localization/ko-KR/display-policy.json', bytes: readRegularFile(repositoryRoot, 'localization/ko-KR/display-policy.json', 'display policy') },
    { name: 'source-display-policy', path: 'localization/ko-KR/source-display-policy.json', bytes: readRegularFile(repositoryRoot, 'localization/ko-KR/source-display-policy.json', 'source display policy') },
  ];
  const officialFiles = collectFiles(localeRoot, 'official-terms', 'official terms inputs');
  if (!officialFiles.length) throw new Error('official terms inputs must contain regular files');
  inputs.push({
    name: 'official-terms-inputs',
    path: 'localization/ko-KR/official-terms',
    hash: treeSha256(officialFiles),
    files: officialFiles.length,
  });

  for (const [assetPath, name] of RETAINED_ASSET_NAMES) {
    const trustedBytes = readRegularFile(join(repositoryRoot, 'pob-zh-engine'), assetPath, `trusted retained asset ${assetPath}`);
    const generatedBytes = readRegularFile(engineRoot, assetPath, `generated retained asset ${assetPath}`);
    const hash = sha256(trustedBytes);
    if (hash !== expectedAssets[assetPath]) throw new Error(`trusted retained asset SHA-256 mismatch: ${assetPath}`);
    if (sha256(generatedBytes) !== hash) throw new Error(`generated retained asset SHA-256 mismatch: ${assetPath}`);
    const pinned = cleanManifest.entries.find((entry) => entry?.path === `pob-zh-engine/${assetPath}`)?.sha256;
    if (pinned !== undefined && pinned !== hash) throw new Error(`clean branch retained asset SHA-256 mismatch: ${assetPath}`);
    inputs.push({ name, path: `pob-zh-engine/${assetPath}`, hash });
  }

  const normalizedInputs = inputs.map((input) => ({
    name: input.name,
    path: input.path,
    sha256: input.hash ?? sha256(input.bytes),
    ...(input.files === undefined ? {} : { files: input.files }),
  })).sort((left, right) => compare(left.name, right.name));
  assertNoKoreanDataOutsideScopes(engineRoot);
  const launcherFiles = collectFiles(engineRoot, 'dist/Data/launcher/ko-KR', 'generated Korean data');
  const poe1Files = collectFiles(engineRoot, 'dist/Data/poe1/ko-KR', 'generated Korean data');
  if (!launcherFiles.length || !poe1Files.length) throw new Error('generated Korean data must include launcher and PoE1 files');
  const generatedFiles = [...launcherFiles, ...poe1Files].sort((left, right) => compare(left.path, right.path));

  return {
    schemaVersion: 1,
    reviewedUpstreamCommit: options.reviewedUpstreamCommit,
    koreanAutomationCommit: options.koreanAutomationCommit,
    officialPoePatch: state.officialPoePatch,
    compatibilityPatch: {
      path: 'localization/ko-KR/compat/pobtools-ko.patch',
      sha256: patchHash,
    },
    inputs: normalizedInputs,
    generatedKoreanData: {
      files: generatedFiles,
      treeSha256: treeSha256(generatedFiles),
    },
    build: {
      runnerImageLabel: options.runnerImageLabel,
      runnerImage: options.runnerImage,
      workflowRunId: options.workflowRunId,
      workflowRunAttempt: Number(options.workflowRunAttempt),
      configuration: options.configuration,
      koreanReleaseCmake: options.koreanReleaseCmake,
      unsigned: true,
    },
  };
}

export function serializePreviewProvenance(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArguments(arguments_) {
  const mapping = new Map([
    ['--repository-root', 'repositoryRoot'], ['--engine-root', 'engineRoot'],
    ['--reviewed-upstream-commit', 'reviewedUpstreamCommit'], ['--korean-automation-commit', 'koreanAutomationCommit'],
    ['--runner-image-label', 'runnerImageLabel'], ['--runner-image', 'runnerImage'],
    ['--workflow-run-id', 'workflowRunId'], ['--workflow-run-attempt', 'workflowRunAttempt'],
    ['--configuration', 'configuration'], ['--korean-release-cmake', 'koreanReleaseCmake'], ['--output', 'output'],
  ]);
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    if (!mapping.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const key = mapping.get(flag);
    if (values[key] !== undefined) throw new Error(`duplicate argument: ${flag}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    values[key] = value;
  }
  for (const key of [...OPTION_KEYS.filter((key) => key !== 'expectedRetainedAssets'), 'output']) {
    if (values[key] === undefined) throw new Error(`missing required argument: ${key}`);
  }
  return values;
}

function writeProvenance(arguments_) {
  const { output, ...options } = parseArguments(arguments_);
  const repositoryRoot = resolve(options.repositoryRoot);
  const outputPath = resolve(output);
  const buildReportRoot = join(repositoryRoot, 'reports', 'build');
  if (!isInside(outputPath, buildReportRoot) || normalized(outputPath) === normalized(buildReportRoot)) {
    throw new Error('output must be a file below reports/build');
  }
  const provenanceBytes = serializePreviewProvenance(buildPreviewProvenance(options));
  const parent = dirname(outputPath);
  const reportsRoot = join(repositoryRoot, 'reports');
  assertRegularDirectory(reportsRoot, 'reports root');
  if (relative(buildReportRoot, parent).split(sep).some((part) => part === '..')) throw new Error('output escapes reports/build');
  mkdirSync(parent, { recursive: true });
  assertSafePathChain(reportsRoot, parent, 'output');
  const existing = (() => { try { return lstatSync(outputPath); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; } })();
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('output must be a regular file');
  writeFileSync(outputPath, provenanceBytes, 'utf8');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    writeProvenance(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
