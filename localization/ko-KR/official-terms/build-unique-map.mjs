import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const toolRoot = dirname(scriptPath);
const projectRoot = dirname(dirname(toolRoot));
const sourceRoot = join(toolRoot, 'names');
const reportRoot = join(projectRoot, 'reports', 'official-terms', 'unique-items');
const sources = JSON.parse(readFileSync(join(sourceRoot, 'sources.json'), 'utf8'));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function readPinnedSource(language) {
  const metadata = sources[language.toLowerCase()];
  const path = join(sourceRoot, metadata.file);
  const buffer = readFileSync(path);
  if (buffer.length !== metadata.bytes || sha256(buffer) !== metadata.sha256) {
    throw new Error(`${language} unique-item source failed its pinned size/hash check`);
  }
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${language} unique-item source must be a JSON object`);
  }
  return Object.values(parsed);
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

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const englishEntries = readPinnedSource('English');
const koreanEntries = readPinnedSource('Korean');
const englishById = groupBy(englishEntries, (entry) => normalizedText(entry.id));
const koreanById = groupBy(koreanEntries, (entry) => normalizedText(entry.id));
const allIds = [...new Set([...englishById.keys(), ...koreanById.keys()])].sort();
const candidates = [];
const conflicts = [];
const unmatched = [];

for (const id of allIds) {
  const englishMatches = englishById.get(id) ?? [];
  const koreanMatches = koreanById.get(id) ?? [];

  if (!id || englishMatches.length === 0 || koreanMatches.length === 0) {
    unmatched.push({
      id: id || null,
      englishCount: englishMatches.length,
      koreanCount: koreanMatches.length,
      reason: !id ? 'Entry has an empty unique item id' : 'Unique item id exists in only one language',
    });
    continue;
  }

  if (englishMatches.length !== 1 || koreanMatches.length !== 1) {
    conflicts.push({
      id,
      englishCount: englishMatches.length,
      koreanCount: koreanMatches.length,
      englishNames: [...new Set(englishMatches.map((entry) => normalizedText(entry.name)).filter(Boolean))].sort(),
      koreanNames: [...new Set(koreanMatches.map((entry) => normalizedText(entry.name)).filter(Boolean))].sort(),
      reason: 'Unique item id is not unique in both language exports',
    });
    continue;
  }

  const english = normalizedText(englishMatches[0].name);
  const korean = normalizedText(koreanMatches[0].name);
  if (!english || !korean) {
    unmatched.push({ id, english: english || null, korean: korean || null, reason: 'Official name is empty in one or both languages' });
    continue;
  }
  candidates.push({ id, english, korean });
}

const candidatesByEnglish = groupBy(candidates, (row) => row.english);
const accepted = [];
for (const rows of candidatesByEnglish.values()) {
  const koreanNames = [...new Set(rows.map((row) => row.korean))].sort();
  if (koreanNames.length === 1) {
    accepted.push(...rows);
  } else {
    for (const row of rows) {
      conflicts.push({
        ...row,
        koreanCandidates: koreanNames,
        reason: 'One English unique name maps to multiple official Korean names',
      });
    }
  }
}

accepted.sort((a, b) => a.english.localeCompare(b.english) || a.id.localeCompare(b.id));
conflicts.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')) || String(a.english ?? '').localeCompare(String(b.english ?? '')));
unmatched.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));

const clientLogPath = 'C:\\Daum Games\\Path of Exile\\logs\\KakaoClient.txt';
const clientLog = readFileSync(clientLogPath, 'utf8');
const clientMatches = [...clientLog.matchAll(/\/patch\/([^/\r\n]+)\//g)];
const detectedPatch = clientMatches.at(-1)?.[1] ?? null;
const manifest = {
  source: 'RePoE structured export of official Path of Exile unique item data',
  patch: sources.patch,
  identity: 'unique item id',
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

console.log(`Unique items: ${accepted.length} accepted, ${conflicts.length} conflicts, ${unmatched.length} unmatched.`);
