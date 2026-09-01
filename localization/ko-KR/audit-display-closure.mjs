import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLocale, auditRuntimeLocale, summarizeAudit } from './lib/locale-audit.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, '..', '..');
const policy = JSON.parse(readFileSync(join(scriptRoot, 'display-policy.json'), 'utf8'));
const targetRoot = join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'ko-KR');
const runtimeInventory = JSON.parse(readFileSync(join(scriptRoot, 'runtime-inventory.json'), 'utf8'));
const report = auditRuntimeLocale({
  inventory: runtimeInventory.entries,
  targetRoot,
  policy,
});
report.scope = 'observed-current-runtime';
report.inventory = {
  source: runtimeInventory.source,
  sourceLocale: runtimeInventory.sourceLocale,
  sha256: runtimeInventory.sha256,
  captureLastWriteTime: runtimeInventory.captureLastWriteTime,
};
const legacyInventory = auditLocale({
  referenceRoot: join(repositoryRoot, 'pob-zh-engine', 'dist', 'Data', 'poe1', 'zh-rTW'),
  targetRoot,
  policy,
});

const reportRoot = join(repositoryRoot, 'reports', 'display-closure');
mkdirSync(reportRoot, { recursive: true });
writeFileSync(join(reportRoot, 'locale-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
const summary = {
  ...summarizeAudit(report),
  scope: report.scope,
  inventory: report.inventory,
  legacyReferenceInventory: {
    status: 'non-blocking historical inventory; current reachability is established by the captured runtime miss set',
    ...summarizeAudit(legacyInventory),
  },
};
writeFileSync(join(reportRoot, 'locale-audit-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`display closure (${report.scope}): ${report.resolved}/${report.total}; excluded=${report.excluded}; issues=${report.issues.length}`);
process.exitCode = report.issues.length === 0 ? 0 : 1;
