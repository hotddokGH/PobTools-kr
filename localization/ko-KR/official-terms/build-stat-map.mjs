import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const toolRoot = dirname(scriptPath);
const projectRoot = dirname(dirname(dirname(toolRoot)));
const sourceRoot = join(toolRoot, 'stat-descriptions');
const reportRoot = join(projectRoot, 'reports', 'official-terms', 'stat-descriptions');
const sources = JSON.parse(readFileSync(join(sourceRoot, 'sources.json'), 'utf8'));

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase();
}

function readPinnedSource(language) {
  const metadata = sources[language.toLowerCase()];
  const path = join(sourceRoot, metadata.file);
  const buffer = readFileSync(path);
  const actualHash = sha256Buffer(buffer);
  if (buffer.length !== metadata.bytes || actualHash !== metadata.sha256) {
    throw new Error(`${language} stat source failed its pinned size/hash check`);
  }
  return JSON.parse(buffer.toString('utf8'));
}

function entryIdentity(ids) {
  return JSON.stringify(ids);
}

function variantIdentity(variant) {
  return JSON.stringify({
    condition: variant.condition ?? [],
    format: variant.format ?? [],
    index_handlers: variant.index_handlers ?? [],
  });
}

function groupBy(items, keyFunction) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function placeholders(text) {
  return [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
}

function placeholdersMatch(english, korean) {
  return JSON.stringify(placeholders(english)) === JSON.stringify(placeholders(korean));
}

function normalizeText(text) {
  return typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
}

const englishEntries = readPinnedSource('English');
const koreanEntries = readPinnedSource('Korean');
const koreanByEntry = groupBy(koreanEntries, (entry) => entryIdentity(entry.ids ?? []));
const candidates = [];
const conflicts = [];
const unmatched = [];

for (const englishEntry of englishEntries) {
  const ids = englishEntry.ids ?? [];
  const entryKey = entryIdentity(ids);
  const koreanMatches = koreanByEntry.get(entryKey) ?? [];
  if (ids.length === 0 || koreanMatches.length !== 1) {
    unmatched.push({
      ids,
      reason: ids.length === 0 ? 'English entry has no stat IDs' : `Expected one Korean entry for stat IDs, found ${koreanMatches.length}`,
    });
    continue;
  }

  const englishByVariant = groupBy(englishEntry.English ?? [], variantIdentity);
  const koreanByVariant = groupBy(koreanMatches[0].Korean ?? [], variantIdentity);
  const variantKeys = new Set([...englishByVariant.keys(), ...koreanByVariant.keys()]);

  for (const variantKey of variantKeys) {
    const englishVariants = englishByVariant.get(variantKey) ?? [];
    const koreanVariants = koreanByVariant.get(variantKey) ?? [];
    const variantHash = sha256Text(variantKey);

    if (englishVariants.length !== 1 || koreanVariants.length !== 1) {
      const record = {
        ids,
        variantIdentity: variantHash,
        englishVariantCount: englishVariants.length,
        koreanVariantCount: koreanVariants.length,
        reason: 'Variant structure is absent or non-unique in a language',
      };
      if (englishVariants.length > 1 || koreanVariants.length > 1) conflicts.push(record);
      else unmatched.push(record);
      continue;
    }

    const englishVariant = englishVariants[0];
    const koreanVariant = koreanVariants[0];
    for (const kind of ['string', 'reminder_text']) {
      const english = normalizeText(englishVariant[kind]);
      const korean = normalizeText(koreanVariant[kind]);
      if (!english && !korean) continue;
      if (!english || !korean) {
        unmatched.push({ ids, variantIdentity: variantHash, kind, english: english || null, korean: korean || null, reason: 'Text exists in only one language' });
        continue;
      }
      if (!placeholdersMatch(english, korean)) {
        unmatched.push({ ids, variantIdentity: variantHash, kind, english, korean, reason: 'Numbered placeholder multiset differs' });
        continue;
      }
      candidates.push({ ids, variantIdentity: variantHash, kind, english, korean });
    }
  }
}

const candidatesByEnglish = groupBy(candidates, (row) => row.english);
const accepted = [];
for (const rows of candidatesByEnglish.values()) {
  const koreanValues = new Set(rows.map((row) => row.korean));
  if (koreanValues.size === 1) {
    accepted.push(...rows);
  } else {
    for (const row of rows) {
      conflicts.push({ ...row, koreanCandidates: [...koreanValues].sort(), reason: 'One English template maps to multiple official Korean templates' });
    }
  }
}

accepted.sort((a, b) => a.english.localeCompare(b.english) || entryIdentity(a.ids).localeCompare(entryIdentity(b.ids)) || a.kind.localeCompare(b.kind));
conflicts.sort((a, b) => entryIdentity(a.ids ?? []).localeCompare(entryIdentity(b.ids ?? [])) || String(a.variantIdentity ?? '').localeCompare(String(b.variantIdentity ?? '')));
unmatched.sort((a, b) => entryIdentity(a.ids ?? []).localeCompare(entryIdentity(b.ids ?? [])) || String(a.variantIdentity ?? '').localeCompare(String(b.variantIdentity ?? '')));

const clientLogPath = 'C:\\Daum Games\\Path of Exile\\logs\\KakaoClient.txt';
const clientLog = readFileSync(clientLogPath, 'utf8');
const clientMatches = [...clientLog.matchAll(/\/patch\/([^/\r\n]+)\//g)];
const detectedPatch = clientMatches.at(-1)?.[1] ?? null;
const englishVariantCount = englishEntries.reduce((count, entry) => count + (entry.English?.length ?? 0), 0);
const koreanVariantCount = koreanEntries.reduce((count, entry) => count + (entry.Korean?.length ?? 0), 0);

const manifest = {
  source: 'RePoE structured export of official Path of Exile stat-description files',
  patch: sources.patch,
  identity: 'ordered stat ids + condition/format/index_handlers',
  sources: {
    english: sources.english,
    korean: sources.korean,
  },
  clientEvidence: {
    log: clientLogPath,
    detectedPatch,
    matchesExportPatch: detectedPatch === sources.patch,
  },
  inputs: {
    englishEntries: englishEntries.length,
    koreanEntries: koreanEntries.length,
    englishVariants: englishVariantCount,
    koreanVariants: koreanVariantCount,
  },
  counts: {
    accepted: accepted.length,
    conflicts: conflicts.length,
    unmatched: unmatched.length,
  },
  generatedAtUtc: new Date().toISOString(),
};

mkdirSync(reportRoot, { recursive: true });
const reports = {
  'manifest.json': manifest,
  'accepted.json': { patch: sources.patch, identity: manifest.identity, rows: accepted },
  'conflicts.json': { patch: sources.patch, rows: conflicts },
  'unmatched.json': { patch: sources.patch, rows: unmatched },
};
for (const [name, value] of Object.entries(reports)) {
  writeFileSync(join(reportRoot, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

console.log(`Stat descriptions: ${accepted.length} accepted, ${conflicts.length} conflicts, ${unmatched.length} unmatched.`);
