import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const toolRoot = dirname(scriptPath);
const projectRoot = dirname(dirname(toolRoot));
const officialReportRoot = join(projectRoot, 'reports', 'official-terms');
const reportRoot = join(officialReportRoot, 'tables');
const referencePath = join(projectRoot, 'Data', 'poe1', 'zh-rTW', 'ui.json');
const targetPath = join(projectRoot, 'Data', 'poe1', 'ko-KR', 'ui.json');
const manualPath = join(toolRoot, 'manual-pob-ui.json');

const reports = ['ClientStrings', 'ClientStrings2'].map((table) => ({
  table,
  report: JSON.parse(readFileSync(join(reportRoot, table, 'accepted.json'), 'utf8')),
}));
reports.push({
  table: 'stat-descriptions',
  report: JSON.parse(readFileSync(join(officialReportRoot, 'stat-descriptions', 'accepted.json'), 'utf8')),
});
const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
const manual = JSON.parse(readFileSync(manualPath, 'utf8'));

const candidates = new Map();
for (const { report } of reports) {
  for (const row of report.rows) {
    if (!candidates.has(row.english)) candidates.set(row.english, new Set());
    candidates.get(row.english).add(row.korean);
  }
}

const safeOfficial = new Map();
for (const [english, koreanValues] of candidates) {
  if (koreanValues.size === 1) safeOfficial.set(english, [...koreanValues][0]);
}

const supplementReports = [
  join(officialReportRoot, 'accepted.json'),
  join(reportRoot, 'ActiveSkills', 'accepted.json'),
  join(reportRoot, 'PassiveSkills', 'accepted.json'),
  join(reportRoot, 'MonsterVarieties', 'accepted.json'),
  join(officialReportRoot, 'unique-items', 'accepted.json'),
  join(officialReportRoot, 'mod-names', 'accepted.json'),
].map((path) => JSON.parse(readFileSync(path, 'utf8')));
const supplementCandidates = new Map();
for (const report of supplementReports) {
  for (const row of report.rows) {
    if (!supplementCandidates.has(row.english)) supplementCandidates.set(row.english, new Set());
    supplementCandidates.get(row.english).add(row.korean);
  }
}
for (const [english, koreanValues] of supplementCandidates) {
  if (koreanValues.size === 1 && !safeOfficial.has(english)) {
    safeOfficial.set(english, [...koreanValues][0]);
  }
}

const entries = {};
for (const key of Object.keys(reference.entries)) {
  if (safeOfficial.has(key)) entries[key] = safeOfficial.get(key);
}
for (const [key, value] of Object.entries(manual.entries)) {
  entries[key] = value;
}

const output = {
  source_files: [
    'official PoE patch 3.29.3.2: Data/ClientStrings.datc64 (Text)',
    'official PoE patch 3.29.3.2: Data/Korean/ClientStrings.datc64 (Text)',
    'official PoE patch 3.29.3.2: Data/ClientStrings2.datc64 (Text)',
    'official PoE patch 3.29.3.2: Data/Korean/ClientStrings2.datc64 (Text)',
    'official PoE patch 3.29.3.2: RePoE English stat_translations.min.json',
    'official PoE patch 3.29.3.2: RePoE Korean stat_translations.min.json',
    'official PoE patch 3.29.3.2: exact base item, skill, passive, monster, unique, and mod names',
    'manual PobTools-only UI: tools/official-terms/manual-pob-ui.json',
  ],
  is_base_items: false,
  entries,
};

writeFileSync(targetPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`ui.json: wrote ${Object.keys(entries).length} official-plus-manual UI mappings.`);
