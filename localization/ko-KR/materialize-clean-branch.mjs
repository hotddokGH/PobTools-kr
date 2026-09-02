#!/usr/bin/env node
import { resolve } from 'node:path';

import { materializeCleanBranch } from './lib/clean-branch-materializer.mjs';

function parseArguments(arguments_) {
  const values = new Map();
  let dryRun = false;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--dry-run') {
      if (dryRun) throw new Error('duplicate --dry-run');
      dryRun = true;
      continue;
    }
    if (!['--repository-root', '--source-ref', '--target-root'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    const value = arguments_[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    values.set(argument, value);
  }
  for (const required of ['--repository-root', '--source-ref', '--target-root']) {
    if (!values.has(required)) throw new Error(`missing required argument: ${required}`);
  }
  return {
    repositoryRoot: resolve(values.get('--repository-root')),
    sourceRef: values.get('--source-ref'),
    targetRoot: resolve(values.get('--target-root')),
    dryRun,
  };
}

try {
  const summary = await materializeCleanBranch(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
