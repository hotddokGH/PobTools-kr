import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMaintenanceRun } from './lib/upstream-maintenance.mjs';

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set(['--force-prepare']);
  const accepted = new Set(['--repository-root', '--upstream-ref', '--workspace', '--report']);
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (flags.has(name)) {
      if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
      values.set(name, true);
      index += 1;
      continue;
    }
    if (!accepted.has(name) || argv[index + 1] === undefined || values.has(name)) throw new Error(`invalid argument: ${name ?? '<missing>'}`);
    values.set(name, argv[index + 1]);
    index += 2;
  }
  for (const required of ['--upstream-ref', '--workspace']) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repositoryRoot = resolve(values.get('--repository-root') ?? defaultRoot);
  return {
    repositoryRoot,
    upstreamRef: values.get('--upstream-ref'),
    workspaceRoot: resolve(repositoryRoot, values.get('--workspace')),
    reportPath: resolve(repositoryRoot, values.get('--report') ?? 'reports/maintenance/upstream-update.json'),
    forcePrepare: values.get('--force-prepare') === true,
  };
}

try {
  const result = await prepareMaintenanceRun(parseArguments(process.argv.slice(2)));
  console.log(`${result.report.classification}: ${result.commit}`);
  process.exitCode = result.report.classification === 'review-required'
    ? 2
    : result.report.classification === 'blocked' ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
