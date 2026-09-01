import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLocale, summarizeAudit } from './lib/locale-audit.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, '..', '..');
const policy = JSON.parse(readFileSync(join(scriptRoot, 'display-policy.json'), 'utf8'));
const report = auditLocale({
  referenceRoot: join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'zh-rTW'),
  targetRoot: join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR'),
  policy,
});

const reportRoot = join(repositoryRoot, 'reports', 'display-closure');
mkdirSync(reportRoot, { recursive: true });
writeFileSync(join(reportRoot, 'locale-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  join(reportRoot, 'locale-audit-summary.json'),
  `${JSON.stringify(summarizeAudit(report), null, 2)}\n`,
);
console.log(`display closure: ${report.resolved}/${report.total}; excluded=${report.excluded}; issues=${report.issues.length}`);
process.exitCode = report.issues.length === 0 ? 0 : 1;
