import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeLayers,
  normalizeStructuralText,
  reflowLineBreaks,
  unresolvedReferenceKeys,
} from '../lib/merge-layers.mjs';

test('unresolved reference keys are reported after all translation layers are merged', () => {
  assert.deepEqual(
    unresolvedReferenceKeys({ Alpha: true, Beta: true, Gamma: true }, { Alpha: '알파', Gamma: '감마' }),
    ['Beta'],
  );
});

test('official exact terms override manual UI wording', () => {
  const result = mergeLayers({
    dictionary: 'gems',
    reference: { Arc: true },
    officialExact: { Arc: { value: '연쇄 번개', source: 'ActiveSkills/Arc' } },
    officialPatterns: {},
    manual: { Arc: '아크' },
    literals: {},
  });
  assert.equal(result.entries.Arc, '연쇄 번개');
  assert.equal(result.provenance.Arc.layer, 'official-exact');
});

test('a conflicting official identity is not applied', () => {
  assert.throws(() => mergeLayers({
    dictionary: 'items',
    reference: { Example: true },
    officialExact: { Example: { conflict: ['예시', '견본'] } },
    officialPatterns: {}, manual: {}, literals: {},
  }), /official conflict: items\/Example/);
});

test('manual text may fill PoB-only UI when no official row exists', () => {
  const result = mergeLayers({
    dictionary: 'ui', reference: { 'Full DPS': true }, officialExact: {}, officialPatterns: {},
    manual: { 'Full DPS': '전체 DPS' }, literals: {},
  });
  assert.equal(result.entries['Full DPS'], '전체 DPS');
  assert.equal(result.provenance['Full DPS'].layer, 'manual-pob-ui');
});

test('reviewed UI overrides machine fallback and each layer keeps its provenance', () => {
  const result = mergeLayers({
    dictionary: 'ui',
    reference: { Build: true, 'Long help text': true },
    officialExact: {},
    officialPatterns: {},
    fallbackLayers: [
      { layer: 'manual-pob-ui', source: 'manual/pob-ui.json', entries: { Build: '빌드' } },
      {
        layer: 'machine-assisted-pob-ui',
        source: 'manual/machine-fallback.json',
        entries: { Build: '구축', 'Long help text': '긴 도움말' },
      },
    ],
    literals: {},
  });
  assert.equal(result.entries.Build, '빌드');
  assert.equal(result.provenance.Build.layer, 'manual-pob-ui');
  assert.equal(result.entries['Long help text'], '긴 도움말');
  assert.equal(result.provenance['Long help text'].layer, 'machine-assisted-pob-ui');
});

test('official structural patterns expand signed decimals and ranges', () => {
  assert.equal(
    normalizeStructuralText('+12.5 to 18% increased maximum Life\n^xFF00FFLimited'),
    '<N> to <N>% increased maximum Life<LF><COLOR>Limited',
  );
  const result = mergeLayers({
    dictionary: 'stats',
    reference: { '12.5% increased maximum Life': true },
    officialExact: {},
    officialPatterns: [{
      source: '{0}% increased maximum Life',
      target: '최대 생명력 {0}% 증가',
      identity: 'maximum_life_+%',
      patch: '3.29.3.2',
    }],
    manual: {},
    literals: {},
  });
  assert.equal(result.entries['12.5% increased maximum Life'], '최대 생명력 12.5% 증가');
  assert.equal(result.provenance['12.5% increased maximum Life'].layer, 'official-structural-pattern');
});

test('official structural patterns preserve runtime placeholder format specifiers', () => {
  const result = mergeLayers({
    dictionary: 'stats',
    reference: { '{0:+d}% increased maximum Life': true },
    officialExact: {},
    officialPatterns: [{
      source: '{0}% increased maximum Life',
      target: '최대 생명력 {0}% 증가',
      identity: 'maximum_life_+%',
      patch: '3.29.3.2',
    }],
    manual: {},
    literals: {},
  });
  assert.equal(result.entries['{0:+d}% increased maximum Life'], '최대 생명력 {0:+d}% 증가');
});

test('structural patterns preserve sequential unnumbered placeholders', () => {
  const result = mergeLayers({
    dictionary: 'stats',
    reference: { 'Adds 12 to -4 Damage': true },
    officialExact: {},
    officialPatterns: [{
      source: 'Adds {} to {:+d} Damage',
      target: '피해 {}~{:+d} 추가',
      identity: 'unnumbered-damage',
      patch: '3.29.3.2',
    }],
    manual: {},
    literals: {},
  });
  assert.equal(result.entries['Adds 12 to -4 Damage'], '피해 12~-4 추가');
});

test('structural patterns reject a damaged placeholder signature', () => {
  assert.throws(() => mergeLayers({
    dictionary: 'stats',
    reference: { '12% increased maximum Life': true },
    officialExact: {},
    officialPatterns: [{
      source: '{0}% increased maximum Life',
      target: '최대 생명력 증가',
      identity: 'maximum_life_+%',
      patch: '3.29.3.2',
    }],
    manual: {}, literals: {},
  }), /pattern format mismatch: stats/);
});

test('official wording may be reflowed to preserve the source line-break count', () => {
  const value = reflowLineBreaks('First\nSecond', '첫째\n둘째\n셋째');
  assert.equal(value, '첫째 둘째\n셋째');
  assert.deepEqual(formatTokens(value), ['LF']);
});

function formatTokens(text) {
  return [...text.matchAll(/\n/g)].map(() => 'LF');
}
