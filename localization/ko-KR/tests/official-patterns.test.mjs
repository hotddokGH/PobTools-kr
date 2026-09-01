import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveUnambiguousPatterns } from '../lib/official-patterns.mjs';

test('derives an official structural pattern with stable identity', () => {
  const result = deriveUnambiguousPatterns({
    rows: [{
      english: '{0}% increased maximum Life',
      korean: '최대 생명력 {0}% 증가',
      ids: ['maximum_life_+%'],
      variantIdentity: 'variant',
    }],
    patch: '3.29.3.2',
  });
  assert.equal(result.patterns.length, 1);
  assert.equal(result.patterns[0].identity, 'maximum_life_+%#variant');
});

test('rejects a normalized structure with conflicting official meanings', () => {
  const result = deriveUnambiguousPatterns({
    rows: [
      { english: '{0}% increased Damage', korean: '피해 {0}% 증가', ids: ['a'], variantIdentity: 'x' },
      { english: '{1}% increased Damage', korean: '피해가 {1}% 증가함', ids: ['b'], variantIdentity: 'y' },
    ],
    patch: '3.29.3.2',
  });
  assert.equal(result.patterns.length, 0);
  assert.equal(result.conflicts.length, 1);
});
