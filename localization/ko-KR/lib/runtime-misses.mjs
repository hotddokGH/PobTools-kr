import { createHash } from 'node:crypto';

const sortEntries = (entries) => [...new Set(entries.filter((entry) => (
  typeof entry === 'string' && entry.length > 0
)))].sort((left, right) => left.localeCompare(right, 'en'));

const stripRuntimeColourCodes = (value) => String(value).replace(/\^(?:x.{6}|[0-9])/giu, '');

const runtimePatternShape = (value) => stripRuntimeColourCodes(value)
  .toLowerCase()
  .replace(/\{\d+\}/gu, '#')
  .replace(/[+-]?\d+(?:[.,]\d+)?/gu, '#');

const canonicalCandidateRank = (value) => {
  if (/\{\d+\}/u.test(value)) return 0;
  if (value.includes('#')) return 1;
  return 2;
};

const runtimeNumericTemplate = (value) => {
  let index = 0;
  return value.replace(/(?<![A-Za-z])[+-]?\d+(?:[.,]\d+)?/gu, () => `{${index++}}`);
};

export function luaDisplayStringCandidates(text) {
  const entries = [];
  const pattern = /\b(?:description|text)\s*=\s*("(?:\\.|[^"\\])*")/gu;
  for (const match of String(text).matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]);
      if (/[A-Za-z]{3}/u.test(value)) entries.push(value);
    } catch {
      // A Lua-only escape is not a JSON string literal; skip it conservatively.
    }
  }
  return sortEntries(entries);
}

export function canonicalizeRuntimeMissEntries(entries, candidates) {
  const canonicalCandidates = sortEntries(candidates);
  const exact = new Set(canonicalCandidates);
  const byShape = new Map();
  for (const candidate of canonicalCandidates) {
    const shape = runtimePatternShape(candidate);
    const values = byShape.get(shape) ?? [];
    values.push(candidate);
    values.sort((left, right) => (
      canonicalCandidateRank(left) - canonicalCandidateRank(right)
      || left.localeCompare(right, 'en')
    ));
    byShape.set(shape, values);
  }

  const plainEntries = sortEntries(entries.map(stripRuntimeColourCodes));
  const resolved = new Map();
  for (const entry of plainEntries) {
    if (exact.has(entry)) {
      resolved.set(entry, entry);
      continue;
    }
    const matches = byShape.get(runtimePatternShape(entry));
    if (matches?.length) resolved.set(entry, matches[0]);
  }

  const canonical = [...resolved.values()];
  for (const entry of plainEntries) {
    if (resolved.has(entry)) continue;
    const foldedEntry = entry.toLowerCase();
    const isWrappingFragment = plainEntries.some((complete) => (
      complete.length > entry.length
      && complete.toLowerCase().includes(foldedEntry)
    ));
    if (!isWrappingFragment) canonical.push(runtimeNumericTemplate(entry));
  }
  return sortEntries(canonical);
}

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
