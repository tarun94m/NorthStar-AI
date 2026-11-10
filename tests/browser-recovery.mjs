import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { join } from 'node:path';

const root = process.cwd();
const apiPort = 3010;
const webPort = 5188;
const apiURL = `http://127.0.0.1:${apiPort}`;
const baseURL = `http://127.0.0.1:${webPort}`;
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const title = `Controlled recovery ${Date.now()}`;
const log = { api: '', web: '' };
let apiProcess; let webProcess; let browser;
const tracePath = join(root, 'test-results', `browser-recovery-${Date.now()}.zip`);

function start(command, args, env, key, cwd = root) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', chunk => { log[key] += chunk.toString(); });
  child.stderr.on('data', chunk => { log[key] += chunk.toString(); });
  return child;
}
async function waitReady(url, child, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`${label} exited during startup.\n${log[label]}`);
    try { const response = await fetch(url); if (response.ok) return; } catch { /* server not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not start.\n${log[label]}`);
}
async function waitForState(readState, predicate, message) {
  const end = Date.now() + 10_000;
  let last;
  while (Date.now() < end) {
    last = await readState();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`${message}\nLast observed state: ${JSON.stringify(last)}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  await mkdir(join(root, 'test-results'), { recursive: true });
  apiProcess = start(process.execPath, ['--import', 'tsx', 'backend/src/browser-recovery-server.ts'], { PORT: String(apiPort), LOG_LEVEL: 'info', NODE_ENV: 'test', MOCK_PROVIDER_ENABLED: 'true', OPENAI_API_KEY: '', GEMINI_API_KEY: '' }, 'api');
  await waitReady(`${apiURL}/api/health`, apiProcess, 'api');
  webProcess = start(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { API_PROXY_TARGET: apiURL, VITE_PORT: String(webPort) }, 'web', join(root, 'frontend'));
  await waitReady(baseURL, webProcess, 'web');

  browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const context = await browser.newContext();
  const session = await (await fetch(`${apiURL}/__test/session`)).json();
  await context.addCookies([{ name: 'session', value: session.token, url: baseURL }]);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const pageErrors = [];
  const streamFailures = [];
  let firstStreamRequest;
  let firstStreamRequestFinished = false;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (!firstStreamRequest && request.url().includes('/api/chat/stream')) firstStreamRequest = request; });
  page.on('requestfinished', request => { if (request === firstStreamRequest) firstStreamRequestFinished = true; });
  page.on('requestfailed', request => { if (request.url().includes('/api/chat/stream')) streamFailures.push(request.failure()?.errorText ?? 'unknown'); });
  const readState = async () => {
    const response = await fetch(`${apiURL}/__test/state?title=${encodeURIComponent(title)}`);
    if (response.status === 404) return null;
    assert.equal(response.status, 200);
    return response.json();
  };

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const modelSelector = page.getByRole('combobox', { name: 'Select AI model' });
  await page.waitForFunction(() => Array.from(document.querySelector('select[aria-label="Select AI model"]')?.options ?? []).some(option => option.value === 'mock:echo'), null, { timeout: 10_000 });
  await modelSelector.selectOption('mock:echo');
  await page.locator('.provider-pill.mock').waitFor({ timeout: 10_000 });
  await page.getByRole('textbox', { name: 'Message' }).fill(title);
  const streamResponse = page.waitForResponse(response => response.url().includes('/api/chat/stream'), { timeout: 10_000 });
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await streamResponse;
  assert.equal(response.status(), 200);

  // These assertions distinguish a live provider blocked after its first chunk from a response that completed before refresh.
  const active = await waitForState(readState, state => state?.providerCalls?.[0]?.blocked && state.messages.some(message => message.role === 'assistant' && message.status === 'streaming' && message.content === 'partial response'), 'The first partial response was not persisted while generation was active.');
  assert.equal(active.providerCalls[0].completed, false);
  assert.equal(active.generationActive, true);
  await page.getByText('partial response').waitFor({ timeout: 10_000 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  const interrupted = await waitForState(readState, state => state?.providerCalls?.[0]?.abortReceived && !state.generationActive && state.messages.some(message => message.role === 'assistant' && message.status === 'partial'), 'Refresh did not cancel the blocked provider, persist the partial status, and release its generation lease.');
  assert.equal(interrupted.providerCalls[0].completed, false, 'provider must not have completed before refresh');
  assert.equal(interrupted.providerCalls[0].abortReceived, true, 'provider must observe the abort signal');
  assert.equal(interrupted.generationActive, false, 'disconnect must release the generation lease');
  const serverTerminationLog = log.api.split('\n').find(line => line.includes('chat generation finished') && /response_closed|request_aborted/.test(line));
  assert.ok(serverTerminationLog, 'structured server log should record a client disconnect rather than a timeout');
  const parsedTerminationLog = JSON.parse(serverTerminationLog);
  assert.equal(parsedTerminationLog.terminationCause === 'provider_timeout', false);
  assert.notEqual(parsedTerminationLog.providerReportedInputTokens, parsedTerminationLog.contextEstimatedInputTokens, 'provider usage and context estimate must be logged separately');
  const generationLogs = log.api.split('\n').filter(line => line.includes('chat context constructed') || line.includes('chat generation finished')).join('\n');
  assert.equal(generationLogs.includes(title), false, 'generation diagnostics must not contain user message text');
  assert.equal(generationLogs.includes('fixture preference must not enter logs'), false, 'generation diagnostics must not contain response preferences');
  assert.equal(interrupted.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(interrupted.messages.find(message => message.role === 'assistant')?.content, 'partial response');

  const row = page.locator('.conversation-row').filter({ hasText: title });
  await row.waitFor({ timeout: 10_000 });
  await row.locator('button').first().click();
  await page.getByText('Interrupted · partial response').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('article.message.assistant').count(), 1);
  await modelSelector.selectOption('mock:echo');

  await page.getByRole('button', { name: /Regenerate/ }).click();
  await page.getByText('Final controlled response').waitFor({ timeout: 10_000 });
  await page.locator('.stream-indicator').waitFor({ state: 'detached', timeout: 10_000 });
  const completed = await waitForState(readState, state => state?.providerCalls?.length === 2 && state.providerCalls[1].completed && state.messages.some(message => message.role === 'assistant' && message.status === 'complete'), 'Regeneration did not complete with provider usage metadata.');
  const assistantRows = completed.messages.filter(message => message.role === 'assistant');
  assert.equal(assistantRows.length, 1, 'regeneration must replace the partial response without duplicates');
  assert.equal(assistantRows[0].content, 'Final controlled response');
  assert.equal(assistantRows[0].status, 'complete');
  assert.equal(assistantRows[0].inputTokens, 19);
  assert.equal(assistantRows[0].outputTokens, 5);
  assert.equal(completed.usageRecords.at(-1)?.inputTokens, 19);
  assert.equal(completed.usageRecords.at(-1)?.outputTokens, 5);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.conversation-row').filter({ hasText: title }).locator('button').first().click();
  await page.getByText('Final controlled response').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('article.message.assistant').count(), 1);
  assert.equal(await page.getByText('Interrupted · partial response').count(), 0);

  // The catalog selector can override this Manual conversation to Auto for a request without pinning it.
  await modelSelector.selectOption('AUTO');
  await page.getByRole('textbox', { name: 'Message' }).fill('Verify automatic routing for this request.');
  const autoResponsePromise = page.waitForResponse(response => response.url().includes('/api/chat/stream'), { timeout: 10_000 });
  await page.getByRole('button', { name: 'Send message' }).click();
  const autoResponse = await autoResponsePromise;
  assert.equal(autoResponse.status(), 200);
  const autoBody = await autoResponse.text();
  assert.match(autoBody, /"requestedSelectionMode":"AUTO"/);
  assert.match(autoBody, /"routingPolicyVersion":"auto-v1"/);
  assert.match(autoBody, /"provider":"mock"/);
  const autoMetaEvent = autoBody.match(/event: meta\ndata: ([^\n]+)/);
  assert.ok(autoMetaEvent, 'the stream should provide routing metadata');
  const autoMeta = JSON.parse(autoMetaEvent[1]);
  assert.equal(autoMeta.requestedSelectionMode, 'AUTO');
  assert.equal(autoMeta.routingPolicyVersion, 'auto-v1');
  assert.equal(autoMeta.provider, 'mock');
  assert.ok(autoMeta.model, 'the response should identify the actual provider model');
  const autoState = await waitForState(readState, state => state?.providerCalls?.length === 3 && state.providerCalls[2].completed && state.messages.some(message => message.role === 'user' && message.content === 'Verify automatic routing for this request.'), 'The Auto override did not finish using the configured model catalog.');
  assert.equal(autoState.messages.filter(message => message.role === 'assistant').length, 2, 'the Auto follow-up adds one response and leaves regeneration without duplicates');

  // Exercise the registered-account memory UI with deterministic provider output.
  page.on('dialog', dialog => dialog.accept());
  // The test database is persistent across runs, so normalize this fixture's setting.
  const memorySettingReset = await fetch(`${apiURL}/api/memory/settings`, {
    method: 'PATCH', headers: { Cookie: `session=${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ memoryEnabled: false }),
  });
  assert.equal(memorySettingReset.status, 200, 'memory preference fixture should reset');
  assert.equal((await memorySettingReset.json()).memoryEnabled, false, 'memory preference should start disabled');
  const beforeApproval = await (await fetch(`${apiURL}/api/memories`, { headers: { Cookie: `session=${session.token}` } })).json();
  assert.equal(beforeApproval.memories.length, 0, 'suggestion extraction must not save a memory before approval');
  await page.getByRole('button', { name: 'Memory' }).click();
  const memoryDialog = page.getByRole('dialog', { name: 'Memory settings' });
  await memoryDialog.waitFor({ timeout: 10_000 });
  const memoryToggle = memoryDialog.getByRole('checkbox', { name: 'Enable long-term memory' });
  const enableResponse = page.waitForResponse(response => response.url().includes('/api/memory/settings') && response.request().method() === 'PATCH');
  await memoryToggle.click();
  assert.equal((await (await enableResponse).json()).memoryEnabled, true, 'enabling memory should persist');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Enable long-term memory"]')?.checked === true);
  const generationResponse = page.waitForResponse(response => response.url().includes('/api/memory/suggestions/generate'));
  await memoryDialog.getByRole('button', { name: 'Find suggestions from this conversation' }).click();
  const generated = await (await generationResponse).json();
  assert.equal(generated.suggestions.length, 1, `provider should create one visible candidate: ${JSON.stringify(generated)}`);
  const suggested = memoryDialog.getByRole('textbox', { name: /Suggested memory/ });
  await suggested.waitFor({ timeout: 10_000 });
  assert.equal(await suggested.inputValue(), 'The user prefers concise responses.');
  await suggested.fill('I prefer clear answers with a short summary first.');
  await memoryDialog.getByRole('button', { name: 'Approve exact text' }).click();
  await memoryDialog.getByText('I prefer clear answers with a short summary first.').waitFor({ timeout: 10_000 });
  await memoryDialog.getByText('No pending suggestions.').waitFor({ timeout: 10_000 });
  const afterApproval = await (await fetch(`${apiURL}/api/memories`, { headers: { Cookie: `session=${session.token}` } })).json();
  assert.equal(afterApproval.memories.length, 1);
  assert.equal(afterApproval.memories[0].content, 'I prefer clear answers with a short summary first.');
  const disableResponse = page.waitForResponse(response => response.url().includes('/api/memory/settings') && response.request().method() === 'PATCH');
  await memoryDialog.getByRole('checkbox', { name: 'Enable long-term memory' }).click();
  assert.equal((await (await disableResponse).json()).memoryEnabled, false, 'disabling memory should persist');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Enable long-term memory"]')?.checked === false);
  await memoryDialog.getByText('I prefer clear answers with a short summary first.').waitFor({ timeout: 10_000 });
  assert.equal((await memoryDialog.getByRole('button', { name: 'Delete' }).count()), 1, 'saved memories stay manageable when retrieval is disabled');
  await memoryDialog.locator('[aria-label="New memory content"]').fill('I enjoy logic puzzles.');
  await memoryDialog.locator('[aria-label="New memory category"]').fill('hobbies');
  await memoryDialog.locator('[aria-label="New memory tags"]').fill('logic, puzzles');
  await memoryDialog.getByRole('button', { name: 'Save memory' }).click();
  await memoryDialog.getByText('I enjoy logic puzzles.').waitFor({ timeout: 10_000 });
  let promptIndex = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', dialog => dialog.accept(['I enjoy puzzle games.','hobbies','logic, puzzles, games'][promptIndex++]));
  const manualCard = memoryDialog.locator('.memory-card').filter({ hasText: 'I enjoy logic puzzles.' });
  await manualCard.getByRole('button', { name: 'Edit' }).click();
  await memoryDialog.getByText('I enjoy puzzle games.').waitFor({ timeout: 10_000 });
  const editedMemory = await (await fetch(`${apiURL}/api/memories`, { headers: { Cookie: `session=${session.token}` } })).json();
  assert.equal(editedMemory.memories.length, 2);
  assert.ok(editedMemory.memories.some(memory => memory.content === 'I enjoy puzzle games.' && memory.category === 'hobbies'));
  const editedCard = memoryDialog.locator('.memory-card').filter({ hasText: 'I enjoy puzzle games.' });
  await editedCard.getByRole('button', { name: 'Delete' }).click();
  await memoryDialog.getByText('I enjoy puzzle games.').waitFor({ state: 'detached', timeout: 10_000 });
  const afterDelete = await (await fetch(`${apiURL}/api/memories`, { headers: { Cookie: `session=${session.token}` } })).json();
  assert.equal(afterDelete.memories.length, 1, 'deleted memories are absent from the management API immediately');
  await memoryDialog.getByRole('button', { name: 'Close memory settings' }).click();

  // Usage outbox delivery is asynchronous; wait for the persisted record before opening its read model.
  const persistedMemoryUsage = await waitForState(async () => {
    const response = await fetch(`${apiURL}/api/usage?operation=memory_extraction`, { headers: { Cookie: `session=${session.token}` } });
    if (!response.ok) return null;
    return response.json();
  }, result => result?.totalCount === 1 && result.usage[0]?.operation === 'memory_extraction', 'Memory extraction usage was not delivered to the reporting table.');
  assert.equal(persistedMemoryUsage.usage[0].operation, 'memory_extraction');
  const initialUsageResponse = page.waitForResponse(response => response.url().includes('/api/usage'), { timeout: 10_000 });
  await page.getByRole('button', { name: 'Usage & costs' }).click();
  const usageDashboard = page.getByRole('region', { name: 'Usage and cost dashboard' });
  await usageDashboard.getByRole('heading', { name: 'Usage & cost' }).waitFor({ timeout: 10_000 });
  await usageDashboard.getByRole('heading', { name: 'Usage history' }).waitFor({ timeout: 10_000 });
  const initialUsage = await (await initialUsageResponse).json();
  assert.ok(initialUsage.totalCount >= 3, `dashboard should load the two completed chat requests and the delivered memory extraction: ${JSON.stringify(initialUsage.period)}`);
  assert.equal(initialUsage.period.timezone, 'UTC');
  assert.ok(initialUsage.period.operationBreakdown.some(row => row.operation === 'memory_extraction'), 'the period aggregate should include persisted memory usage');
  await usageDashboard.locator('.usage-table-scroll tbody tr').first().waitFor({ timeout: 10_000 });
  const memoryUsageResponse = page.waitForResponse(response => response.url().includes('/api/usage') && response.url().includes('operation=memory_extraction'), { timeout: 10_000 });
  await usageDashboard.getByRole('combobox', { name: 'Filter operation' }).selectOption('memory_extraction');
  const memoryUsage = await (await memoryUsageResponse).json();
  assert.equal(memoryUsage.totalCount, 1);
  assert.equal(memoryUsage.usage[0].operation, 'memory_extraction');
  await usageDashboard.locator('.usage-table-scroll tbody tr').filter({ hasText: 'Memory extraction' }).waitFor({ timeout: 10_000 });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.ok(firstStreamRequest, 'the browser should have issued the stream request');
  assert.equal(firstStreamRequestFinished, false, 'the first stream response must remain incomplete when refresh closes its page');

  console.log(JSON.stringify({
    result: 'passed',
    steps: ['provider blocked after persisted partial chunk', 'refresh closed stream and signalled abort', 'partial state persisted and lease released', 'conversation reopened with partial state', 'regeneration completed once with reported usage', 'completed conversation survived refresh', 'Auto selector routed a request and returned safe route metadata', 'usage dashboard showed the period aggregate and filtered to memory extraction'],
    activeBeforeRefresh: { status: active.messages.find(message => message.role === 'assistant')?.status, generationActive: active.generationActive, providerCompleted: active.providerCalls[0].completed },
    afterRefresh: { status: interrupted.messages.find(message => message.role === 'assistant')?.status, generationActive: interrupted.generationActive, providerAbortReceived: interrupted.providerCalls[0].abortReceived },
    final: { assistantCount: assistantRows.length, inputTokens: assistantRows[0].inputTokens, outputTokens: assistantRows[0].outputTokens },
    autoOverride: { mode: autoMeta.requestedSelectionMode, provider: autoMeta.provider, model: autoMeta.model },
    firstStreamRequestFinished,
    streamRequestFailures: streamFailures,
    serverTerminationLog: parsedTerminationLog,
    uncaughtPageErrors: pageErrors.length,
    trace: tracePath,
  }, null, 2));
  await context.tracing.stop({ path: tracePath });
} catch (error) {
  if (browser) {
    try {
      // Preserve trace evidence on failure for inspection.
      const contexts = browser.contexts();
      await contexts[0]?.tracing.stop({ path: tracePath });
    } catch { /* tracing may already be stopped */ }
  }
  const relevantRequestLogs = log.api.split('\n').flatMap(line => {
    try { const row = JSON.parse(line); if (String(row.req?.url ?? '').includes('/api/memory') || String(row.req?.url ?? '').includes('/api/usage')) return [`${row.req.method} ${row.req.url} -> ${row.res?.statusCode ?? 'error'}`]; } catch { /* ignore partial log lines */ }
    return [];
  });
  console.error(`Browser recovery logs:\n${relevantRequestLogs.join('\n')}\nWEB:\n${log.web.slice(-2000)}`);
  throw error;
} finally {
  await browser?.close();
  await stop(webProcess);
  await stop(apiProcess);
}
