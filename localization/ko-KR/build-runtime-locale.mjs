import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSignature } from './lib/format-signature.mjs';
import { mergeLayers, reflowLineBreaks } from './lib/merge-layers.mjs';

const localeRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(localeRoot));
const runtimeRoot = join(repositoryRoot, 'pob-zh-engine', 'dist');
const referenceRoot = join(runtimeRoot, 'Data', 'poe1', 'zh-rTW');
const targetRoot = join(runtimeRoot, 'Data', 'poe1', 'ko-KR');
const reportRoot = join(repositoryRoot, 'reports', 'official-terms');
const provenancePath = join(repositoryRoot, 'reports', 'display-closure', 'provenance.json');
const patch = '3.29.3.2';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function officialIdentity(reportName, row) {
  if (row.id) return `${reportName}:${row.id}`;
  if (Array.isArray(row.ids)) {
    return `${reportName}:${row.ids.join(',')}#${row.variantIdentity ?? 'no-variant'}`;
  }
  return reportName;
}

function collectCandidates(namedReports) {
  const candidates = new Map();
  for (const { name, report } of namedReports) {
    if (report.patch !== patch) throw new Error(`unexpected official patch in ${name}: ${report.patch}`);
    for (const row of report.rows) {
      if (!candidates.has(row.english)) candidates.set(row.english, new Map());
      const values = candidates.get(row.english);
      if (!values.has(row.korean)) values.set(row.korean, new Set());
      values.get(row.korean).add(officialIdentity(name, row));
    }
  }

  const exact = {};
  const conflicts = [];
  for (const english of [...candidates.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    const values = candidates.get(english);
    if (values.size > 1) {
      conflicts.push({ english, korean: [...values.keys()].sort((left, right) => left.localeCompare(right, 'ko')) });
      continue;
    }
    const [[value, sources]] = values;
    exact[english] = {
      value,
      source: [...sources].sort((left, right) => left.localeCompare(right, 'en')).join(' | '),
      patch,
    };
  }
  return { exact, conflicts };
}

function addFallback(primary, fallback) {
  const exact = { ...primary.exact };
  for (const key of Object.keys(fallback.exact)) {
    if (!Object.hasOwn(exact, key)) exact[key] = fallback.exact[key];
  }
  return { exact, conflicts: [...primary.conflicts, ...fallback.conflicts] };
}

function sameFormat(left, right) {
  return JSON.stringify(formatSignature(left)) === JSON.stringify(formatSignature(right));
}

const reports = {
  baseItems: { name: 'BaseItemTypes', report: readJson(join(reportRoot, 'accepted.json')) },
  activeSkills: { name: 'ActiveSkills', report: readJson(join(reportRoot, 'tables', 'ActiveSkills', 'accepted.json')) },
  passiveSkills: { name: 'PassiveSkills', report: readJson(join(reportRoot, 'tables', 'PassiveSkills', 'accepted.json')) },
  monsters: { name: 'MonsterVarieties', report: readJson(join(reportRoot, 'tables', 'MonsterVarieties', 'accepted.json')) },
  clientStrings: { name: 'ClientStrings', report: readJson(join(reportRoot, 'tables', 'ClientStrings', 'accepted.json')) },
  clientStrings2: { name: 'ClientStrings2', report: readJson(join(reportRoot, 'tables', 'ClientStrings2', 'accepted.json')) },
  stats: { name: 'stat-descriptions', report: readJson(join(reportRoot, 'stat-descriptions', 'accepted.json')) },
  uniques: { name: 'unique-items', report: readJson(join(reportRoot, 'unique-items', 'accepted.json')) },
  modNames: { name: 'mod-names', report: readJson(join(reportRoot, 'mod-names', 'accepted.json')) },
};

const direct = {
  baseItems: collectCandidates([reports.baseItems]),
  activeAndItems: collectCandidates([reports.activeSkills, reports.baseItems]),
  passives: collectCandidates([reports.passiveSkills]),
  monsters: collectCandidates([reports.monsters]),
  stats: collectCandidates([reports.stats]),
  uniques: collectCandidates([reports.uniques]),
  modNames: collectCandidates([reports.modNames]),
  passiveSupplement: collectCandidates([reports.stats, reports.clientStrings, reports.clientStrings2]),
  uiPrimary: collectCandidates([reports.clientStrings, reports.clientStrings2, reports.stats]),
  uiSupplement: collectCandidates([
    reports.baseItems,
    reports.activeSkills,
    reports.passiveSkills,
    reports.monsters,
    reports.uniques,
    reports.modNames,
  ]),
};

const officialByDictionary = {
  tags: direct.modNames,
  items: direct.baseItems,
  gems: direct.activeAndItems,
  ui: addFallback(direct.uiPrimary, direct.uiSupplement),
  stats: direct.stats,
  passives: addFallback(direct.passives, direct.passiveSupplement),
  uniques: direct.uniques,
  monsters: direct.monsters,
};

const manualDocument = readJson(join(localeRoot, 'manual', 'pob-ui.json'));
const dynamicDocument = readJson(join(localeRoot, 'manual', 'dynamic-patterns.json'));
const policy = readJson(join(localeRoot, 'display-policy.json'));
if (dynamicDocument.patch !== patch) throw new Error(`unexpected dynamic pattern patch: ${dynamicDocument.patch}`);

const sourceFiles = {
  tags: [`official PoE patch ${patch}: RePoE English/Korean mods.min.json`],
  items: [`official PoE patch ${patch}: English/Korean BaseItemTypes.datc64`],
  gems: [`official PoE patch ${patch}: English/Korean ActiveSkills.datc64 and BaseItemTypes.datc64`],
  ui: [`official PoE patch ${patch}: client strings, stat descriptions and exact game names`, 'manual PoB-only UI: localization/ko-KR/manual/pob-ui.json'],
  stats: [`official PoE patch ${patch}: RePoE English/Korean stat_translations.min.json`],
  passives: [`official PoE patch ${patch}: passive names, client strings and stat descriptions`],
  uniques: [`official PoE patch ${patch}: RePoE English/Korean uniques.min.json`],
  monsters: [`official PoE patch ${patch}: English/Korean MonsterVarieties.datc64`],
};

mkdirSync(targetRoot, { recursive: true });
mkdirSync(dirname(provenancePath), { recursive: true });

const provenance = {
  locale: 'ko-KR',
  patch,
  precedence: ['official-exact', 'official-structural-pattern', 'manual-pob-ui', 'intentional-literal'],
  dictionaries: {},
  conflicts: {},
};

for (const dictionary of ['tags', 'items', 'gems', 'ui', 'stats', 'passives', 'uniques', 'monsters']) {
  const referenceDocument = readJson(join(referenceRoot, `${dictionary}.json`));
  const official = officialByDictionary[dictionary];
  const patterns = dynamicDocument.patterns.filter((entry) => (entry.dictionary ?? 'stats') === dictionary);
  const correctedSources = new Set(patterns.map((entry) => entry.source));
  const officialExact = {};
  const uncorrectedFormatMismatches = [];

  for (const [key, record] of Object.entries(official.exact)) {
    if (correctedSources.has(key)) {
      continue;
    }
    if (sameFormat(key, record.value)) {
      officialExact[key] = record;
    } else {
      const reflowedValue = reflowLineBreaks(key, record.value);
      if (sameFormat(key, reflowedValue)) {
        officialExact[key] = { ...record, value: reflowedValue, formatting: 'source-linebreak-count' };
      } else {
      uncorrectedFormatMismatches.push(key);
      }
    }
  }
  if (uncorrectedFormatMismatches.length > 0) {
    throw new Error(
      `official format mismatch without reviewed correction: ${dictionary} (${uncorrectedFormatMismatches.length})\n`
      + uncorrectedFormatMismatches.join('\n---\n'),
    );
  }

  const result = mergeLayers({
    dictionary,
    reference: referenceDocument.entries,
    officialExact,
    officialPatterns: patterns,
    manual: dictionary === 'ui' ? manualDocument.entries : {},
    literals: policy.literalAllowlist?.[dictionary] ?? {},
  });

  const output = {
    source_files: sourceFiles[dictionary],
    is_base_items: dictionary === 'items',
    entries: result.entries,
  };
  writeFileSync(join(targetRoot, `${dictionary}.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  provenance.dictionaries[dictionary] = result.provenance;
  provenance.conflicts[dictionary] = official.conflicts;
  console.log(`${dictionary}.json: ${Object.keys(result.entries).length}/${Object.keys(referenceDocument.entries).length}`);
}

writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
console.log(`provenance: ${provenancePath}`);
