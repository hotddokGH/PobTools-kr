import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSourceDisplay } from './lib/source-display-audit.mjs';

const localeRoot = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const values = new Map();
  const accepted = new Set(['--engine-root', '--overlay-report', '--report']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!accepted.has(name) || value === undefined || values.has(name)) throw new Error(`invalid argument: ${name ?? '<missing>'}`);
    values.set(name, resolve(value));
  }
  for (const required of ['--engine-root', '--report']) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }
  return {
    engineRoot: values.get('--engine-root'),
    overlayReportPath: values.get('--overlay-report'),
    reportPath: values.get('--report'),
  };
}

const arguments_ = parseArguments(process.argv.slice(2));
const policy = JSON.parse(readFileSync(join(localeRoot, 'source-display-policy.json'), 'utf8'));
const overlayReport = arguments_.overlayReportPath === undefined
  ? undefined
  : JSON.parse(readFileSync(arguments_.overlayReportPath, 'utf8'));
const report = scanSourceDisplay({
  engineRoot: arguments_.engineRoot,
  policy,
  overlayReport,
});
mkdirSync(dirname(arguments_.reportPath), { recursive: true });
writeFileSync(arguments_.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`source display closure: ${report.filesScanned} files; ${report.displayLiterals} literals; ${report.issues.length} issues`);
process.exitCode = report.issues.length === 0 ? 0 : 1;
