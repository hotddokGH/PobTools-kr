import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
function explicitDirectory(environmentName, fallback) {
  const value = process.env[environmentName];
  const path = resolve(value ?? fallback);
  if (value !== undefined) {
    try {
      if (!statSync(path).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`${environmentName} must be an existing directory: ${path}`);
    }
  }
  return path;
}

const engineRoot = explicitDirectory('POBTOOLS_ENGINE_ROOT', join(root, 'pob-zh-engine'));
const reportRoot = explicitDirectory('POBTOOLS_REPORT_ROOT', join(root, 'reports'));
const dataRoot = join(engineRoot, 'host', 'data');
const officialRoot = join(root, 'localization', 'ko-KR', 'official-terms', 'custom-data');
const han = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const hangul = /[가-힣]/u;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function assertKorean(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  assert.equal(han.test(value), false, `${label} contains Han characters: ${value}`);
  assert.equal(hangul.test(value), true, `${label} contains no Hangul: ${value}`);
}

test('PoE1 custom catalogues use official Korean names and contain no Chinese display text', () => {
  const officialItems = readJson(join(officialRoot, 'Korean.base_items.min.json'));
  const maps = readJson(join(dataRoot, 'atlas_maps_poe1.json')).maps;
  const astrolabes = readJson(join(dataRoot, 'astrolabes_poe1.json'));
  const scarabs = readJson(join(dataRoot, 'scarabs_poe1.json')).scarabs;
  const regex = readJson(join(dataRoot, 'regex_poe1.json'));

  for (const map of maps) {
    assertKorean(map.zhArea, `${map.id}.zhArea`);
    assertKorean(map.zhItem, `${map.id}.zhItem`);
    const official = officialItems[`Metadata/Items/Maps/${map.id}`];
    if (official?.name) assert.equal(map.zhItem, official.name, `${map.id} must use the official item name`);
  }
  for (const region of astrolabes.regions) assertKorean(region.vaultZh, `${region.id}.vaultZh`);
  for (const item of astrolabes.astrolabes) {
    assertKorean(item.zh, `${item.id}.zh`);
    item.descZh.forEach((line, index) => assertKorean(line, `${item.id}.descZh[${index}]`));
    assert.equal(item.zh, officialItems[item.id]?.name, `${item.id} must use the official item name`);
  }
  for (const item of scarabs) {
    assertKorean(item.zh, `${item.id}.zh`);
    item.descZh.forEach((line, index) => assertKorean(line, `${item.id}.descZh[${index}]`));
    assert.equal(item.zh, officialItems[item.id]?.name, `${item.id} must use the official item name`);
  }
  for (const page of regex.pages) {
    assertKorean(page.title, `${page.id}.title`);
    assertKorean(page.note, `${page.id}.note`);
    page.groups.forEach((value, index) => assertKorean(value, `${page.id}.groups[${index}]`));
    for (const entry of page.entries) {
      entry.zh.forEach((value, index) => assertKorean(value, `${entry.id}.zh[${index}]`));
      assertKorean(entry.affixZh, `${entry.id}.affixZh`);
    }
  }
});

test('all bundled atlas seasons have Korean node mappings with aligned stats', () => {
  const versionsRoot = join(dataRoot, 'atlas_versions');
  for (const version of readdirSync(versionsRoot)) {
    const mapping = readJson(join(versionsRoot, version, 'atlas_tree_zh.json'));
    assert.ok(mapping.joined > 0, `${version} must contain joined Korean nodes`);
    for (const [id, node] of Object.entries(mapping.nodes)) {
      if (node.zh) assertKorean(node.zh, `${version}/${id}.zh`);
      if (!node.statsZh) continue;
      assert.equal(node.statsZh.length, node.statsEn.length, `${version}/${id} stat arrays must align`);
      node.statsZh.forEach((value, index) => assertKorean(value, `${version}/${id}.statsZh[${index}]`));
    }
  }
});

test('Timeless Jewel display names and stats contain no Chinese text', () => {
  const data = readJson(join(dataRoot, 'timeless_jewels.json'));
  for (const group of Object.values(data.conquerors)) {
    for (const conqueror of group) assertKorean(conqueror.nameZh, `conqueror ${conqueror.id}`);
  }
  for (const entry of [...data.additions, ...data.nodes]) {
    assertKorean(entry.dnZh, `${entry.id}.dnZh`);
    entry.sdZh.forEach((value, index) => assertKorean(value, `${entry.id}.sdZh[${index}]`));
  }
});

test('custom catalogue provenance is deterministic and appears exactly once', () => {
  const catalogues = [
    ['atlas_maps_poe1.json', 'Korean names: official RePoE 3.29.3.2'],
    ['astrolabes_poe1.json', 'Korean text: official RePoE 3.29.3.2'],
    ['scarabs_poe1.json', 'Korean text: official RePoE 3.29.3.2'],
    ['regex_poe1.json', 'Korean text: official RePoE 3.29.3.2'],
  ];
  for (const [name, marker] of catalogues) {
    const source = readJson(join(dataRoot, name)).source;
    assert.equal(source.split(marker).length - 1, 1, `${name} must contain one provenance marker`);
  }

  const report = readJson(join(reportRoot, 'official-terms', 'custom-data.json'));
  assert.equal(Object.hasOwn(report, 'generatedAtUtc'), false, 'custom-data report must not contain a wall-clock timestamp');
});
