import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAndExpandCleanBranchManifest } from '../lib/clean-branch-materializer.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pinnedBase = 'ba33ed80de67d8301baad930456131d581df6ae1';
const expectedFontSha256 = '194018E6B2B293A7964F037B25C0249CE1418BC9AB3C971060A03AA57861E252';
const fontPath = 'pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf';

function gitBytes(...arguments_) {
  return execFileSync('git', arguments_, { cwd: repositoryRoot, encoding: null, maxBuffer: 16 * 1024 * 1024 });
}

function git(...arguments_) {
  return gitBytes(...arguments_).toString('utf8').trim();
}

function treeRows(reference) {
  const output = gitBytes('ls-tree', '-r', '-z', reference);
  return new Map(output.toString('utf8').split('\0').filter(Boolean).map((row) => {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/u.exec(row);
    assert.ok(match, `unexpected tree row: ${row}`);
    return [match[3], { mode: match[1], blob: match[2] }];
  }));
}

function isProtectedSource(path) {
  return /^pob-zh-engine\/host\/.+\.(?:cpp|h)$/u.test(path)
    || /^pob-zh-engine\/ui_[^/]+\.(?:cpp|h)$/u.test(path);
}

function isGeneratedHostData(path) {
  return /^pob-zh-engine\/host\/data\/(?:atlas_maps_poe1|astrolabes_poe1|scarabs_poe1|regex_poe1|timeless_jewels)\.json$/u.test(path)
    || /^pob-zh-engine\/host\/data\/atlas_versions\/[^/]+\/atlas_tree_zh\.json$/u.test(path);
}

const currentBranch = git('branch', '--show-current');

test('ko/main retains exact upstream sources and only the manifest inventory', {
  skip: currentBranch !== 'ko/main' ? `clean-branch contract only applies on ko/main, not ${currentBranch || 'detached HEAD'}` : false,
}, async () => {
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');
  const head = git('rev-parse', 'HEAD');
  const current = treeRows(head);
  const upstream = treeRows(pinnedBase);

  const protectedPaths = [...new Set([...current.keys(), ...upstream.keys()].filter(isProtectedSource))].sort();
  assert.ok(protectedPaths.length > 0);
  for (const path of protectedPaths) {
    assert.equal(current.get(path)?.blob, upstream.get(path)?.blob, `upstream source blob changed: ${path}`);
  }

  const generatedPaths = [...new Set([...current.keys(), ...upstream.keys()].filter(isGeneratedHostData))].sort();
  assert.ok(generatedPaths.length > 0);
  for (const path of generatedPaths) {
    assert.equal(current.get(path)?.blob, upstream.get(path)?.blob, `generated Korean host data was committed: ${path}`);
  }
  assert.deepEqual(
    [...current.keys()].filter((path) => /^pob-zh-engine\/dist\/Data\/poe2\/ko-KR\//iu.test(path)),
    [],
  );

  const expanded = await loadAndExpandCleanBranchManifest({ repositoryRoot, sourceRef: head });
  const expectedDelta = expanded.files
    .filter((row) => upstream.get(row.path)?.blob !== row.blob)
    .map((row) => row.path)
    .sort();
  const actualDelta = git('diff', '--name-only', pinnedBase, head).split(/\r?\n/u).filter(Boolean).sort();
  assert.deepEqual(actualDelta, expectedDelta);
  for (const row of expanded.files) {
    assert.equal(current.get(row.path)?.blob, row.blob, `retained asset missing or changed: ${row.path}`);
  }

  const fontBytes = gitBytes('cat-file', 'blob', `${head}:${fontPath}`);
  assert.equal(createHash('sha256').update(fontBytes).digest('hex').toUpperCase(), expectedFontSha256);
});
