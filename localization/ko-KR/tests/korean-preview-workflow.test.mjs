import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowPath = join(repositoryRoot, '.github', 'workflows', 'build-ko-preview.yml');

test('Korean preview workflow removes preview artifacts when assembly or package validation fails', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /\$PSNativeCommandUseErrorActionPreference = \$false/u);
  assert.match(
    workflow,
    /\$zip = 'pob-zh-engine\/PobTools-Korean-preview\.zip'[^]*?\$manifest = "\$zip\.sha256\.json"[^]*?function Remove-PreviewArtifacts \{[^]*?\$zip[^]*?\$manifest[^]*?\}/u,
  );
  assert.match(
    workflow,
    /Assemble-KoreanPackage\.ps1[^]*?if \(\$LASTEXITCODE -ne 0\) \{\s*Remove-PreviewArtifacts\s*exit \$LASTEXITCODE\s*\}[^]*?Test-KoreanPackage\.ps1[^]*?if \(\$LASTEXITCODE -ne 0\) \{\s*Remove-PreviewArtifacts\s*exit \$LASTEXITCODE\s*\}/u,
  );
});
