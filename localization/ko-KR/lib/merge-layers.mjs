import { formatSignature } from './format-signature.mjs';

const PLACEHOLDER_PATTERN = /\{(\d+)\}/g;
const NUMBER_PATTERN = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:\\s*(?:-|–|to)\\s*[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))?';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeStructuralText(text) {
  return String(text)
    .replace(/\r\n|\r|\n/g, '<LF>')
    .replace(/\^(?:x[0-9A-Fa-f]{6}|\d)/g, '<COLOR>')
    .replace(/[+-]?\{\d+\}/g, '<N>')
    .replace(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g, '<N>');
}

export function reflowLineBreaks(source, target) {
  const breakCount = String(source).match(/\n/g)?.length ?? 0;
  const flattened = String(target).replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (breakCount === 0 || flattened.length === 0) return flattened;

  const words = flattened.split(' ');
  if (words.length > breakCount) {
    const lines = [];
    let start = 0;
    for (let line = 1; line <= breakCount; line += 1) {
      const end = Math.max(start + 1, Math.round((words.length * line) / (breakCount + 1)));
      lines.push(words.slice(start, end).join(' '));
      start = end;
    }
    lines.push(words.slice(start).join(' '));
    return lines.join('\n');
  }

  const lines = [];
  let start = 0;
  for (let line = 1; line <= breakCount; line += 1) {
    const end = Math.max(start + 1, Math.round((flattened.length * line) / (breakCount + 1)));
    lines.push(flattened.slice(start, end));
    start = end;
  }
  lines.push(flattened.slice(start));
  return lines.join('\n');
}

function compileStructuralPattern(pattern, dictionary) {
  for (const field of ['source', 'target', 'identity', 'patch']) {
    if (typeof pattern[field] !== 'string' || pattern[field].length === 0) {
      throw new Error(`invalid structural pattern ${field}: ${dictionary}`);
    }
  }

  if (JSON.stringify(formatSignature(pattern.source)) !== JSON.stringify(formatSignature(pattern.target))) {
    throw new Error(`pattern format mismatch: ${dictionary}/${pattern.source}`);
  }

  const seenSlots = new Set();
  let expression = '^';
  let cursor = 0;
  for (const match of pattern.source.matchAll(PLACEHOLDER_PATTERN)) {
    expression += escapeRegExp(pattern.source.slice(cursor, match.index));
    const slot = `slot${match[1]}`;
    if (seenSlots.has(slot)) {
      expression += `\\k<${slot}>`;
    } else {
      expression += `(?<${slot}>${NUMBER_PATTERN}|\\{\\d+\\})`;
      seenSlots.add(slot);
    }
    cursor = match.index + match[0].length;
  }
  expression += `${escapeRegExp(pattern.source.slice(cursor))}$`;

  return {
    ...pattern,
    structure: normalizeStructuralText(pattern.source),
    expression: new RegExp(expression, 'u'),
  };
}

function prepareStructuralPatterns(patterns, dictionary) {
  const index = new Map();
  for (const pattern of patterns) {
    const prepared = compileStructuralPattern(pattern, dictionary);
    if (!index.has(prepared.structure)) index.set(prepared.structure, []);
    index.get(prepared.structure).push(prepared);
  }
  return index;
}

function applyStructuralPatterns(key, patternIndex, dictionary) {
  const structure = normalizeStructuralText(key);
  const matches = [];

  for (const pattern of patternIndex.get(structure) ?? []) {
    const match = pattern.expression.exec(key);
    if (!match) continue;
    const value = pattern.target.replace(PLACEHOLDER_PATTERN, (placeholder, index) => (
      match.groups?.[`slot${index}`] ?? placeholder
    ));
    matches.push({ pattern, value });
  }

  const values = new Set(matches.map(({ value }) => value));
  if (values.size > 1) {
    throw new Error(`official structural conflict: ${dictionary}/${key}`);
  }
  if (matches.length === 0) return undefined;

  const { pattern, value } = matches[0];
  return {
    value,
    provenance: {
      layer: 'official-structural-pattern',
      source: pattern.identity,
      patch: pattern.patch,
    },
  };
}

function assertValidTranslation(dictionary, key, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`empty translation: ${dictionary}/${key}`);
  }

  const sourceSignature = formatSignature(key);
  const targetSignature = formatSignature(value);
  if (JSON.stringify(sourceSignature) !== JSON.stringify(targetSignature)) {
    throw new Error(`format mismatch: ${dictionary}/${key}`);
  }
  if (/\p{Script=Han}/u.test(value)) {
    throw new Error(`Han display text: ${dictionary}/${key}`);
  }
  if (/ZXQPH|QXZ/u.test(value)) {
    throw new Error(`unrestored machine marker: ${dictionary}/${key}`);
  }
}

export function mergeLayers({
  dictionary,
  reference,
  officialExact = {},
  officialPatterns = {},
  manual = {},
  fallbackLayers,
  literals = {},
}) {
  const entries = {};
  const provenance = {};
  const structuralPatterns = Array.isArray(officialPatterns) ? officialPatterns : null;
  const structuralPatternIndex = structuralPatterns
    ? prepareStructuralPatterns(structuralPatterns, dictionary)
    : null;
  const preparedFallbackLayers = fallbackLayers ?? [{
    layer: 'manual-pob-ui',
    source: 'manual/pob-ui.json',
    entries: manual,
  }];

  for (const fallback of preparedFallbackLayers) {
    if (!fallback || typeof fallback.layer !== 'string' || !fallback.layer
      || typeof fallback.source !== 'string' || !fallback.source
      || !fallback.entries || typeof fallback.entries !== 'object') {
      throw new Error(`invalid fallback layer: ${dictionary}`);
    }
  }

  for (const key of Object.keys(reference).sort((left, right) => left.localeCompare(right, 'en'))) {
    const exact = officialExact[key];
    if (exact?.conflict) {
      throw new Error(`official conflict: ${dictionary}/${key}`);
    }

    let value;
    let record;
    if (exact) {
      value = exact.value;
      record = { layer: 'official-exact', source: exact.source };
    } else if (structuralPatterns) {
      const structural = applyStructuralPatterns(key, structuralPatternIndex, dictionary);
      if (structural) {
        value = structural.value;
        record = structural.provenance;
      }
    } else if (officialPatterns[key]) {
      value = officialPatterns[key].value;
      record = { layer: 'official-structural-pattern', source: officialPatterns[key].source };
    }

    if (value === undefined) {
      for (const fallback of preparedFallbackLayers) {
        if (!Object.hasOwn(fallback.entries, key)) continue;
        value = fallback.entries[key];
        record = { layer: fallback.layer, source: fallback.source };
        break;
      }
    }

    if (value === undefined && Object.hasOwn(literals, key)) {
      value = key;
      record = { layer: 'literal', source: literals[key] };
    }
    if (value === undefined) {
      continue;
    }

    assertValidTranslation(dictionary, key, value);
    entries[key] = value;
    provenance[key] = record;
  }

  return { entries, provenance, conflicts: [] };
}
