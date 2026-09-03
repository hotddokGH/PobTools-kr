import { createHash } from 'node:crypto';

const sortEntries = (entries) => [...new Set(entries.filter((entry) => (
  typeof entry === 'string' && entry.length > 0
)))].sort((left, right) => left.localeCompare(right, 'en'));

export function parseRuntimeMissLog(text) {
  const source = String(text).replaceAll('\r\n', '\n');
  const entries = [];
  const pattern = /^MISS\|([\s\S]*?)(?=^MISS\||(?![\s\S]))/gmu;
  for (const match of source.matchAll(pattern)) {
    const value = match[1].endsWith('\n') ? match[1].slice(0, -1) : match[1];
    if (value.length > 0) entries.push(value);
  }
  return {
    locale: source.match(/locale=([^\)]+)/u)?.[1] ?? 'unknown',
    entries: sortEntries(entries),
  };
}

export function mergeRuntimeMissEntries(...collections) {
  return sortEntries(collections.flat());
}

export function referenceUiKeys(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || !document.entries || typeof document.entries !== 'object' || Array.isArray(document.entries)) {
    throw new Error('reference UI document must contain an entries object');
  }
  return sortEntries(Object.keys(document.entries));
}

export function untranslatedReferenceUiKeys(referenceDocument, targetDocument) {
  const reference = referenceUiKeys(referenceDocument);
  if (!targetDocument || typeof targetDocument !== 'object' || Array.isArray(targetDocument)
    || !targetDocument.entries || typeof targetDocument.entries !== 'object'
    || Array.isArray(targetDocument.entries)) {
    throw new Error('target UI document must contain an entries object');
  }
  return reference.filter((key) => (
    !Object.hasOwn(targetDocument.entries, key) || targetDocument.entries[key] === key
  ));
}

export function runtimeInventorySha256(entries) {
  const canonical = JSON.stringify(mergeRuntimeMissEntries(entries));
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toUpperCase();
}
