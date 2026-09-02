import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const manifestPath = 'localization/ko-KR/clean-branch-manifest.json';
const regularModes = new Set(['100644', '100755']);
const approvedBinaryPaths = new Set([
  'pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf',
]);
const pinnedAssetHashes = new Map([
  ['pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf', '194018E6B2B293A7964F037B25C0249CE1418BC9AB3C971060A03AA57861E252'],
  ['pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt', '1C05C68C34F9708415AADA51F17E1B0092D2CEA709BF4A94CD38114F9E73D7D9'],
  ['pob-zh-engine/dist/Data/launcher/ko-KR/launcher.json', '83401B058CD4F93029C5C87EE633DCE21D8A006357A1E02C483DD3E67ECCBBB0'],
  ['pob-zh-engine/dist/Data/launcher/ko-KR/meta.json', 'D7B59E5EB50FAA03877FC401393B18572AB89C7A296125D0D0D8B9751E3D790A'],
]);
const approvedTextExtensions = new Set(['.ini', '.json', '.md', '.mjs', '.patch', '.ps1', '.py', '.txt', '.yaml', '.yml']);
const extensionlessTextPaths = new Set(['.gitattributes', '.gitignore', 'LICENSE']);
const exactAuthorizedPaths = new Set([
  '.gitattributes',
  '.gitignore',
  'NOTICE.md',
  'LICENSE',
  'docs/superpowers/plans/2026-09-01-pobtools-ko-maintenance-automation.md',
  'docs/superpowers/specs/2026-09-01-pobtools-ko-maintenance-automation-design.md',
  'docs/verification/2026-09-01-ko-maintenance-automation.md',
  'pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf',
  'pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt',
  'pob-zh-engine/dist/pob-zh.ini',
]);
const authorizedTrees = [
  '.github/workflows',
  'localization/ko-KR',
  'tests/ko-KR',
  'reports',
  'docs/ko-KR',
  'pob-zh-engine/dist/Data/launcher/ko-KR',
  'pob-zh-engine/dist/Data/poe1/ko-KR',
];
const forbiddenOutputSegments = new Set([
  '.cache',
  '.ko-worktrees',
  '.pytest_cache',
  '__pycache__',
  'node_modules',
]);
const forbiddenOutputExtensions = /\.(?:7z|a|dll|dylib|exe|lib|obj|pdb|pyc|so|zip)$/iu;

function runGit(repositoryRoot, arguments_, encoding = 'utf8') {
  try {
    return execFileSync('git', arguments_, {
      cwd: repositoryRoot,
      encoding,
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr ?? '');
    throw new Error(`Git command failed: git ${arguments_.join(' ')}${stderr ? `\n${stderr.trim()}` : ''}`);
  }
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right, 'en'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has invalid keys: ${actual.join(', ')}`);
  }
}

function validateRelativePath(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (path.includes('\\') || isAbsolute(path) || /^[/\\]|^[A-Za-z]:/u.test(path)) {
    throw new Error(`${label} must be a repository-relative POSIX path`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains traversal or an empty component`);
  }
  return path;
}

function isAuthorizedPath(path) {
  if (exactAuthorizedPaths.has(path)) return true;
  return authorizedTrees.some((tree) => path === tree || path.startsWith(`${tree}/`));
}

