import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeRuntimeMissEntries,
  luaDisplayStringCandidates,
  referenceUiKeys,
  untranslatedReferenceUiKeys,
  mergeRuntimeMissEntries,
  parseRuntimeMissLog,
  runtimeInventorySha256,
} from '../lib/runtime-misses.mjs';

test('Lua display extraction returns complete descriptions and stat templates', () => {
  const source = [
    'description = "Bloody scythes swipe around a selected area.",',
    'text="Deals {0} Base Physical Damage per second"',
    'internalCode = "DoNotTranslate",',
  ].join('\n');

  assert.deepEqual(luaDisplayStringCandidates(source), [
    'Bloody scythes swipe around a selected area.',
    'Deals {0} Base Physical Damage per second',
  ]);
});

test('runtime miss canonicalization removes colour and wrapping fragments and restores templates', () => {
  const description = 'Bloody scythes swipe around a selected area, hitting enemies with physical damage.';
  const entries = [
    '^x1AA29BBloody scythes swipe around a selected area',
    `^x1AA29B${description}`,
    'hitting enemies with physical damage.',
    '^x8888FFDeals 4950.3 Base Physical Damage',
    '^x8888FFDeals 4950.3 Base Physical Damage per second',
    '^x8888FFBase radius is 2.5 metres',
    'Standalone missing label',
    'Runtime composed status',
    'Runtime composed status with value',
    'Each mine applies 25% increased Damage Taken to Enemies near it, up',
    'Each Mine applies 25% increased Damage Taken to Enemies near it, up\nto a maximum of 150%',
    'Sorting 13%',
    'Sorting 60%',
    '+1.9m AoE Radius',
  ];

  assert.deepEqual(canonicalizeRuntimeMissEntries(entries, [
    description,
    'Deals {0} Base Physical Damage per second',
    'Base radius is # metres',
    'Base radius is {0} metres',
    'Each Mine applies {0}% increased Damage Taken to Enemies near it, up\nto a maximum of 150%',
  ]), [
    '{0}m AoE Radius',
    'Base radius is {0} metres',
    description,
    'Deals {0} Base Physical Damage per second',
    'Each Mine applies {0}% increased Damage Taken to Enemies near it, up\nto a maximum of 150%',
    'Runtime composed status with value',
    'Sorting {0}%',
    'Standalone missing label',
  ]);
});

test('runtime miss parser preserves multiline display strings and removes duplicates', () => {
  const log = [
    '# untranslated strings (locale=ko-KR) - unique per session',
    'MISS|Single line',
    'MISS|First line',
    'second line',
    'MISS|Single line',
    '',
  ].join('\n');

  assert.deepEqual(parseRuntimeMissLog(log), {
    locale: 'ko-KR',
    entries: ['First line\nsecond line', 'Single line'],
  });
});

test('runtime miss merge retains prior inventory while adding newly observed strings', () => {
  assert.deepEqual(
    mergeRuntimeMissEntries(['Existing', 'Shared'], ['New', 'Shared']),
    ['Existing', 'New', 'Shared'],
  );
});

test('runtime inventory hash is stable for the same entry set regardless of input order', () => {
  assert.equal(
    runtimeInventorySha256(['Beta', 'Alpha', 'Alpha']),
    runtimeInventorySha256(['Alpha', 'Beta']),
  );
  assert.match(runtimeInventorySha256(['Alpha', 'Beta']), /^[0-9A-F]{64}$/u);
});

test('reference UI inventory contributes every source key without using translated values', () => {
  assert.deepEqual(referenceUiKeys({
    source_files: ['reference'],
    entries: { Beta: '중문 값', Alpha: '다른 값' },
  }), ['Alpha', 'Beta']);
});

test('reference UI gap inventory includes only missing or unchanged Korean targets', () => {
  assert.deepEqual(untranslatedReferenceUiKeys(
    { entries: { Alpha: '중문 A', Beta: '중문 B', Gamma: '중문 C' } },
    { entries: { Alpha: '알파', Beta: 'Beta' } },
  ), ['Beta', 'Gamma']);
});
