import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(scriptRoot));
const dataRoot = join(repositoryRoot, 'pob-zh-engine', 'host', 'data');
const localeRoot = join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR');
const customOfficialRoot = join(scriptRoot, 'official-terms', 'custom-data');
const manualRoot = join(scriptRoot, 'manual');
const reportRoot = join(repositoryRoot, 'reports', 'official-terms');
const han = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value, indent = 0) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`, 'utf8');
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function withKoreanProvenance(source, marker) {
  const parts = String(source ?? '')
    .split('; ')
    .filter((part) => !/^Korean (?:names|text): official RePoE /u.test(part));
  parts.push(marker);
  return parts.filter(Boolean).join('; ');
}

function readPinnedSources() {
  const manifest = readJson(join(customOfficialRoot, 'sources.json'));
  const result = {};
  for (const [name, metadata] of Object.entries(manifest.files)) {
    const buffer = readFileSync(join(customOfficialRoot, name));
    if (buffer.length !== metadata.bytes || sha256(buffer) !== metadata.sha256) {
      throw new Error(`${name} failed its pinned size/hash check`);
    }
    result[name] = name.endsWith('.json') ? JSON.parse(buffer.toString('utf8')) : buffer.toString('utf8').trim();
  }
  if (result['version.txt'] !== manifest.patch) throw new Error('custom-data patch and version.txt differ');
  return { manifest, ...result };
}

function officialEnglishMap() {
  const provenance = readJson(join(repositoryRoot, 'reports', 'display-closure', 'provenance.json'));
  const output = new Map();
  for (const dictionary of ['tags', 'items', 'gems', 'ui', 'stats', 'passives', 'uniques', 'monsters']) {
    const entries = readJson(join(localeRoot, `${dictionary}.json`)).entries;
    const dictionaryProvenance = provenance.dictionaries[dictionary];
    for (const [english, korean] of Object.entries(entries)) {
      const layer = dictionaryProvenance[english]?.layer;
      if (layer === 'official-exact' || layer === 'official-structural-pattern') output.set(english, korean);
    }
  }
  return output;
}

function compileStatTemplates() {
  const rows = readJson(join(reportRoot, 'stat-descriptions', 'accepted.json')).rows;
  const unique = new Map();
  for (const row of rows) {
    if (row.kind !== 'string' || !row.english.includes('{')) continue;
    const previous = unique.get(row.english);
    if (previous && previous !== row.korean) continue;
    unique.set(row.english, row.korean);
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compiled = [];
  for (const [english, korean] of unique) {
    const occurrences = [...english.matchAll(/\{(\d+)\}/g)];
    let source = '^';
    let cursor = 0;
    for (const occurrence of occurrences) {
      // RePoE stat placeholders are numeric. Restrict captures accordingly so
      // a short UI label such as "Add Armour" cannot accidentally match a
      // structurally unrelated stat template containing {0}.
      source += `${escape(english.slice(cursor, occurrence.index))}([+\\-()0-9.,#]+?)`;
      cursor = occurrence.index + occurrence[0].length;
    }
    source += `${escape(english.slice(cursor))}$`;
    compiled.push({ english, korean, occurrences, regex: new RegExp(source, 'i') });
  }
  compiled.sort((a, b) => b.english.length - a.english.length);
  return compiled;
}

function renderOfficialStat(english, exact, templates) {
  if (exact.has(english)) return exact.get(english);
  for (const template of templates) {
    const match = template.regex.exec(english);
    if (!match) continue;
    const values = new Map();
    template.occurrences.forEach((occurrence, index) => {
      if (!values.has(occurrence[1])) values.set(occurrence[1], match[index + 1]);
    });
    return template.korean.replace(/\{(\d+)\}/g, (token, index) => values.get(index) ?? token);
  }
  return null;
}

function numberSignature(value) {
  return [...value.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => match[0]);
}

function signatureContains(haystack, needle) {
  const counts = new Map();
  for (const value of haystack) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of needle) {
    const remaining = counts.get(value) ?? 0;
    if (remaining === 0) return false;
    counts.set(value, remaining - 1);
  }
  return true;
}

function alignStats(englishLines, koreanLines) {
  if (!Array.isArray(englishLines) || !Array.isArray(koreanLines)) return new Map();
  const output = new Map();
  const used = new Set();
  const order = englishLines.map((_, index) => index)
    .sort((a, b) => numberSignature(englishLines[b]).length - numberSignature(englishLines[a]).length);
  for (const englishIndex of order) {
    const signature = numberSignature(englishLines[englishIndex]);
    let candidate = -1;
    let candidateExtra = Infinity;
    for (let koreanIndex = 0; koreanIndex < koreanLines.length; koreanIndex++) {
      if (used.has(koreanIndex)) continue;
      const koreanSignature = numberSignature(koreanLines[koreanIndex]);
      if (signature.length && !signatureContains(koreanSignature, signature)) continue;
      const extra = Math.abs(koreanSignature.length - signature.length);
      if (extra < candidateExtra) {
        candidate = koreanIndex;
        candidateExtra = extra;
      }
    }
    if (candidate >= 0) {
      output.set(englishLines[englishIndex], koreanLines[candidate]);
      used.add(candidate);
    }
  }
  return output;
}

