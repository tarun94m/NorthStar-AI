import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
process.env.MOCK_PROVIDER_ENABLED = 'true';
process.env.OPENAI_API_KEY = '';
process.env.GEMINI_API_KEY = '';

const tests = readdirSync(new URL('./src/', import.meta.url))
  .filter(file => file.endsWith('.test.ts'))
  .map(file => `src/${file}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests], {
  cwd: new URL('.', import.meta.url),
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
