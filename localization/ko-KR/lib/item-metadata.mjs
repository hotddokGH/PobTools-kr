const ROW_SECTIONS = [
  'headers',
  'rarity_values',
  'item_classes',
  'influence_tags',
  'status_lines',
  'mod_annotations',
  'composite_prefixes',
];

export function buildKoreanItemMetadata({
  reference,
  exactTerms,
  exactModNames,
  manualTerms,
  manualAffixes,
  skipPatterns,
}) {
  const unresolved = [];
  const collisions = [];
  const lookupTerm = (english) => manualTerms[english] ?? exactTerms[english];
  const translateRow = (row) => {
    const target = lookupTerm(row.en);
    if (!target) unresolved.push(`term:${row.en}`);
    return { ...row, zh: target ?? '' };
  };

  const document = { ...reference };
  for (const section of ROW_SECTIONS) {
    document[section] = (reference[section] ?? []).map(translateRow);
  }
  document.header_values = Object.fromEntries(Object.entries(reference.header_values ?? {}).map(
    ([key, rows]) => [key, rows.map(translateRow)],
  ));
  document.skip_patterns = [...skipPatterns];
  document.mod_suffixes = [...(reference.mod_suffixes ?? [])];

  const affixNames = {};
  for (const [, english] of Object.entries(reference.affix_names ?? {}).sort(([left], [right]) => left.localeCompare(right, 'zh'))) {
    const korean = manualAffixes[english] ?? exactModNames[english];
    if (!korean) {
      unresolved.push(`affix:${english}`);
      continue;
    }
    if (Object.hasOwn(affixNames, korean) && affixNames[korean] !== english) {
      collisions.push({ korean, kept: affixNames[korean], dropped: english });
      continue;
    }
    affixNames[korean] = english;
  }
  document.affix_names = affixNames;

  return {
    document,
    unresolved: [...new Set(unresolved)].sort((left, right) => left.localeCompare(right, 'en')),
    collisions,
  };
}
