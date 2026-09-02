import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_NAME = 'maintenance-bundle-manifest.json';
const PAYLOAD_NAME = 'payload';
const EXACT_PATHS = new Set([
  'reports/maintenance/upstream-update.json',
  'localization/ko-KR/source-translation-suggestions.json',
]);
const PREFIXES = [
  'pob-zh-engine/dist/Data/launcher/ko-KR/',
  'pob-zh-engine/dist/Data/poe1/ko-KR/',
  'reports/display-closure/',
  'reports/official-terms/',
];
const VERIFIED_BYTES = new WeakMap();

function compare(left, right) {
  return left.localeCompare(right, 'en');
}

function normalized(path) {
  const output = resolve(path);
  return process.platform === 'win32' ? output.toLowerCase() : output;
}

function isInside(path, root) {
  return normalized(path) === normalized(root) || normalized(path).startsWith(`${normalized(root)}${sep}`);
}

function lstatEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertRegularRoot(path, label) {
  const metadata = lstatEntry(path);
  if (!metadata) throw new Error(`${label} does not exist`);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a regular directory`);
}

function assertEmptyOutput(path, label) {
  const metadata = lstatEntry(path);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || readdirSync(path).length !== 0) {
    throw new Error(`${label} must not exist or must be an empty regular directory`);
  }
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} keys must be exactly ${keys.join(', ')}`);
  }
}

