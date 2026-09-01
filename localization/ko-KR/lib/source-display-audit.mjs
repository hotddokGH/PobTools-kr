import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const HAN = /\p{Script=Han}/u;
const HANGUL = /[가-힣]/u;
const MACHINE_MARKER = /TT\d{3}TT|T{4,}/u;

export function literalSha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').toUpperCase();
}

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === '\n') line += 1;
  return line;
}

function scanStringLiterals(text) {
  const literals = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('//', index)) {
      const newline = text.indexOf('\n', index + 2);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const close = text.indexOf('*/', index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (text.startsWith('R"', index)) {
      const open = text.indexOf('(', index + 2);
      if (open < 0) break;
      const delimiter = text.slice(index + 2, open);
      const terminator = `)${delimiter}"`;
      const close = text.indexOf(terminator, open + 1);
      if (close < 0) break;
      literals.push({ value: text.slice(open + 1, close), index });
      index = close + terminator.length;
      continue;
    }
    if (text[index] === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\' && index + 1 < text.length) index += 2;
        else if (text[index] === "'") {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (text[index] !== '"') {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    let value = '';
    while (index < text.length) {
      if (text[index] === '\\' && index + 1 < text.length) {
        value += text.slice(index, index + 2);
        index += 2;
      } else if (text[index] === '"') {
        index += 1;
        break;
      } else {
        value += text[index];
        index += 1;
      }
    }
    literals.push({ value, index: start });
  }
  return literals;
}

export function auditSourceText(text, policy, file = '<memory>') {
  const normalizedFile = String(file).replaceAll('\\', '/');
  const excluded = (policy?.excludedPaths ?? []).find((row) =>
    String(row?.path ?? '').replaceAll('\\', '/') === normalizedFile && String(row?.reason ?? '').trim());
  if (excluded) {
    return {
      displayLiterals: 0,
      koreanDisplayLiterals: 0,
      allowedInternalLiterals: 0,
      excludedFile: true,
      exclusionReason: String(excluded.reason).trim(),
      issues: [],
    };
  }
  const allowed = new Map((policy?.internalLiteralAllowlist ?? []).map((row) => [row.sha256, row.reason]));
  const issues = [];
  let displayLiterals = 0;
  let koreanDisplayLiterals = 0;
  let allowedInternalLiterals = 0;

  for (const literal of scanStringLiterals(String(text))) {
    displayLiterals += 1;
    if (HANGUL.test(literal.value)) koreanDisplayLiterals += 1;
    if (MACHINE_MARKER.test(literal.value)) {
      issues.push({
        code: 'MACHINE_TRANSLATION_MARKER',
        file,
        line: lineAt(text, literal.index),
        literal: literal.value,
        sha256: literalSha256(literal.value),
      });
    }
    if (!HAN.test(literal.value)) continue;
    const sha256 = literalSha256(literal.value);
    const reason = String(allowed.get(sha256) ?? '').trim();
    if (reason) {
      allowedInternalLiterals += 1;
      continue;
    }
    issues.push({
      code: 'CHINESE_SOURCE_DISPLAY',
      file,
      line: lineAt(text, literal.index),
      literal: literal.value,
      sha256,
    });
  }
  return { displayLiterals, koreanDisplayLiterals, allowedInternalLiterals, issues };
}

function sourceFiles(engineRoot) {
  const files = [];
  const hostRoot = join(engineRoot, 'host');
  const walk = (root) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (['.cpp', '.h'].includes(extname(entry.name))) files.push(path);
    }
  };
  walk(hostRoot);
  for (const entry of readdirSync(engineRoot, { withFileTypes: true })) {
    if (entry.isFile() && /^ui_.*\.(?:cpp|h)$/u.test(entry.name)) files.push(join(engineRoot, entry.name));
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

export function scanSourceDisplay({ engineRoot, policy, overlayReport = undefined }) {
  const files = sourceFiles(engineRoot);
  const report = {
    filesScanned: files.length,
    displayLiterals: 0,
    koreanDisplayLiterals: 0,
    allowedInternalLiterals: 0,
    excludedFiles: 0,
    issues: [],
  };
  for (const file of files) {
    const result = auditSourceText(readFileSync(file, 'utf8'), policy, relative(engineRoot, file).replaceAll('\\', '/'));
    report.displayLiterals += result.displayLiterals;
    report.koreanDisplayLiterals += result.koreanDisplayLiterals;
    report.allowedInternalLiterals += result.allowedInternalLiterals;
    if (result.excludedFile) report.excludedFiles += 1;
    report.issues.push(...result.issues);
  }
  if (overlayReport !== undefined) {
    if (!Array.isArray(overlayReport?.issues)) {
      report.issues.push({ code: 'INVALID_OVERLAY_REPORT' });
    } else {
      report.issues.push(...overlayReport.issues.map((issue) => ({ ...issue })));
    }
  }
  return report;
}
