import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const toolRoot = dirname(scriptPath);
const projectRoot = dirname(dirname(toolRoot));
const sourceRoot = join(toolRoot, 'names');
const reportRoot = join(projectRoot, 'reports', 'official-terms', 'mod-names');
const sources = JSON.parse(readFileSync(join(sourceRoot, 'mod-sources.json'), 'utf8'));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function readPinnedSource(language) {
  const metadata = sources[language.toLowerCase()];
  const path = join(sourceRoot, metadata.file);
  const buffer = readFileSync(path);
  if (buffer.length !== metadata.bytes || sha256(buffer) !== metadata.sha256) {
    throw new Error(`${language} mod source failed its pinned size/hash check`);
  }
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${language} mod source must be a JSON object keyed by mod ID`);
  }
  return parsed;
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

const englishById = readPinnedSource('English');
const koreanById = readPinnedSource('Korean');
const allIds = [...new Set([...Object.keys(englishById), ...Object.keys(koreanById)])].sort();
const candidates = [];
const conflicts = [];
const unmatched = [];

for (const id of allIds) {
  const englishEntry = englishById[id];
  const koreanEntry = koreanById[id];
  if (!englishEntry || !koreanEntry) {
    unmatched.push({ id, reason: 'Mod ID exists in only one language' });
    continue;
  }
  const english = normalizedText(englishEntry.name);
  const korean = normalizedText(koreanEntry.name);
  if (!english || !korean) {
    unmatched.push({ id, english: english || null, korean: korean || null, reason: 'Official mod name is empty in one or both languages' });
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
        reason: 'One English mod name maps to multiple official Korean names',
      });
    }
  }
}

accepted.sort((a, b) => a.english.localeCompare(b.english) || a.id.localeCompare(b.id));
conflicts.sort((a, b) => a.english.localeCompare(b.english) || a.id.localeCompare(b.id));
unmatched.sort((a, b) => a.id.localeCompare(b.id));

const clientLogPath = 'C:\\Daum Games\\Path of Exile\\logs\\KakaoClient.txt';
const clientLog = readFileSync(clientLogPath, 'utf8');
const clientMatches = [...clientLog.matchAll(/\/patch\/([^/\r\n]+)\//g)];
const detectedPatch = clientMatches.at(-1)?.[1] ?? null;
const manifest = {
  source: 'RePoE structured export of official Path of Exile mod data',
  patch: sources.patch,
  identity: 'mod id',
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
    englishEntries: Object.keys(englishById).length,
    koreanEntries: Object.keys(koreanById).length,
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

console.log(`Mod names: ${accepted.length} accepted, ${conflicts.length} conflicts, ${unmatched.length} unmatched.`);
