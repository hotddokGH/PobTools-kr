import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const toolRoot = dirname(scriptPath);
const projectRoot = dirname(dirname(toolRoot));
const acceptedPath = join(projectRoot, 'reports', 'official-terms', 'stat-descriptions', 'accepted.json');
const referencePath = join(projectRoot, 'Data', 'poe1', 'zh-rTW', 'stats.json');
const targetPath = join(projectRoot, 'Data', 'poe1', 'ko-KR', 'stats.json');

const acceptedReport = JSON.parse(readFileSync(acceptedPath, 'utf8'));
const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
const officialByEnglish = new Map();

for (const row of acceptedReport.rows) {
  if (officialByEnglish.has(row.english) && officialByEnglish.get(row.english) !== row.korean) {
    throw new Error(`Refusing to apply ambiguous official stat mapping for ${JSON.stringify(row.english)}`);
  }
  officialByEnglish.set(row.english, row.korean);
}

const entries = {};
for (const key of Object.keys(reference.entries)) {
  if (officialByEnglish.has(key)) entries[key] = officialByEnglish.get(key);
}

const output = {
  source_files: [
    `official PoE patch ${acceptedReport.patch}: RePoE English stat_translations.min.json`,
    `official PoE patch ${acceptedReport.patch}: RePoE Korean stat_translations.min.json`,
  ],
  is_base_items: false,
  entries,
};

writeFileSync(targetPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`stats.json: wrote ${Object.keys(entries).length} exact official stat templates.`);
