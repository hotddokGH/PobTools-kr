import test from 'node:test';
import assert from 'node:assert/strict';

import {
  referenceUiKeys,
  untranslatedReferenceUiKeys,
  mergeRuntimeMissEntries,
  parseRuntimeMissLog,
  runtimeInventorySha256,
} from '../lib/runtime-misses.mjs';

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
