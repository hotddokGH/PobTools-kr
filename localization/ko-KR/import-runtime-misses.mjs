import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeRuntimeMissEntries,
  parseRuntimeMissLog,
  referenceUiKeys,
  runtimeInventorySha256,
  untranslatedReferenceUiKeys,
} from './lib/runtime-misses.mjs';

const localeRoot = dirname(fileURLToPath(import.meta.url));
const sourcePaths = [];
let referenceUiPath;
let targetUiPath;
const inputArguments = process.argv.slice(2);
for (let index = 0; index < inputArguments.length; index += 1) {
  if (inputArguments[index] === '--reference-ui') {
    if (referenceUiPath !== undefined || inputArguments[index + 1] === undefined) {
      throw new Error('--reference-ui requires one unique path');
    }
    referenceUiPath = resolve(inputArguments[index + 1]);
    index += 1;
  } else if (inputArguments[index] === '--target-ui') {
    if (targetUiPath !== undefined || inputArguments[index + 1] === undefined) {
      throw new Error('--target-ui requires one unique path');
    }
    targetUiPath = resolve(inputArguments[index + 1]);
    index += 1;
  } else {
    sourcePaths.push(resolve(inputArguments[index]));
  }
}
if (sourcePaths.length === 0 && referenceUiPath === undefined) {
  throw new Error('usage: node import-runtime-misses.mjs [--reference-ui ui.json --target-ui ui.json] [translate_misses.log ...]');
}
if (targetUiPath !== undefined && referenceUiPath === undefined) throw new Error('--target-ui requires --reference-ui');

const outputPath = join(localeRoot, 'runtime-inventory.json');
const existing = existsSync(outputPath)
  ? JSON.parse(readFileSync(outputPath, 'utf8'))
  : { entries: [] };
const captures = sourcePaths.map((path) => ({
  path,
  ...parseRuntimeMissLog(readFileSync(path, 'utf8')),
}));
const referenceEntries = referenceUiPath === undefined ? [] : (() => {
  const referenceDocument = JSON.parse(readFileSync(referenceUiPath, 'utf8'));
  return targetUiPath === undefined
    ? referenceUiKeys(referenceDocument)
    : untranslatedReferenceUiKeys(
      referenceDocument,
      JSON.parse(readFileSync(targetUiPath, 'utf8')),
    );
})();
const entries = mergeRuntimeMissEntries(
  Array.isArray(existing.entries) ? existing.entries : [],
  ...captures.map((capture) => capture.entries),
  referenceEntries,
);
const sourceLocales = new Set(String(existing.sourceLocale ?? '').split(',').filter(Boolean));
for (const { locale } of captures) sourceLocales.add(locale);

const output = {
  source: referenceUiPath === undefined
    ? 'merged runtime miss captures'
    : 'merged runtime miss captures and reference UI key inventory',
  sourceLocale: [...sourceLocales].sort().join(','),
  sha256: runtimeInventorySha256(entries),
  captureLastWriteTime: new Date().toISOString(),
  entries,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const added = entries.length - new Set(existing.entries ?? []).size;
console.log(`wrote ${entries.length} observed runtime display keys (${added} new) to ${outputPath}`);
