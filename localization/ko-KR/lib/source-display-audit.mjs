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

function normalizedPolicyPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || /^[A-Za-z]:/u.test(value) || invalidScalarIndex(value) !== undefined) return undefined;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  return value;
}

function invalidScalarIndex(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return index;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return index;
  }
  return undefined;
}

export function validateInternalLiteralAllowlist(value) {
  const rows = value;
  const issues = [];
  const identities = new Map();
  if (!Array.isArray(rows)) {
    return { rows: [], issues: [{ code: 'INVALID_POLICY_DOCUMENT', detail: 'internalLiteralAllowlist must be an array' }] };
  }
  const validated = [];
  rows.forEach((row, index) => {
    const label = `internalLiteralAllowlist[${index}]`;
    if (row === null || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'path,reason,sha256') {
      issues.push({ code: 'INVALID_POLICY_DOCUMENT', detail: `${label} has an invalid shape` });
      return;
    }
    const path = normalizedPolicyPath(row.path);
    if (path === undefined) {
      issues.push({ code: 'INVALID_POLICY_DOCUMENT', detail: `${label}.path must be a normalized relative path` });
      return;
    }
    if (typeof row.sha256 !== 'string' || !/^[0-9A-F]{64}$/u.test(row.sha256)) {
      issues.push({ code: 'INVALID_POLICY_DOCUMENT', detail: `${label}.sha256 must be uppercase SHA-256` });
      return;
    }
    if (typeof row.reason !== 'string' || !row.reason.trim()) {
      issues.push({ code: 'INVALID_POLICY_DOCUMENT', detail: `${label}.reason must be nonblank` });
      return;
    }
    const identity = `${path}\0${row.sha256}`;
    if (identities.has(identity)) {
      issues.push({
        code: 'INVALID_POLICY_DOCUMENT',
        detail: `${label} duplicates row ${identities.get(identity)} consumer identity`,
      });
      return;
    }
    identities.set(identity, index);
    validated.push({ path, sha256: row.sha256, reason: row.reason.trim() });
  });
  return { rows: validated, issues };
}

function unsupportedEscape(escape, index, end) {
  return { code: 'UNSUPPORTED_ESCAPE', escape, index, end };
}

function decodeRegularContent(value, start, end) {
  let output = '';
  let cursor = 0;
  const simple = new Map([['\\', '\\'], ['"', '"'], ['n', '\n'], ['r', '\r'], ['t', '\t']]);
  while (cursor < value.length) {
    if (value[cursor] !== '\\') {
      output += value[cursor];
      cursor += 1;
      continue;
    }
    if (cursor + 1 >= value.length) throw unsupportedEscape('\\<EOF>', start, end);
    const marker = value[cursor + 1];
    if (/[0-7]/u.test(marker)) {
      let escapeEnd = cursor + 2;
      while (escapeEnd < value.length && /[0-7]/u.test(value[escapeEnd])) escapeEnd += 1;
      if (marker === '0' && escapeEnd === cursor + 2) {
        output += '\0';
        cursor += 2;
        continue;
      }
      throw unsupportedEscape(value.slice(cursor, escapeEnd), start, end);
    }
    if (simple.has(marker)) {
      output += simple.get(marker);
      cursor += 2;
      continue;
    }
    if (marker === 'x') {
      let escapeEnd = cursor + 2;
      while (escapeEnd < value.length && /[0-9A-Fa-f]/u.test(value[escapeEnd])) escapeEnd += 1;
      const digits = value.slice(cursor + 2, escapeEnd);
      if (digits.length !== 2) throw unsupportedEscape(value.slice(cursor, escapeEnd), start, end);
      output += String.fromCodePoint(Number.parseInt(digits, 16));
      cursor = escapeEnd;
      continue;
    }
    const width = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
    const digits = width ? value.slice(cursor + 2, cursor + 2 + width) : '';
    if (width && digits.length === width && /^[0-9A-Fa-f]+$/u.test(digits)) {
      const codepoint = Number.parseInt(digits, 16);
      if (codepoint >= 0xD800 && codepoint <= 0xDFFF) {
        throw unsupportedEscape(`\\${marker}${digits}`, start, end);
      }
      try {
        output += String.fromCodePoint(codepoint);
      } catch {
        throw unsupportedEscape(`\\${marker}${digits}`, start, end);
      }
      cursor += 2 + width;
      continue;
    }
    if (marker === '\n') {
      cursor += 2;
      continue;
    }
    if (marker === '\r' && value[cursor + 2] === '\n') {
      cursor += 3;
      continue;
    }
    throw unsupportedEscape(value.slice(cursor, Math.min(value.length, cursor + 2 + width)), start, end);
  }
  return output;
}

