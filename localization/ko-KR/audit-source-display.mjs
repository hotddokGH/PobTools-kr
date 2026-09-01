import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSourceDisplay } from './lib/source-display-audit.mjs';

const localeRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(localeRoot, '..', '..');
const policy = JSON.parse(readFileSync(join(localeRoot, 'source-display-policy.json'), 'utf8'));
const report = scanSourceDisplay({
  engineRoot: join(repositoryRoot, 'pob-zh-engine'),
  policy,
});
const reportRoot = join(repositoryRoot, 'reports', 'display-closure');
mkdirSync(reportRoot, { recursive: true });
writeFileSync(join(reportRoot, 'source-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`source display closure: ${report.filesScanned} files; ${report.displayLiterals} literals; ${report.issues.length} issues`);
process.exitCode = report.issues.length === 0 ? 0 : 1;
