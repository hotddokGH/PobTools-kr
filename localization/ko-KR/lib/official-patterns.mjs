import { formatSignature } from './format-signature.mjs';
import { normalizeStructuralText, reflowLineBreaks } from './merge-layers.mjs';

function rowIdentity(row) {
  if (row.id) return String(row.id);
  const ids = Array.isArray(row.ids) ? row.ids.join(',') : 'unknown';
  return `${ids}#${row.variantIdentity ?? 'no-variant'}`;
}

function sameFormat(left, right) {
  return JSON.stringify(formatSignature(left)) === JSON.stringify(formatSignature(right));
}

function canonicalTarget(source, target) {
  const slotOrder = new Map();
  for (const match of source.matchAll(/\{(\d+)\}/g)) {
    if (!slotOrder.has(match[1])) slotOrder.set(match[1], slotOrder.size);
  }
  return target.replace(/\{(\d+)\}/g, (placeholder, index) => (
    slotOrder.has(index) ? `<S${slotOrder.get(index)}>` : placeholder
  ));
}

export function deriveUnambiguousPatterns({ rows, patch }) {
  const groups = new Map();
  for (const row of rows) {
    const source = String(row.english ?? '');
    if (!/\{\d+\}/.test(source)) continue;
    const target = reflowLineBreaks(source, String(row.korean ?? ''));
    if (!sameFormat(source, target)) continue;
    const structure = normalizeStructuralText(source);
    if (!groups.has(structure)) groups.set(structure, []);
    groups.get(structure).push({
      source,
      target,
      canonical: canonicalTarget(source, target),
      identity: rowIdentity(row),
      patch,
    });
  }

  const patterns = [];
  const conflicts = [];
  for (const structure of [...groups.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    const candidates = groups.get(structure);
    const meanings = new Set(candidates.map((candidate) => candidate.canonical));
    if (meanings.size > 1) {
      conflicts.push({
        structure,
        identities: [...new Set(candidates.map((candidate) => candidate.identity))].sort(),
      });
      continue;
    }

    const unique = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.source}\u001f${candidate.target}`;
      if (!unique.has(key)) unique.set(key, []);
      unique.get(key).push(candidate.identity);
    }
    for (const [key, identities] of unique) {
      const [source, target] = key.split('\u001f');
      patterns.push({
        source,
        target,
        identity: [...new Set(identities)].sort().join(' | '),
        patch,
      });
    }
  }

  patterns.sort((left, right) => (
    left.source.localeCompare(right.source, 'en') || left.identity.localeCompare(right.identity, 'en')
  ));
  return { patterns, conflicts };
}