function literalComponentAt(text, index) {
  const rawMatch = /^(?:u8R|uR|UR|LR|R)"([^ ()\\\t\r\n]{0,16})\(/u.exec(text.slice(index));
  if (rawMatch) {
    const contentStart = index + rawMatch[0].length;
    const terminator = `)${rawMatch[1]}"`;
    const close = text.indexOf(terminator, contentStart);
    if (close < 0) return { error: { code: 'UNTERMINATED_LITERAL', index }, end: text.length };
    return {
      value: text.slice(contentStart, close),
      start: index,
      end: close + terminator.length,
      kind: 'raw',
      contentStart,
      contentEnd: close,
    };
  }
  const regularMatch = /^(?:u8|u|U|L)?"/u.exec(text.slice(index));
  if (!regularMatch) return undefined;
  const contentStart = index + regularMatch[0].length;
  let cursor = contentStart;
  while (cursor < text.length) {
    if (text[cursor] === '\\' && cursor + 1 < text.length) cursor += 2;
    else if (text[cursor] === '"') {
      const end = cursor + 1;
      const encoded = text.slice(contentStart, cursor);
      try {
        return {
          value: decodeRegularContent(encoded, index, end),
          start: index,
          end,
          kind: 'regular',
          contentStart,
          contentEnd: cursor,
        };
      } catch (error) {
        return { error, start: index, end };
      }
    } else cursor += 1;
  }
  return { error: { code: 'UNTERMINATED_LITERAL', index }, start: index, end: text.length };
}

function afterSeparators(text, index) {
  let cursor = index;
  while (cursor < text.length) {
    if (/\s/u.test(text[cursor])) cursor += 1;
    else if (text.startsWith('\\\r\n', cursor)) cursor += 3;
    else if (text.startsWith('\\\n', cursor)) cursor += 2;
    else if (text.startsWith('//', cursor)) {
      const newline = text.indexOf('\n', cursor + 2);
      cursor = newline < 0 ? text.length : newline + 1;
    } else if (text.startsWith('/*', cursor)) {
      const close = text.indexOf('*/', cursor + 2);
      cursor = close < 0 ? text.length : close + 2;
    } else break;
  }
  return cursor;
}

function rawOpeningAt(text, start, previousLexicalCharacter) {
  if (previousLexicalCharacter !== undefined && /[\p{ID_Continue}$]/u.test(previousLexicalCharacter)) {
    return undefined;
  }
  let candidate = '';
  let cursor = start;
  while (cursor < text.length && candidate.length <= 21) {
    if (text.startsWith('\\\r\n', cursor)) {
      cursor += 3;
      continue;
    }
    if (text.startsWith('\\\n', cursor)) {
      cursor += 2;
      continue;
    }
    const character = text[cursor];
    candidate += character;
    cursor += 1;
    if (character === '(') {
      const opening = /^(?:u8R|uR|UR|LR|R)"([^ ()\\\t\r\n]{0,16})\($/u.exec(candidate);
      if (!opening) return undefined;
      return { openingEnd: cursor, delimiter: opening[1] };
    }
    if (character === '\r' || character === '\n') return undefined;
  }
  return undefined;
}

function phase2LexicalView(text) {
  let lexicalText = '';
  const originalLeftBoundaries = [0];
  const originalBoundaries = [0];
  let cursor = 0;
  let state = 'code';
  let escaped = false;
  while (cursor < text.length) {
    if (state === 'code') {
      const opening = rawOpeningAt(text, cursor, lexicalText.at(-1));
      if (opening) {
        while (cursor < opening.openingEnd) {
          if (text.startsWith('\\\r\n', cursor)) {
            cursor += 3;
            originalBoundaries[originalBoundaries.length - 1] = cursor;
          } else if (text.startsWith('\\\n', cursor)) {
            cursor += 2;
            originalBoundaries[originalBoundaries.length - 1] = cursor;
          } else {
            lexicalText += text[cursor];
            cursor += 1;
            originalLeftBoundaries.push(cursor);
            originalBoundaries.push(cursor);
          }
        }
        const terminator = `)${opening.delimiter}"`;
        const close = text.indexOf(terminator, cursor);
        const rawEnd = close < 0 ? text.length : close + terminator.length;
        while (cursor < rawEnd) {
          lexicalText += text[cursor];
          cursor += 1;
          originalLeftBoundaries.push(cursor);
          originalBoundaries.push(cursor);
        }
        continue;
      }
    }
    if (text.startsWith('\\\r\n', cursor)) {
      cursor += 3;
      originalBoundaries[originalBoundaries.length - 1] = cursor;
    } else if (text.startsWith('\\\n', cursor)) {
      cursor += 2;
      originalBoundaries[originalBoundaries.length - 1] = cursor;
    } else {
      const character = text[cursor];
      const previous = lexicalText.at(-1);
      lexicalText += character;
      cursor += 1;
      originalLeftBoundaries.push(cursor);
      originalBoundaries.push(cursor);
      if (state === 'code') {
        if (previous === '/' && character === '/') state = 'line-comment';
        else if (previous === '/' && character === '*') state = 'block-comment';
        else if (character === '"') { state = 'string'; escaped = false; }
        else if (character === "'") { state = 'character'; escaped = false; }
      } else if (state === 'line-comment') {
        if (character === '\n') state = 'code';
      } else if (state === 'block-comment') {
        if (previous === '*' && character === '/') state = 'code';
      } else if (state === 'string') {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') state = 'code';
      } else if (state === 'character') {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === "'") state = 'code';
      }
    }
  }
  return { lexicalText, originalLeftBoundaries, originalBoundaries };
}