function assertAllowedPath(path) {
  if (!isAuthorizedPath(path)) throw new Error(`path is not authorized for the clean branch: ${path}`);
  if (/^pob-zh-engine\/host\//u.test(path)
    || /^pob-zh-engine\/ui_[^/]+\.(?:cpp|h)$/u.test(path)
    || /(?:^|\/)poe2(?:\/|$)/iu.test(path)) {
    throw new Error(`forbidden clean-branch path: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => forbiddenOutputSegments.has(segment.toLowerCase()))) {
    throw new Error(`forbidden local output path: ${path}`);
  }
  if (forbiddenOutputExtensions.test(path)) throw new Error(`forbidden output file type: ${path}`);
}

function validateManifest(value) {
  assertPlainObject(value, 'manifest');
  assertExactKeys(value, ['schemaVersion', 'targetBaseCommit', 'entries'], 'manifest');
  if (value.schemaVersion !== 1) throw new Error('manifest schemaVersion must be 1');
  if (typeof value.targetBaseCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.targetBaseCommit)) {
    throw new Error('manifest targetBaseCommit must be a full lowercase SHA-1');
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error('manifest entries must be a non-empty array');
  }
  const entries = value.entries.map((entry, index) => {
    assertPlainObject(entry, `manifest entry ${index}`);
    const allowedKeys = new Set(['path', 'kind', 'required', 'sha256']);
    const unknown = Object.keys(entry).filter((key) => !allowedKeys.has(key));
    if (unknown.length) throw new Error(`manifest entry ${index} has invalid keys: ${unknown.join(', ')}`);
    if (!Object.hasOwn(entry, 'path') || !Object.hasOwn(entry, 'kind')) {
      throw new Error(`manifest entry ${index} requires path and kind`);
    }
    const path = validateRelativePath(entry.path, `manifest entry ${index} path`);
    if (entry.kind !== 'file' && entry.kind !== 'tree') throw new Error(`manifest entry ${index} kind must be file or tree`);
    if (Object.hasOwn(entry, 'required') && (entry.kind !== 'tree' || typeof entry.required !== 'boolean')) {
      throw new Error(`manifest entry ${index} required is valid only as a boolean on a tree`);
    }
    if (Object.hasOwn(entry, 'sha256') && (entry.kind !== 'file' || typeof entry.sha256 !== 'string' || !/^[0-9A-F]{64}$/u.test(entry.sha256))) {
      throw new Error(`manifest entry ${index} sha256 must be an uppercase file digest`);
    }
    assertAllowedPath(path);
    return { path, kind: entry.kind, required: entry.required ?? true, sha256: entry.sha256 };
  });

  const byPath = sorted(entries.map((entry) => entry.path.toLowerCase()));
  for (let index = 0; index < byPath.length; index++) {
    if (index > 0 && byPath[index] === byPath[index - 1]) throw new Error(`duplicate manifest path: ${byPath[index]}`);
    for (let other = index + 1; other < byPath.length; other++) {
      if (byPath[other].startsWith(`${byPath[index]}/`)) {
        throw new Error(`overlapping manifest paths: ${byPath[index]} and ${byPath[other]}`);
      }
    }
  }
  return { schemaVersion: 1, targetBaseCommit: value.targetBaseCommit, entries };
}

function parseTreeRows(output) {
  if (output.length === 0) return [];
  return output.toString('utf8').split('\0').filter(Boolean).map((row) => {
    const match = /^(\d+) ([^ ]+) ([0-9a-f]+)\t(.+)$/u.exec(row);
    if (!match) throw new Error(`unexpected Git tree row: ${row}`);
    return { mode: match[1], type: match[2], blob: match[3], path: match[4] };
  });
}

function readExpandedFile(repositoryRoot, sourceCommit, row, expectedSha256) {
  const path = validateRelativePath(row.path, 'expanded Git path');
  assertAllowedPath(path);
  if (row.type !== 'blob' || !regularModes.has(row.mode)) {
    throw new Error(`source path is not a regular Git blob mode: ${path} (${row.mode} ${row.type})`);
  }
  const bytes = runGit(repositoryRoot, ['cat-file', 'blob', row.blob], null);
  if (!approvedBinaryPaths.has(path)) {
    const dot = path.lastIndexOf('.');
    const extension = dot >= path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
    if (!approvedTextExtensions.has(extension) && !extensionlessTextPaths.has(path)) {
      throw new Error(`file does not have an approved text extension: ${path}`);
    }
    if (bytes.includes(0)) throw new Error(`text blob contains NUL bytes: ${path}`);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`text blob is not strict UTF-8: ${path}`);
    }
  }
  const digest = sha256(bytes);
  if (pinnedAssetHashes.has(path) && digest !== pinnedAssetHashes.get(path)) {
    throw new Error(`source hash does not match approved asset for ${path}: ${digest}`);
  }
  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error(`source hash does not match manifest for ${path}: ${digest}`);
  }
  return { path, mode: row.mode, blob: row.blob, sha256: digest, size: bytes.length, bytes };
}

function resolveSourceCommit(repositoryRoot, sourceRef) {
  if (typeof sourceRef !== 'string' || sourceRef.length === 0) throw new Error('an explicit sourceRef is required');
  const commit = runGit(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`sourceRef did not resolve to a full commit: ${sourceRef}`);
  return commit;
}

export async function loadAndExpandCleanBranchManifest({ repositoryRoot, sourceRef }) {
  const sourceRoot = resolve(repositoryRoot);
  const sourceCommit = resolveSourceCommit(sourceRoot, sourceRef);
  let manifest;
  try {
    manifest = JSON.parse(runGit(sourceRoot, ['cat-file', 'blob', `${sourceCommit}:${manifestPath}`]));
  } catch (error) {
    throw new Error(`cannot read committed clean-branch manifest from ${sourceCommit}: ${error.message}`);
  }
  const validated = validateManifest(manifest);
  const expanded = [];
  for (const entry of validated.entries) {
    const rows = parseTreeRows(runGit(sourceRoot, ['ls-tree', '-r', '-z', '--full-tree', sourceCommit, '--', entry.path], null));
    if (entry.kind === 'file') {
      const exact = rows.filter((row) => row.path === entry.path);
      if (exact.length !== 1 || rows.length !== 1) throw new Error(`manifest file is missing or not exact: ${entry.path}`);
      expanded.push(readExpandedFile(sourceRoot, sourceCommit, exact[0], entry.sha256));
    } else {
      if (rows.length === 0 && entry.required) throw new Error(`required manifest tree is empty or missing: ${entry.path}`);
      for (const row of rows) expanded.push(readExpandedFile(sourceRoot, sourceCommit, row));
    }
  }
  expanded.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  for (let index = 1; index < expanded.length; index++) {
    if (expanded[index].path.toLowerCase() === expanded[index - 1].path.toLowerCase()) {
      throw new Error(`duplicate expanded path: ${expanded[index].path}`);
    }
  }
  return {
    schemaVersion: validated.schemaVersion,
    sourceCommit,
    targetBaseCommit: validated.targetBaseCommit,
    files: expanded,
  };
}

function normalizedRealPath(path) {
  return realpathSync.native(path).replace(/^\\\\\?\\/u, '').toLowerCase();
}

function assertNoRedirect(path, label) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} is a symbolic link, junction, or reparse point: ${path}`);
  if (normalizedRealPath(path) !== resolve(path).replace(/^\\\\\?\\/u, '').toLowerCase()) {
    throw new Error(`${label} resolves through a symbolic link, junction, or reparse point: ${path}`);
  }
}

function assertContained(root, path) {
  const remainder = relative(root, path);
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`target path escapes the target worktree: ${path}`);
  }
}

