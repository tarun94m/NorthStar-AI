import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('mock registration is opt-in and rejected in production', () => {
  const production = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import('./src/config.ts')"], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', MOCK_PROVIDER_ENABLED: 'true' },
  });
  assert.notEqual(production.status, 0);
  assert.match(`${production.stdout}${production.stderr}`, /MOCK_PROVIDER_ENABLED may only be true in development or test/);

  const disabled = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import('./src/model-registry.ts').then(({modelRegistry})=>{console.log(JSON.stringify(modelRegistry.listForCatalog().map(m=>m.id))); try{modelRegistry.resolve('mock:echo')}catch(e){console.log(e.code)}})"], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', MOCK_PROVIDER_ENABLED: 'false' },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  const output = `${disabled.stdout}${disabled.stderr}`;
  assert.doesNotMatch(output, /mock:echo/);
  assert.match(output, /MODEL_UNAVAILABLE/);
});
