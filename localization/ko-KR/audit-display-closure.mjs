import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLocale, auditRuntimeLocale, summarizeAudit } from './lib/locale-audit.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, '..', '..');

function parseArguments(argv) {
  const values = new Map();
  const accepted = new Set(['--engine-root', '--report-root']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!accepted.has(name) || value === undefined || values.has(name)) throw new Error(`invalid argument: ${name ?? '<missing>'}`);
    values.set(name, resolve(value));
  }
  return {
    engineRoot: values.get('--engine-root') ?? join(repositoryRoot, 'pob-zh-engine'),
    reportRoot: values.get('--report-root') ?? join(repositoryRoot, 'reports'),
  };
}

const arguments_ = parseArguments(process.argv.slice(2));
const policy = JSON.parse(readFileSync(join(scriptRoot, 'display-policy.json'), 'utf8'));
const targetRoot = join(arguments_.engineRoot, 'dist', 'Data', 'poe1', 'ko-KR');
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
  referenceRoot: join(arguments_.engineRoot, 'dist', 'Data', 'poe1', 'zh-rTW'),
  targetRoot,
  policy,
});

const reportRoot = join(arguments_.reportRoot, 'display-closure');
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
