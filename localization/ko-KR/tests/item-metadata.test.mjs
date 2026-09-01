import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKoreanItemMetadata } from '../lib/item-metadata.mjs';

test('item metadata keeps English parser targets and replaces display-side Chinese', () => {
  const result = buildKoreanItemMetadata({
    reference: {
      headers: [{ zh: '稀有度', en: 'Rarity' }],
      rarity_values: [{ zh: '稀有', en: 'Rare' }],
      item_classes: [], influence_tags: [], status_lines: [],
      skip_patterns: ['點擊右鍵'], mod_suffixes: ['(implicit)'],
      mod_annotations: [], header_values: {}, composite_prefixes: [],
      affix_names: { '七鰓鰻之': 'of the Lamprey' },
    },
    exactTerms: { Rarity: '희귀도', Rare: '희귀' },
    exactModNames: { 'of the Lamprey': '- 칠성장어' },
    manualTerms: {},
    manualAffixes: {},
    skipPatterns: ['우클릭'],
  });
  assert.deepEqual(result.document.headers, [{ zh: '희귀도', en: 'Rarity' }]);
  assert.deepEqual(result.document.rarity_values, [{ zh: '희귀', en: 'Rare' }]);
  assert.equal(result.document.affix_names['- 칠성장어'], 'of the Lamprey');
  assert.deepEqual(result.document.skip_patterns, ['우클릭']);
  assert.deepEqual(result.document.mod_suffixes, ['(implicit)']);
  assert.equal(result.unresolved.length, 0);
});

test('item metadata reports unresolved parser terms instead of retaining Chinese', () => {
  const result = buildKoreanItemMetadata({
    reference: {
      headers: [{ zh: '物品種類', en: 'Item Class' }],
      rarity_values: [], item_classes: [], influence_tags: [], status_lines: [],
      skip_patterns: [], mod_suffixes: [], mod_annotations: [], header_values: {},
      composite_prefixes: [], affix_names: { '未知之': 'Unknown Affix' },
    },
    exactTerms: {}, exactModNames: {}, manualTerms: {}, manualAffixes: {}, skipPatterns: [],
  });
  assert.deepEqual(result.unresolved, ['affix:Unknown Affix', 'term:Item Class']);
  assert.equal(JSON.stringify(result.document).includes('物品種類'), false);
  assert.equal(JSON.stringify(result.document).includes('未知之'), false);
});