function scanStringExpressions(text) {
  const expressions = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('//', index) || text.startsWith('/*', index)) {
      index = afterSeparators(text, index);
      continue;
    }
    if (text[index] === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\' && index + 1 < text.length) index += 2;
        else if (text[index] === "'") { index += 1; break; }
        else index += 1;
      }
      continue;
    }
    const first = literalComponentAt(text, index);
    if (first === undefined) { index += 1; continue; }
    const expression = {
      value: first.value ?? '',
      index,
      end: first.end,
      error: first.error,
      components: first.error ? [] : [first],
    };
    let next = afterSeparators(text, first.end);
    while (!expression.error) {
      const component = literalComponentAt(text, next);
      if (component === undefined) break;
      if (component.error) expression.error = component.error;
      else {
        expression.value += component.value;
        expression.components.push(component);
      }
      expression.end = component.end;
      next = afterSeparators(text, component.end);
    }
    expressions.push(expression);
    index = expression.end;
  }
  return expressions;
}

export function auditSourceText(text, policy, file = '<memory>') {
  const normalizedFile = String(file).replaceAll('\\', '/');
  const validation = validateInternalLiteralAllowlist(policy?.internalLiteralAllowlist);
  if (validation.issues.length) {
    return {
      displayLiterals: 0,
      koreanDisplayLiterals: 0,
      allowedInternalLiterals: 0,
      issues: validation.issues,
    };
  }
  const sourceText = String(text);
  const invalidIndex = invalidScalarIndex(sourceText);
  if (invalidIndex !== undefined) {
    return {
      displayLiterals: 0,
      koreanDisplayLiterals: 0,
      allowedInternalLiterals: 0,
      issues: [{ code: 'INVALID_SOURCE_ENCODING', file, index: invalidIndex }],
    };
  }
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
  const allowed = new Map(validation.rows.map((row) => [`${row.path}\0${row.sha256}`, row.reason]));
  const issues = [];
  let displayLiterals = 0;
  let koreanDisplayLiterals = 0;
  let allowedInternalLiterals = 0;

  const { lexicalText, originalLeftBoundaries, originalBoundaries } = phase2LexicalView(sourceText);
  for (const literal of scanStringExpressions(lexicalText)) {
    const originalIndex = originalBoundaries[literal.index];
    const originalEnd = originalBoundaries[literal.end];
    displayLiterals += 1;
    if (literal.error) {
      issues.push({
        ...literal.error,
        file,
        index: originalBoundaries[literal.error.index ?? literal.index],
        end: originalBoundaries[literal.error.end ?? literal.end],
        line: lineAt(sourceText, originalIndex),
      });
      continue;
    }
    const literalValue = literal.components.map((component) => (
      component.kind === 'raw'
        ? sourceText.slice(
          originalLeftBoundaries[component.contentStart],
          originalBoundaries[component.contentEnd],
        )
        : component.value
    )).join('');
    if (HANGUL.test(literalValue)) koreanDisplayLiterals += 1;
    if (MACHINE_MARKER.test(literalValue)) {
      issues.push({
        code: 'MACHINE_TRANSLATION_MARKER',
        file,
        line: lineAt(sourceText, originalIndex),
        index: originalIndex,
        end: originalEnd,
        literal: literalValue,
        sha256: literalSha256(literalValue),
      });
    }
    if (!HAN.test(literalValue)) continue;
    const sha256 = literalSha256(literalValue);
    const reason = String(allowed.get(`${normalizedFile}\0${sha256}`) ?? '').trim();
    if (reason) {
      allowedInternalLiterals += 1;
      continue;
    }
    issues.push({
      code: 'CHINESE_SOURCE_DISPLAY',
      file,
      line: lineAt(sourceText, originalIndex),
      index: originalIndex,
      end: originalEnd,
      literal: literalValue,
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
  const policyValidation = validateInternalLiteralAllowlist(policy?.internalLiteralAllowlist);
  if (policyValidation.issues.length) {
    return {
      filesScanned: 0,
      displayLiterals: 0,
      koreanDisplayLiterals: 0,
      allowedInternalLiterals: 0,
      excludedFiles: 0,
      issues: policyValidation.issues,
    };
  }
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
    const fileName = relative(engineRoot, file).replaceAll('\\', '/');
    let sourceText;
    try {
      sourceText = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    } catch {
      report.issues.push({ code: 'INVALID_SOURCE_ENCODING', file: fileName });
      continue;
    }
    const result = auditSourceText(sourceText, policy, fileName);
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
