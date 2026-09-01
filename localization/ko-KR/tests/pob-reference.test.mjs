import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKoreanTranslationTables } from '../lib/pob-reference.mjs';

test('extracts deterministic Lua string tables and decodes escapes', () => {
  const tables = extractKoreanTranslationTables(`
KoreanTranslation.statTranslations = {
  ["Line\\n{0}"] = "줄\\n{0}",
}
KoreanTranslation.gemNames = {
  ["Arc"] = "연쇄 번개",
}
`);
  assert.deepEqual(tables, {
    gemNames: { Arc: '연쇄 번개' },
    statTranslations: { 'Line\n{0}': '줄\n{0}' },
  });
});