function assertAllowedPath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('bundle path must be a non-empty string');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)
      || path.includes('\\') || isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.startsWith('//')) {
    throw new Error(`bundle path must be normalized and relative: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`bundle path has an unsafe segment: ${path}`);
  }
  if (!EXACT_PATHS.has(path) && !PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length)) {
    throw new Error(`bundle path is outside the allowlist: ${path}`);
  }
}

function assertExistingPathChain(root, relativePath, label) {
  let cursor = root;
  for (const segment of relativePath.split('/')) {
    cursor = join(cursor, segment);
    const metadata = lstatEntry(cursor);
    if (!metadata) return;
    if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic link, junction, or reparse point: ${relativePath}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function directoryFiles(root, relativeRoot = '') {
  const absolute = relativeRoot ? join(root, ...relativeRoot.split('/')) : root;
  const metadata = lstatEntry(absolute);
  if (!metadata) return [];
  if (metadata.isSymbolicLink()) throw new Error(`bundle source contains a symbolic link, junction, or reparse point: ${relativeRoot}`);
  if (metadata.isFile()) return [relativeRoot];
  if (!metadata.isDirectory()) throw new Error(`bundle source contains a non-regular entry: ${relativeRoot}`);
  const output = [];
  for (const name of readdirSync(absolute).sort(compare)) {
    const child = relativeRoot ? `${relativeRoot}/${name}` : name;
    output.push(...directoryFiles(root, child));
  }
  return output;
}

function collectSourcePaths(sourceRoot) {
  const output = [];
  for (const path of [...EXACT_PATHS].sort(compare)) {
    const absolute = join(sourceRoot, ...path.split('/'));
    assertExistingPathChain(sourceRoot, path, 'bundle source');
    const metadata = lstatEntry(absolute);
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`bundle source is not a regular file: ${path}`);
    output.push(path);
  }
  for (const prefix of [...PREFIXES].sort(compare)) {
    const root = prefix.slice(0, -1);
    assertExistingPathChain(sourceRoot, root, 'bundle source');
    output.push(...directoryFiles(sourceRoot, root));
  }
  if (!output.includes('reports/maintenance/upstream-update.json')) {
    throw new Error('maintenance report is required in a bundle');
  }
  for (const path of output) assertAllowedPath(path);
  return [...new Set(output)].sort(compare);
}

function writeBundle(files, bundleRoot) {
  const payloadRoot = join(bundleRoot, PAYLOAD_NAME);
  mkdirSync(payloadRoot, { recursive: true });
  for (const file of files) {
    const destination = join(payloadRoot, ...file.path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes);
  }
  const manifest = {
    schemaVersion: 1,
    files: files.map(({ path, bytes }) => ({ path, sha256: sha256(bytes), size: bytes.length })),
  };
  writeFileSync(join(bundleRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function createMaintenanceBundle({ sourceRoot, bundleRoot }) {
  const source = resolve(sourceRoot);
  const bundle = resolve(bundleRoot);
  assertRegularRoot(source, 'bundle source root');
  if (normalized(source) === normalized(bundle)) throw new Error('bundle root must differ from source root');
  assertEmptyOutput(bundle, 'bundle root');
  const paths = collectSourcePaths(source);
  const files = paths.map((path) => {
    const absolute = join(source, ...path.split('/'));
    if (!isInside(absolute, source)) throw new Error(`bundle source path escapes its root: ${path}`);
    return { path, bytes: readFileSync(absolute) };
  });
  mkdirSync(bundle, { recursive: true });
  return writeBundle(files, bundle);
}

function readManifest(bundleRoot) {
  assertRegularRoot(bundleRoot, 'bundle root');
  const manifestPath = join(bundleRoot, MANIFEST_NAME);
  const metadata = lstatEntry(manifestPath);
  if (!metadata) throw new Error('bundle manifest is missing');
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('bundle manifest must be a regular file');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('bundle manifest is not valid JSON');
  }
  assertExactKeys(manifest, ['schemaVersion', 'files'], 'bundle manifest');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('bundle manifest schema is invalid');
  const seen = new Set();
  let previous = '';
  for (const [index, row] of manifest.files.entries()) {
    assertExactKeys(row, ['path', 'sha256', 'size'], `bundle manifest files[${index}]`);
    assertAllowedPath(row.path);
    const folded = row.path.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new Error(`bundle path is duplicated or case-fold-colliding: ${row.path}`);
    if (previous && compare(previous, row.path) >= 0) throw new Error('bundle manifest paths must be sorted and unique');
    if (!/^[0-9A-F]{64}$/u.test(row.sha256)) throw new Error(`bundle SHA-256 is invalid: ${row.path}`);
    if (!Number.isSafeInteger(row.size) || row.size < 0) throw new Error(`bundle size is invalid: ${row.path}`);
    seen.add(folded);
    previous = row.path;
  }
  if (!manifest.files.some((row) => row.path === 'reports/maintenance/upstream-update.json')) {
    throw new Error('bundle manifest is missing the maintenance report');
  }
  return manifest;
}

function verifyPayload(bundleRoot, manifest) {
  const payloadRoot = join(bundleRoot, PAYLOAD_NAME);
  assertRegularRoot(payloadRoot, 'bundle payload root');
  const actual = directoryFiles(payloadRoot).sort(compare);
  const expected = manifest.files.map((row) => row.path);
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error('bundle payload has missing or extra files');
  }
  const buffers = new Map();
  for (const row of manifest.files) {
    const path = join(payloadRoot, ...row.path.split('/'));
    if (!isInside(path, payloadRoot)) throw new Error(`bundle payload path escapes its root: ${row.path}`);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`bundle payload is not a regular file: ${row.path}`);
    const bytes = readFileSync(path);
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256) throw new Error(`bundle payload hash or size mismatch: ${row.path}`);
    buffers.set(row.path, bytes);
  }
  return buffers;
}

export function verifyMaintenanceBundle({ bundleRoot, stagingRoot }) {
  const bundle = resolve(bundleRoot);
  const manifest = readManifest(bundle);
  const buffers = verifyPayload(bundle, manifest);
  if (stagingRoot !== undefined) {
    const staging = resolve(stagingRoot);
    if (normalized(staging) === normalized(bundle)) throw new Error('staging root must differ from bundle root');
    assertEmptyOutput(staging, 'staging root');
    mkdirSync(staging, { recursive: true });
    writeBundle(manifest.files.map((row) => ({ path: row.path, bytes: buffers.get(row.path) })), staging);
  }
  const immutableManifest = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    files: Object.freeze(manifest.files.map((row) => Object.freeze({ ...row }))),
  });
  const verifiedBundle = Object.freeze({ manifest: immutableManifest });
  VERIFIED_BYTES.set(verifiedBundle, new Map([...buffers].map(([path, bytes]) => [path, Buffer.from(bytes)])));
  return verifiedBundle;
}

function assertDestinationSafe(destinationRoot, paths) {
  const root = resolve(destinationRoot);
  const rootMetadata = lstatEntry(root);
  if (rootMetadata && (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())) {
    throw new Error('destination root must be a regular directory');
  }
  const realRoot = rootMetadata ? realpathSync(root) : undefined;
  for (const path of paths) {
    const target = join(root, ...path.split('/'));
    if (!isInside(target, root)) throw new Error(`bundle destination escapes its root: ${path}`);
    let cursor = root;
    for (const segment of path.split('/')) {
      cursor = join(cursor, segment);
      const metadata = lstatEntry(cursor);
      if (!metadata) break;
      if (metadata.isSymbolicLink()) throw new Error(`bundle destination contains a symbolic link, junction, or reparse point: ${path}`);
      if (cursor !== target && !metadata.isDirectory()) throw new Error(`bundle destination ancestor is not a directory: ${path}`);
      if (cursor === target && !metadata.isFile()) throw new Error(`bundle destination is not a regular file: ${path}`);
      if (realRoot && !isInside(realpathSync(cursor), realRoot)) throw new Error(`bundle destination resolves outside its root: ${path}`);
    }
  }
}

function ensureSafeDirectoryChain(root, parent, createdDirectories) {
  const relativeParent = relative(root, parent);
  let cursor = root;
  if (!lstatEntry(root)) {
    mkdirSync(root);
    createdDirectories.push(root);
  }
  const rootMetadata = lstatEntry(root);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('destination root must be a regular directory');
  }
  const realRoot = realpathSync(root);
  if (!relativeParent) return;
  for (const segment of relativeParent.split(sep)) {
    cursor = join(cursor, segment);
    if (!lstatEntry(cursor)) {
      mkdirSync(cursor);
      createdDirectories.push(cursor);
    }
    const metadata = lstatEntry(cursor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`bundle destination ancestor is not a regular directory: ${relativeParent.split(sep).join('/')}`);
    }
    if (!isInside(realpathSync(cursor), realRoot)) {
      throw new Error(`bundle destination ancestor resolves outside its root: ${relativeParent.split(sep).join('/')}`);
    }
  }
}

function assertSafeDestinationParent(destination, path) {
  const parent = dirname(path);
  if (!isInside(parent, destination)) throw new Error('transaction path escapes the destination root');
  const rootMetadata = lstatEntry(destination);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('destination root must be a regular directory');
  }
  const realRoot = realpathSync(destination);
  let cursor = destination;
  for (const segment of relative(destination, parent).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    const metadata = lstatEntry(cursor);
    if (!metadata) throw new Error(`transaction parent is missing: ${relative(destination, parent).split(sep).join('/')}`);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !isInside(realpathSync(cursor), realRoot)) {
      throw new Error(`transaction parent is not a safe regular directory: ${relative(destination, parent).split(sep).join('/')}`);
    }
  }
}

function removeTransactionTemporary(path, destination) {
  assertSafeDestinationParent(destination, path);
  const metadata = lstatEntry(path);
  if (!metadata) return;
  if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error(`transaction temporary is not removable: ${path}`);
  unlinkSync(path);
}

function removeDestinationLeaf(path, destination) {
  assertSafeDestinationParent(destination, path);
  const metadata = lstatEntry(path);
  if (!metadata) return;
  if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error(`transaction destination is not removable: ${path}`);
  unlinkSync(path);
}

function assertIndependentExpectedFile(path, row, label) {
  const metadata = lstatEntry(path);
  if (!metadata) throw new Error(`${label} must be an independent regular file with exactly one hard link: ${row.path}`);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || normalized(realpathSync(path)) !== normalized(path)) {
    throw new Error(`${label} must be an independent regular file with exactly one hard link: ${row.path}`);
  }
  const bytes = readFileSync(path);
  if (bytes.length !== row.size || sha256(bytes) !== row.sha256) {
    throw new Error(`${label} does not contain the immutable verified bytes: ${row.path}`);
  }
}

function assertIndependentBytes(path, bytes, label) {
  const metadata = lstatEntry(path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || normalized(realpathSync(path)) !== normalized(path)) {
    throw new Error(`${label} must be an independent regular file with exactly one hard link: ${path}`);
  }
  if (!readFileSync(path).equals(bytes)) throw new Error(`${label} does not contain the snapshot bytes: ${path}`);
}

function uniqueTemporaryPath(target, index) {
  let attempt = 0;
  while (true) {
    const candidate = join(dirname(target), `.${target.split(sep).at(-1)}.pobtools-${process.pid}-${index}-${attempt}.tmp`);
    if (!lstatEntry(candidate)) return candidate;
    attempt += 1;
  }
}

function restoreTransaction({ changed, snapshots, createdDirectories, temporaryPaths, destination, originalError }) {
  let rollbackError;
  for (const path of temporaryPaths) {
    try {
      removeTransactionTemporary(path, destination);
    } catch (error) { rollbackError ??= error; }
  }
  for (const row of [...changed].reverse()) {
    try {
      const target = join(destination, ...row.path.split('/'));
      const snapshot = snapshots.get(row.path);
      if (snapshot === null) {
        removeDestinationLeaf(target, destination);
      } else {
        const rollback = uniqueTemporaryPath(target, `rollback-${row.index}`);
        temporaryPaths.push(rollback);
        try {
          writeFileSync(rollback, snapshot, { flag: 'wx' });
          assertIndependentBytes(rollback, snapshot, 'transaction rollback temporary');
          removeDestinationLeaf(target, destination);
          assertSafeDestinationParent(destination, target);
          assertIndependentBytes(rollback, snapshot, 'transaction rollback temporary');
          renameSync(rollback, target);
          temporaryPaths.splice(temporaryPaths.indexOf(rollback), 1);
          assertIndependentBytes(target, snapshot, 'restored bundle file');
        } catch (error) {
          try {
            removeTransactionTemporary(rollback, destination);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'bundle restoration and temporary cleanup failed');
          }
          throw error;
        }
      }
    } catch (error) {
      rollbackError ??= error;
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      if (normalized(directory) !== normalized(destination)) assertSafeDestinationParent(destination, directory);
      const metadata = lstatEntry(directory);
      if (!metadata) continue;
      if (metadata.isSymbolicLink()) unlinkSync(directory);
      else if (metadata.isDirectory() && readdirSync(directory).length === 0) rmdirSync(directory);
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (rollbackError) throw new AggregateError([originalError, rollbackError], 'bundle transaction and rollback failed');
  throw originalError;
}

export function copyVerifiedMaintenanceBundle({ verifiedBundle, destinationRoot, operations = {} }) {
  const destination = resolve(destinationRoot);
  const buffers = VERIFIED_BYTES.get(verifiedBundle);
  if (!buffers) throw new Error('verified bundle token is invalid or was not created by this process');
  const { manifest } = verifiedBundle;
  if (operations === null || typeof operations !== 'object' || Array.isArray(operations)
      || (operations.beforeReplace !== undefined && typeof operations.beforeReplace !== 'function')
      || (operations.afterInstall !== undefined && typeof operations.afterInstall !== 'function')
      || (operations.writeTemporary !== undefined && typeof operations.writeTemporary !== 'function')) {
    throw new Error('bundle transaction operations are invalid');
  }
  assertDestinationSafe(destination, manifest.files.map((row) => row.path));
  const snapshots = new Map();
  const createdDirectories = [];
  const temporaryPaths = [];
  const plan = [];
  const changed = [];
  try {
    for (const [index, row] of manifest.files.entries()) {
      const target = join(destination, ...row.path.split('/'));
      const targetMetadata = lstatEntry(target);
      if (targetMetadata && (targetMetadata.isSymbolicLink() || !targetMetadata.isFile())) {
        throw new Error(`bundle destination is not a regular file: ${row.path}`);
      }
      snapshots.set(row.path, targetMetadata ? Buffer.from(readFileSync(target)) : null);
      ensureSafeDirectoryChain(destination, dirname(target), createdDirectories);
      assertDestinationSafe(destination, [row.path]);
      const temporary = uniqueTemporaryPath(target, index);
      const bytes = buffers.get(row.path);
      temporaryPaths.push(temporary);
      if (operations.writeTemporary) operations.writeTemporary({ temporaryPath: temporary, bytes: Buffer.from(bytes), relativePath: row.path });
      else writeFileSync(temporary, bytes, { flag: 'wx' });
      assertIndependentExpectedFile(temporary, row, 'transaction temporary');
      plan.push({ ...row, index, target, temporary });
    }
    for (const row of plan) {
      operations.beforeReplace?.({ relativePath: row.path, index: row.index, destinationRoot: destination });
      assertDestinationSafe(destination, [row.path]);
      assertIndependentExpectedFile(row.temporary, row, 'transaction temporary');
      renameSync(row.temporary, row.target);
      temporaryPaths.splice(temporaryPaths.indexOf(row.temporary), 1);
      changed.push(row);
      operations.afterInstall?.({ relativePath: row.path, index: row.index, destinationRoot: destination });
      assertIndependentExpectedFile(row.target, row, 'installed bundle file');
    }
  } catch (error) {
    restoreTransaction({ changed, snapshots, createdDirectories, temporaryPaths, destination, originalError: error });
  }
  return manifest;
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  if (!['create', 'verify', 'apply'].includes(command)) throw new Error('bundle command must be create, verify, or apply');
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw new Error('bundle arguments must be unique --name value pairs');
    values.set(key, value);
  }
  return { command, values };
}

function required(values, key) {
  if (!values.has(key)) throw new Error(`missing bundle argument: ${key}`);
  return values.get(key);
}

function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  let manifest;
  if (command === 'create') manifest = createMaintenanceBundle({ sourceRoot: required(values, '--source'), bundleRoot: required(values, '--bundle') });
  if (command === 'verify') manifest = verifyMaintenanceBundle({ bundleRoot: required(values, '--bundle'), stagingRoot: required(values, '--staging') }).manifest;
  if (command === 'apply') {
    const verifiedBundle = verifyMaintenanceBundle({ bundleRoot: required(values, '--bundle'), stagingRoot: required(values, '--staging') });
    manifest = copyVerifiedMaintenanceBundle({ verifiedBundle, destinationRoot: required(values, '--destination') });
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: manifest.schemaVersion, files: manifest.files.length })}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
