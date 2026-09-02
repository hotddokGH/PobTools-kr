import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const localeRoot = dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('usage: node import-runtime-misses.mjs <translate_misses.log>');

const bytes = readFileSync(resolve(sourcePath));
const text = bytes.toString('utf8');
const entries = [...new Set(
  text.split(/\r?\n/)
    .filter((line) => line.startsWith('MISS|'))
    .map((line) => line.slice(5))
    .filter((line) => line.length > 0),
)].sort((left, right) => left.localeCompare(right, 'en'));

const output = {
  source: 'PobTools-1.1.0/translate_misses.log',
  sourceLocale: text.match(/locale=([^\)]+)/)?.[1] ?? 'unknown',
  sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  captureLastWriteTime: '2026-09-01T12:36:25+09:00',
  entries,
};
const outputPath = join(localeRoot, 'runtime-inventory.json');
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`wrote ${entries.length} observed runtime display keys to ${outputPath}`);
