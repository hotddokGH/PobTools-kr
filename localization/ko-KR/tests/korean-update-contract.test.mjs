import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const engineRoot = resolve(process.env.POBTOOLS_ENGINE_ROOT ?? join(repositoryRoot, 'pob-zh-engine'));

test('Korean release build disables every remote updater entry point', () => {
  const cmake = readFileSync(join(engineRoot, 'CMakeLists.txt'), 'utf8');
  const header = readFileSync(join(engineRoot, 'host', 'app_update.h'), 'utf8');
  const source = readFileSync(join(engineRoot, 'host', 'app_update.cpp'), 'utf8');
  assert.match(cmake, /option\(POBTOOLS_KOREAN_RELEASE/u);
  assert.match(cmake, /target_compile_definitions\(pob-zh PRIVATE POBTOOLS_KOREAN_RELEASE=1\)/u);
  assert.match(header, /bool RemoteUpdatesEnabled\(\) const/u);
  assert.match(source, /#ifndef POBTOOLS_KOREAN_RELEASE\s+worker_ = std::thread/u);
  for (const method of ['RequestCheck', 'StartAppUpdate', 'StartTranslationUpdate']) {
    assert.match(source, new RegExp(`void AppUpdater::${method}\\([^]*?#ifdef POBTOOLS_KOREAN_RELEASE[^]*?return;[^]*?#endif`, 'u'));
  }
});

test('Korean distribution defaults translation updates off', () => {
  const ini = readFileSync(join(engineRoot, 'dist', 'pob-zh.ini'), 'utf8');
  assert.match(ini, /^Locale=ko-KR$/mu);
  assert.match(ini, /^Game=poe1$/mu);
  assert.match(ini, /^UpdateTranslations=0$/mu);
});
