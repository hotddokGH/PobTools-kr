import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const localeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(localeRoot, '..', '..');

test('Korean filter locale does not preload Traditional Chinese display maps', () => {
  const source = readFileSync(join(repositoryRoot, 'pob-zh-engine', 'host', 'filter_i18n.cpp'), 'utf8');
  assert.match(source, /const bool koreanLocale = locale == "ko-KR";/u);
  assert.match(source, /if \(!koreanLocale\) load_flat\([^\n]+filter_items_zh\.json/u);
  assert.match(source, /if \(!koreanLocale\) load_flat\([^\n]+item_classes_zh\.json/u);
});

test('generated Korean item parser metadata contains no Chinese display keys', () => {
  const metadata = JSON.parse(readFileSync(
    join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR', 'item_metadata.json'),
    'utf8',
  ));
  const han = /\p{Script=Han}/u;
  for (const section of ['headers', 'rarity_values', 'item_classes', 'influence_tags', 'status_lines', 'mod_annotations', 'composite_prefixes']) {
    for (const row of metadata[section]) assert.equal(han.test(row.zh), false, `${section}: ${row.zh}`);
  }
  for (const name of Object.keys(metadata.affix_names)) assert.equal(han.test(name), false, name);
});