function preflightTargetPath(targetRoot, relativePath) {
  const destination = resolve(targetRoot, ...relativePath.split('/'));
  assertContained(targetRoot, destination);
  let current = targetRoot;
  assertNoRedirect(current, 'target worktree');
  for (const component of relativePath.split('/')) {
    current = resolve(current, component);
    assertContained(targetRoot, current);
    if (!existsSync(current)) break;
    assertNoRedirect(current, 'existing target component');
  }
  if (existsSync(destination) && !lstatSync(destination).isFile()) {
    throw new Error(`target file path is not a regular file: ${relativePath}`);
  }
  return destination;
}

function preflightTarget(targetRoot, targetBaseCommit, files) {
  const root = resolve(targetRoot);
  if (!existsSync(root)) throw new Error(`target worktree does not exist: ${root}`);
  assertNoRedirect(root, 'target worktree');
  const gitRoot = resolve(runGit(root, ['rev-parse', '--show-toplevel']).trim());
  if (gitRoot.toLowerCase() !== root.toLowerCase()) throw new Error(`target must be the root of a Git worktree: ${root}`);
  const head = runGit(root, ['rev-parse', 'HEAD']).trim();
  if (head !== targetBaseCommit) throw new Error(`target HEAD is not the pinned base ${targetBaseCommit}: ${head}`);
  for (const file of files) preflightTargetPath(root, file.path);
  const status = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.length !== 0) throw new Error(`target must be a clean Git worktree before materialization:\n${status.trim()}`);
  return root;
}

function publicSummary(expanded) {
  return {
    schemaVersion: 1,
    sourceCommit: expanded.sourceCommit,
    targetBaseCommit: expanded.targetBaseCommit,
    files: expanded.files.map(({ path, mode, blob, sha256: digest, size }) => ({
      path,
      mode,
      blob,
      sha256: digest,
      size,
    })),
  };
}

export async function materializeCleanBranch({ repositoryRoot, sourceRef, targetRoot, dryRun = false }) {
  const expanded = await loadAndExpandCleanBranchManifest({ repositoryRoot, sourceRef });
  const target = preflightTarget(targetRoot, expanded.targetBaseCommit, expanded.files);
  const summary = publicSummary(expanded);
  if (dryRun) return summary;
  for (const file of expanded.files) {
    const destination = resolve(target, ...file.path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes, { flag: 'w' });
    if (process.platform !== 'win32') chmodSync(destination, file.mode === '100755' ? 0o755 : 0o644);
  }
  return summary;
}