function wildcardNumbers(value) {
  return value.replace(/\(?\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\)?/g, '#');
}

function wildcardSkeleton(value) {
  return wildcardNumbers(value)
    .replace(/\[[^\]|]+\|([^\]]+)\]/g, (_match, label) => label)
    .replace(/[+-](?=#)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const officialSources = readPinnedSources();
const englishBaseItems = officialSources['English.base_items.min.json'];
const koreanBaseItems = officialSources['Korean.base_items.min.json'];
const englishWorldAreas = officialSources['English.world_areas.min.json'];
const koreanWorldAreas = officialSources['Korean.world_areas.min.json'];
const koreanAtlas = officialSources['Korean.Atlas.min.json'];
const exact = officialEnglishMap();
const templates = compileStatTemplates();
const manual = readJson(join(manualRoot, 'custom-data-translations.json'));
const reviewed = readJson(join(manualRoot, 'custom-data-reviewed-overrides.json')).entries;
const englishMods = readJson(join(scriptRoot, 'official-terms', 'names', 'English.mods.min.json'));
const koreanMods = readJson(join(scriptRoot, 'official-terms', 'names', 'Korean.mods.min.json'));
const unresolved = new Map();
const counts = { official: 0, manual: 0, machine: 0 };

function resolve(english, chinese = '') {
  const official = exact.get(english) ?? renderOfficialStat(english, exact, templates);
  if (official) {
    counts.official++;
    return official;
  }
  const reviewedTarget = manual.entries[english] ?? reviewed[english] ?? reviewed[english.trim()];
  if (reviewedTarget) {
    counts.manual++;
    return reviewedTarget;
  }
  const notable = /^Notable (\d+)$/u.exec(english);
  if (notable) {
    counts.manual++;
    return `주요 패시브 ${notable[1]}`;
  }
  unresolved.set(english, chinese);
  return null;
}

function officialBasePair(id, englishName = '') {
  if (id && koreanBaseItems[id]) return [englishBaseItems[id], koreanBaseItems[id]];
  const match = Object.entries(englishBaseItems).find(([, value]) => value.name === englishName);
  return match ? [match[1], koreanBaseItems[match[0]]] : [null, null];
}

// Maps, astrolabes and scarabs all carry stable BaseItemTypes ids. RePoE's
// Korean base-item export supplies both the official name and description.
{
  const path = join(dataRoot, 'atlas_maps_poe1.json');
  const data = readJson(path);
  for (const map of data.maps) {
    const [, korean] = officialBasePair(`Metadata/Items/Maps/${map.id}`, map.enItem);
    const koreanName = korean?.name ?? exact.get(map.enItem);
    if (!koreanName) throw new Error(`No official Korean map name for ${map.id}`);
    map.zhItem = koreanName;
    map.zhArea = koreanName.replace(/ 지도$/u, '');
    counts.official += 2;
  }
  data.source = withKoreanProvenance(data.source, `Korean names: official RePoE ${officialSources.manifest.patch}`);
  writeJson(path, data, 1);
}

{
  const path = join(dataRoot, 'astrolabes_poe1.json');
  const data = readJson(path);
  for (const region of data.regions) {
    const match = Object.entries(englishWorldAreas).find(([, value]) => value.name === region.vaultEn);
    const korean = match ? koreanWorldAreas[match[0]] : null;
    if (!korean?.name) throw new Error(`No official Korean vault name for ${region.vaultEn}`);
    region.vaultZh = korean.name;
    counts.official++;
  }
  for (const item of data.astrolabes) {
    const [, korean] = officialBasePair(item.id, item.en);
    if (!korean?.name || !korean.properties?.description) throw new Error(`No official Korean astrolabe data for ${item.id}`);
    item.zh = korean.name;
    item.descZh = [korean.properties.description];
    counts.official += 2;
  }
  data.source = withKoreanProvenance(data.source, `Korean text: official RePoE ${officialSources.manifest.patch}`);
  writeJson(path, data, 1);
}

{
  const path = join(dataRoot, 'scarabs_poe1.json');
  const data = readJson(path);
  for (const item of data.scarabs) {
    const [, korean] = officialBasePair(item.id, item.en);
    if (!korean?.name || !korean.properties?.description) throw new Error(`No official Korean scarab data for ${item.id}`);
    item.zh = korean.name;
    item.descZh = [korean.properties.description];
    counts.official += 2;
  }
  data.source = withKoreanProvenance(data.source, `Korean text: official RePoE ${officialSources.manifest.patch}`);
  writeJson(path, data, 1);
}

// The regex catalogue uses mod ids. Match each generic '#' line to the same
// line in the official English mod, then take the corresponding Korean line.
{
  const path = join(dataRoot, 'regex_poe1.json');
  const data = readJson(path);
  for (const page of data.pages) {
    const labels = manual.regexPages[page.id];
    if (!labels) throw new Error(`No Korean page labels for ${page.id}`);
    page.title = labels.title;
    page.note = labels.note;
    page.groups = labels.groups;
    counts.manual += 2 + labels.groups.length;
    for (const entry of page.entries) {
      const englishMod = englishMods[entry.id];
      const koreanMod = koreanMods[entry.id];
      if (!englishMod || !koreanMod) throw new Error(`No official Korean mod pair for ${entry.id}`);
      const englishLines = String(englishMod.text ?? '').split('\n');
      const koreanLines = String(koreanMod.text ?? '').split('\n');
      entry.zh = entry.en.map((line) => {
        const index = englishLines.findIndex((candidate) => wildcardSkeleton(candidate) === wildcardSkeleton(line));
        if (index < 0 || !koreanLines[index]) throw new Error(`Cannot align official Korean mod line for ${entry.id}: ${line}`);
        counts.official++;
        return wildcardNumbers(koreanLines[index]);
      });
      entry.affixZh = koreanMod.name;
      counts.official++;
    }
  }
  data.source = withKoreanProvenance(data.source, `Korean text: official RePoE ${officialSources.manifest.patch}`);
  writeJson(path, data, 1);
}

// Build every installed season from the official Korean atlas. Older nodes that
// no longer exist in the active export use exact official dictionaries first,
// then the reviewed manual fallback file.
{
  const activeTree = readJson(join(dataRoot, 'atlas_versions', '3.29.1', 'atlas_tree_poe1.json'));
  const activeById = new Map(activeTree.nodes.map((node) => [String(node.id), node]));
  for (const version of readdirSync(join(dataRoot, 'atlas_versions'))) {
    const versionRoot = join(dataRoot, 'atlas_versions', version);
    const tree = readJson(join(versionRoot, 'atlas_tree_poe1.json'));
    const previous = readJson(join(versionRoot, 'atlas_tree_zh.json'));
    const previousById = previous.nodes ?? {};
    const nodes = {};
    let joined = 0;
    for (const node of tree.nodes) {
      if (!node.name) continue; // synthetic root; never rendered as a node label
      const key = String(node.id);
      const current = activeById.get(key);
      const officialNode = koreanAtlas.passives[key];
      const previousNode = previousById[key] ?? {};
      const sameCurrentName = current?.name === node.name;
      const koreanName = sameCurrentName && officialNode?.name
        ? officialNode.name
        : resolve(node.name, previousNode.zh ?? '');
      if (!koreanName) continue;
      const officialAligned = sameCurrentName && officialNode
        ? alignStats(current.stats ?? [], officialNode.stat_text ?? [])
        : new Map();
      const previousStats = new Map((previousNode.statsEn ?? []).map((line, index) => [line, previousNode.statsZh?.[index] ?? '']));
      const statsEn = node.stats ?? [];
      const statsZh = [];
      let complete = true;
      for (const line of statsEn) {
        const target = officialAligned.get(line) ?? resolve(line, previousStats.get(line) ?? '');
        if (!target) {
          complete = false;
          break;
        }
        statsZh.push(target);
      }
      if (!complete) continue;
      nodes[key] = { en: node.name, zh: koreanName, statsEn, statsZh };
      joined++;
    }
    writeJson(join(versionRoot, 'atlas_tree_zh.json'), {
      tag: version,
      repoe: officialSources.manifest.patch,
      locale: 'ko-KR',
      joined,
      total: tree.nodes.length,
      nodes,
    }, version === '3.29.1' ? 0 : 1);
  }
}

// Timeless-jewel stat lines are rendered from official English/Korean stat
// templates. Search/group labels without a game-data identity use the reviewed
// fallback mapping; conqueror names come from the official Korean trade API.
{
  const path = join(dataRoot, 'timeless_jewels.json');
  const data = readJson(path);
  for (const group of Object.values(data.conquerors)) {
    for (const conqueror of group) {
      const target = manual.timelessConquerors[conqueror.name];
      if (!target) throw new Error(`No official Korean conqueror name for ${conqueror.name}`);
      conqueror.nameZh = target;
      counts.official++;
    }
  }
  for (const entry of [...data.additions, ...data.nodes]) {
    entry.dnZh = resolve(entry.dn, entry.dnZh) ?? entry.dn;
    entry.sdZh = entry.sd.map((line, index) => resolve(line, entry.sdZh?.[index] ?? '') ?? line);
  }
  data.meta.ko = `Official Korean stat templates and names, RePoE ${officialSources.manifest.patch}`;
  writeJson(path, data);
}

const unresolvedRows = [...unresolved].map(([english, chinese]) => ({ english, chinese }));
writeJson(join(reportRoot, 'custom-data.json'), {
  patch: officialSources.manifest.patch,
  counts,
  unresolved: unresolvedRows.length,
}, 2);
writeJson(join(reportRoot, 'custom-data-pending.json'), { rows: unresolvedRows }, 2);

if (unresolvedRows.length) {
  throw new Error(`${unresolvedRows.length} custom-data strings need reviewed fallback translations; see reports/official-terms/custom-data-pending.json`);
}
console.log(`Custom PoE1 data: official=${counts.official}; manual=${counts.manual}; machine=${counts.machine}; unresolved=0`);
