import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSignature } from './lib/format-signature.mjs';
import { mergeLayers, reflowLineBreaks } from './lib/merge-layers.mjs';
import { deriveUnambiguousPatterns } from './lib/official-patterns.mjs';
import { buildKoreanItemMetadata } from './lib/item-metadata.mjs';

const localeRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(localeRoot));

function parseArguments(argv) {
  const values = new Map();
  const accepted = new Set(['--engine-root', '--report-root']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!accepted.has(name) || value === undefined || values.has(name)) throw new Error(`invalid argument: ${name ?? '<missing>'}`);
    values.set(name, resolve(value));
  }
  return {
    engineRoot: values.get('--engine-root') ?? join(repositoryRoot, 'pob-zh-engine'),
    reportRoot: values.get('--report-root') ?? join(repositoryRoot, 'reports'),
  };
}

const arguments_ = parseArguments(process.argv.slice(2));
const runtimeRoot = join(arguments_.engineRoot, 'dist');
const referenceRoot = join(runtimeRoot, 'Data', 'poe1', 'zh-rTW');
const targetRoot = join(runtimeRoot, 'Data', 'poe1', 'ko-KR');
const reportRoot = join(arguments_.reportRoot, 'official-terms');
const provenancePath = join(arguments_.reportRoot, 'display-closure', 'provenance.json');
const patch = '3.29.3.2';
const dictionaries = ['tags', 'items', 'gems', 'ui', 'stats', 'passives', 'uniques', 'monsters'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateRuntimeMeta(meta) {
  const expectedKeys = [
    'display_name',
    'glossary_blacklist',
    'incomplete_translation_whitelist',
    'load_order',
    'locale',
    'source',
    'version',
  ];
  const actualKeys = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? Object.keys(meta).sort()
    : [];
  const validStringList = (values) => Array.isArray(values)
    && values.every((value) => typeof value === 'string' && value.trim() && values.indexOf(value) === values.lastIndexOf(value));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
      || meta.version !== '0.1.0'
      || meta.locale !== 'ko-KR'
      || typeof meta.display_name !== 'string'
      || !meta.display_name.trim()
      || meta.source !== 'poe1'
      || JSON.stringify(meta.load_order) !== JSON.stringify(dictionaries.map((name) => `${name}.json`))
      || !validStringList(meta.incomplete_translation_whitelist)
      || !validStringList(meta.glossary_blacklist)) {
    throw new Error('invalid trusted Korean runtime metadata');
  }
}

const runtimeMetaBytes = readFileSync(join(localeRoot, 'runtime-meta.json'));
validateRuntimeMeta(JSON.parse(runtimeMetaBytes.toString('utf8')));

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
const machineDocument = readJson(join(localeRoot, 'manual', 'machine-fallback.json'));
const machineOverrides = readJson(join(localeRoot, 'manual', 'machine-fallback-overrides.json'));
const runtimeInventory = readJson(join(localeRoot, 'runtime-inventory.json'));
const dynamicDocument = readJson(join(localeRoot, 'manual', 'dynamic-patterns.json'));
const policy = readJson(join(localeRoot, 'display-policy.json'));
if (dynamicDocument.patch !== patch) throw new Error(`unexpected dynamic pattern patch: ${dynamicDocument.patch}`);
if (machineDocument.inventorySha256 !== runtimeInventory.sha256) {
  throw new Error('machine fallback inventory hash does not match current runtime inventory');
}
const unresolvedMachineRows = runtimeInventory.entries.filter((key) => (
  !Object.hasOwn(machineDocument.entries, key) && !Object.hasOwn(machineOverrides.entries, key)
));
if (unresolvedMachineRows.length > 0) {
  throw new Error(`runtime machine fallback has ${unresolvedMachineRows.length} unresolved rows`);
}
const derivedOfficialPatterns = deriveUnambiguousPatterns({ rows: reports.stats.report.rows, patch });
const officialStatDictionaries = new Set(dynamicDocument.officialStatDictionaries ?? []);

const sourceFiles = {
  tags: [`official PoE patch ${patch}: RePoE English/Korean mods.min.json`],
  items: [`official PoE patch ${patch}: English/Korean BaseItemTypes.datc64`],
  gems: [`official PoE patch ${patch}: English/Korean ActiveSkills.datc64 and BaseItemTypes.datc64`],
  ui: [
    `official PoE patch ${patch}: client strings, stat descriptions and exact game names`,
    'manual PoB-only UI: localization/ko-KR/manual/pob-ui.json',
    'machine-assisted PoB-only UI fallback: Helsinki-NLP/opus-mt-tc-big-en-ko (CC-BY-4.0)',
  ],
  stats: [`official PoE patch ${patch}: RePoE English/Korean stat_translations.min.json`],
  passives: [`official PoE patch ${patch}: passive names, client strings and stat descriptions`],
  uniques: [`official PoE patch ${patch}: RePoE English/Korean uniques.min.json`],
  monsters: [`official PoE patch ${patch}: English/Korean MonsterVarieties.datc64`],
};

mkdirSync(targetRoot, { recursive: true });
mkdirSync(dirname(provenancePath), { recursive: true });
writeFileSync(join(targetRoot, 'meta.json'), runtimeMetaBytes);

const provenance = {
  locale: 'ko-KR',
  patch,
  precedence: [
    'official-exact',
    'official-structural-pattern',
    'manual-pob-ui',
    'reviewed-machine-override',
    'machine-assisted-pob-ui',
    'intentional-literal',
  ],
  dictionaries: {},
  conflicts: {},
  structuralConflicts: derivedOfficialPatterns.conflicts,
};

