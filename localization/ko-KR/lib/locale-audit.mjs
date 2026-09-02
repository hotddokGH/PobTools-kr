import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { formatSignature } from './format-signature.mjs';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function issue(dictionary, key, code, detail = '') {
  return { dictionary, key, code, detail };
}

export function auditEntries({ dictionary, reference, target, policy }) {
  const issues = [];
  let resolved = 0;
  let excluded = 0;
  const literalPolicy = policy?.literalAllowlist?.[dictionary] ?? {};
  const excludedPolicy = policy?.excluded?.[dictionary] ?? {};

  for (const key of Object.keys(reference).sort()) {
    if (hasOwn(excludedPolicy, key)) {
      const reason = String(excludedPolicy[key] ?? '').trim();
      if (!reason) issues.push(issue(dictionary, key, 'UNEXPLAINED_EXCLUSION'));
      else excluded += 1;
      continue;
    }

    if (!hasOwn(target, key)) {
      issues.push(issue(dictionary, key, 'MISSING_KEY'));
      continue;
    }

    const value = target[key];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(issue(dictionary, key, 'EMPTY_VALUE'));
      continue;
    }

    const keyIssues = [];
    if (/\p{Script=Han}/u.test(value)) {
      keyIssues.push(issue(dictionary, key, 'CHINESE_DISPLAY', value));
    }

    const sourceSignature = formatSignature(key);
    const targetSignature = formatSignature(value);
    if (!sameArray(sourceSignature, targetSignature)) {
      keyIssues.push(issue(
        dictionary,
        key,
        'FORMAT_MISMATCH',
        `${JSON.stringify(sourceSignature)} != ${JSON.stringify(targetSignature)}`,
      ));
    }

    const literalDeclared = hasOwn(literalPolicy, key);
    if (literalDeclared && !String(literalPolicy[key] ?? '').trim()) {
      keyIssues.push(issue(dictionary, key, 'UNEXPLAINED_LITERAL'));
    } else if (value === key && !literalDeclared) {
      keyIssues.push(issue(dictionary, key, 'UNRESOLVED_ENGLISH'));
    }

    if (keyIssues.length === 0) resolved += 1;
    issues.push(...keyIssues);
  }

  return {
    dictionary,
    total: Object.keys(reference).length,
    resolved,
    excluded,
    issues,
  };
}

export function auditRuntimeEntries({ inventory, dictionaries, loadOrder, policy }) {
  const target = {};
  for (const dictionary of loadOrder) {
    for (const [key, value] of Object.entries(dictionaries[dictionary] ?? {})) {
      if (!hasOwn(target, key)) target[key] = value;
    }
  }

  const literalAllowlist = {};
  const excluded = {};
  for (const rows of Object.values(policy?.literalAllowlist ?? {})) Object.assign(literalAllowlist, rows);
  for (const rows of Object.values(policy?.excluded ?? {})) Object.assign(excluded, rows);
  const reference = Object.fromEntries(inventory.map((key) => [key, true]));
  return auditEntries({
    dictionary: 'runtime',
    reference,
    target,
    policy: {
      literalAllowlist: { runtime: literalAllowlist },
      excluded: { runtime: excluded },
    },
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function auditLocale({ referenceRoot, targetRoot, policy }) {
  const meta = readJson(join(referenceRoot, 'meta.json'));
  const dictionaries = [];
  const issues = [];
  let total = 0;
  let resolved = 0;
  let excluded = 0;

  for (const file of meta.load_order) {
    const dictionary = basename(file, '.json');
    const reference = readJson(join(referenceRoot, file)).entries ?? {};
    let target = {};
    try {
      target = readJson(join(targetRoot, file)).entries ?? {};
    } catch {
      target = {};
    }
    const result = auditEntries({ dictionary, reference, target, policy });
    dictionaries.push(result);
    issues.push(...result.issues);
    total += result.total;
    resolved += result.resolved;
    excluded += result.excluded;
  }

  return { total, resolved, excluded, dictionaries, issues };
}

export function auditRuntimeLocale({ inventory, targetRoot, policy }) {
  const meta = readJson(join(targetRoot, 'meta.json'));
  const dictionaries = {};
  for (const file of meta.load_order) {
    const dictionary = basename(file, '.json');
    dictionaries[dictionary] = readJson(join(targetRoot, file)).entries ?? {};
  }
  const result = auditRuntimeEntries({
    inventory,
    dictionaries,
    loadOrder: meta.load_order.map((file) => basename(file, '.json')),
    policy,
  });
  return {
    total: result.total,
    resolved: result.resolved,
    excluded: result.excluded,
    dictionaries: [result],
    issues: result.issues,
  };
}

export function summarizeAudit(report) {
  const issueCodes = {};
  for (const auditIssue of report.issues) {
    issueCodes[auditIssue.code] = (issueCodes[auditIssue.code] ?? 0) + 1;
  }
  return {
    total: report.total,
    resolved: report.resolved,
    excluded: report.excluded,
    issues: report.issues.length,
    issueCodes,
    dictionaries: report.dictionaries.map((dictionary) => ({
      dictionary: dictionary.dictionary,
      total: dictionary.total,
      resolved: dictionary.resolved,
      excluded: dictionary.excluded,
      issues: dictionary.issues.length,
    })),
  };
}
