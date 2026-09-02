import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractKoreanTranslationTables } from './lib/pob-reference.mjs';

const localeRoot = dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error('usage: node import-pob-reference.mjs <KoreanTranslation.lua>');
}

const metadata = JSON.parse(readFileSync(join(localeRoot, 'reference', 'PathOfBuilding-kor.json'), 'utf8'));
const tables = extractKoreanTranslationTables(readFileSync(resolve(sourcePath), 'utf8'));
const output = { ...metadata, tables };
const outputPath = join(localeRoot, 'reference', 'PathOfBuilding-kor.entries.json');
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`wrote ${Object.values(tables).reduce((sum, entries) => sum + Object.keys(entries).length, 0)} reference entries to ${outputPath}`);