for (const dictionary of dictionaries) {
  const referenceDocument = readJson(join(referenceRoot, `${dictionary}.json`));
  const referenceEntries = { ...referenceDocument.entries };
  if (dictionary === 'ui') {
    for (const key of runtimeInventory.entries) referenceEntries[key] = true;
  }
  const official = officialByDictionary[dictionary];
  const reviewedPatterns = dynamicDocument.patterns.filter((entry) => (entry.dictionary ?? 'stats') === dictionary);
  const correctedSources = new Set(reviewedPatterns.map((entry) => entry.source));
  const patterns = officialStatDictionaries.has(dictionary)
    ? [
      ...reviewedPatterns,
      ...derivedOfficialPatterns.patterns.filter((entry) => !correctedSources.has(entry.source)),
    ]
    : reviewedPatterns;
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
    reference: referenceEntries,
    officialExact,
    officialPatterns: patterns,
    fallbackLayers: dictionary === 'ui' ? [
      { layer: 'manual-pob-ui', source: 'manual/pob-ui.json', entries: manualDocument.entries },
      {
        layer: 'reviewed-machine-override',
        source: 'manual/machine-fallback-overrides.json',
        entries: machineOverrides.entries,
      },
      {
        layer: 'machine-assisted-pob-ui',
        source: 'manual/machine-fallback.json',
        entries: machineDocument.entries,
      },
    ] : [],
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
  console.log(`${dictionary}.json: ${Object.keys(result.entries).length}/${Object.keys(referenceEntries).length}`);
}

writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
console.log(`provenance: ${provenancePath}`);

const metadataManualTerms = {
  'Added Small Passive Skills also grant: ': '추가된 소형 패시브 스킬이 부여하는 효과: ',
  Amulets: '목걸이',
  Belts: '허리띠',
  'Body Armours': '갑옷',
  Bows: '활',
  Claws: '클로',
  'Corruption Implicit': '타락 고정 속성',
  Daggers: '단검',
  'Eater of Worlds Implicit': '세계 포식자 고정 속성',
  'Evasion and Armour': '회피 및 방어도',
  'Fishing Rods': '낚싯대',
  Foil: '포일',
  Fractured: '분열',
  Helmets: '투구',
  Implicit: '고정 속성',
  Large: '큼',
  'Mana Multiplier': '마나 배율',
  'Mana Reserved': '마나 점유',
  'Master Crafted': '대가 제작',
  'One Hand Axes': '한손 도끼',
  'One Hand Maces': '한손 철퇴',
  'One Hand Swords': '한손 검',
  Quivers: '화살통',
  Rings: '반지',
  Sceptres: '셉터',
  'Searing Exarch Implicit': '작열의 총주교 고정 속성',
  Shields: '방패',
  Small: '작음',
  Staves: '지팡이',
  'Thrusting One Hand Swords': '찌르기용 한손 검',
  'Two Hand Axes': '양손 도끼',
  'Two Hand Maces': '양손 철퇴',
  'Two Hand Swords': '양손 검',
  'Vestigial Implicit': '잔존 고정 속성',
  Wands: '마법봉',
};
const metadataManualAffixes = {
  "Assassin's": '암살자의',
  "Champion's": '챔피언의',
  Charging: '돌진하는',
  Chosen: '선택받은',
  "Gladiator's": '글래디에이터의',
  Infernal: '지옥불의',
  Lingering: '지속되는',
  "Raider's": '레이더의',
  Rejuvenating: '활력을 되찾는',
  Sapphire: '사파이어의',
  Vampiric: '흡혈의',
  Wasting: '쇠약하게 하는',
  'of Torment': '고통의',
  'of the Gladiator': '글래디에이터의',
  'of the Guardian': '가디언의',
  'of the Inquisitor': '인퀴지터의',
  'of the Raider': '레이더의',
  'of the Saboteur': '사보추어의',
  'of the Seal': '봉인의',
  'of the Slayer': '슬레이어의',
};
const metadataTerms = {};
for (const dictionary of ['ui', 'items', 'gems', 'stats', 'passives', 'uniques', 'monsters', 'tags']) {
  Object.assign(metadataTerms, readJson(join(targetRoot, `${dictionary}.json`)).entries);
}
const metadataModNames = Object.fromEntries(Object.entries(direct.modNames.exact).map(
  ([english, record]) => [english, record.value],
));
const metadataResult = buildKoreanItemMetadata({
  reference: readJson(join(referenceRoot, 'item_metadata.json')),
  exactTerms: metadataTerms,
  exactModNames: metadataModNames,
  manualTerms: metadataManualTerms,
  manualAffixes: metadataManualAffixes,
  skipPatterns: ['우클릭', '좌클릭'],
});
if (metadataResult.unresolved.length > 0) {
  throw new Error(`Korean item metadata has unresolved terms:\n${metadataResult.unresolved.join('\n')}`);
}
writeFileSync(join(targetRoot, 'item_metadata.json'), `${JSON.stringify(metadataResult.document, null, 2)}\n`, 'utf8');
writeFileSync(join(reportRoot, 'item-metadata.json'), `${JSON.stringify({
  patch,
  affixes: Object.keys(metadataResult.document.affix_names).length,
  collisions: metadataResult.collisions,
}, null, 2)}\n`, 'utf8');
console.log(`item_metadata.json: ${Object.keys(metadataResult.document.affix_names).length} affixes; ${metadataResult.collisions.length} collisions`);
