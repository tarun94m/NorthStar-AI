import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

const root = process.cwd();
dotenv.config({ path: join(root, '.env') });
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
let interruptedApi; let recoveryApi;
const logs = { interrupted: '', recovery: '' };
let userId; let sessionCookie; let conversationId; let title;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function startApi(entry, port, key, extra = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: root,
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'info', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => { logs[key] += chunk.toString(); });
  child.stderr.on('data', chunk => { logs[key] += chunk.toString(); });
  return { child, base: `http://127.0.0.1:${port}` };
}
async function waitReady(base, child) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`API exited during startup: ${child.exitCode}`);
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return; } catch { /* server is starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API did not become ready within 30 seconds.');
}
async function waitState(base, predicate) {
  const end = Date.now() + 10_000;
  let last;
  while (Date.now() < end) {
    const response = await fetch(`${base}/__test/state?title=${encodeURIComponent(title)}`);
    if (response.ok) last = await response.json();
    if (last && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Controlled generation did not reach expected state: ${JSON.stringify(last)}`);
}
async function stop(child, force = false) {
  if (!child || child.exitCode !== null) return;
  child.kill(force ? 'SIGKILL' : 'SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function responseText(response) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let result = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return result;
    result += decoder.decode(value, { stream: true });
  }
}

try {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured in the ignored local .env');
  const port1 = await freePort();
  interruptedApi = startApi('backend/src/browser-recovery-server.ts', port1, 'interrupted');
  await waitReady(interruptedApi.base, interruptedApi.child);

  const session = await (await fetch(`${interruptedApi.base}/__test/session`)).json();
  userId = session.userId;
  sessionCookie = `session=${session.token}`;
  title = `Crash recovery ${Date.now()}`;
  const created = await fetch(`${interruptedApi.base}/api/conversations`, { method: 'POST', headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(created.status, 201);
  conversationId = (await created.json()).conversation.id;

  const streamResponse = await fetch(`${interruptedApi.base}/api/chat/stream`, {
    method: 'POST', headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, content: title, modelId: 'mock:echo' }),
  });
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body.getReader(); const decoder = new TextDecoder(); let streamed = '';
  while (!streamed.includes('partial response')) {
    const next = await reader.read();
    assert.ok(next.value, 'the provider should emit its known first partial response');
    streamed += decoder.decode(next.value, { stream: true });
  }
  assert.match(streamed, /event: delta/);
  const active = await waitState(interruptedApi.base, state => state.providerCalls[0]?.blocked && state.generationActive && state.messages.some(message => message.role === 'assistant' && message.status === 'streaming' && message.content === 'partial response'));
  assert.equal(active.providerCalls[0].completed, false);

  // Kill the actual API process while its provider is blocked. SIGKILL prevents graceful lease release.
  await stop(interruptedApi.child, true);
  let afterCrash;
  try { await reader.read(); } catch { /* the interrupted HTTP response closes with the killed process */ }
  const rows = await pool.query(`SELECT id, role, content, status FROM "Message" WHERE "conversationId" = $1::uuid ORDER BY sequence`, [conversationId]);
  afterCrash = rows.rows;
  const partial = afterCrash.find(row => row.role === 'assistant');
  assert.equal(partial?.status, 'streaming', 'the killed process leaves an orphaned streaming row for recovery');
  assert.equal(partial?.content, 'partial response', 'the first emitted delta must already be durable');
  const lease = await pool.query(`SELECT "expiresAt" > now() AS active, "expiresAt" FROM "ConversationGenerationLock" WHERE "conversationId" = $1::uuid`, [conversationId]);
  assert.equal(lease.rowCount, 1, 'SIGKILL must leave the generation lease in PostgreSQL');
  assert.equal(lease.rows[0].active, true, 'the lease remains live until its expiry');

  // Age only this test conversation's lease to simulate passage beyond its 90-second TTL.
  await pool.query(`UPDATE "ConversationGenerationLock" SET "expiresAt" = now() - interval '1 second' WHERE "conversationId" = $1::uuid`, [conversationId]);
  const port2 = await freePort();
  recoveryApi = startApi('backend/src/server.ts', port2, 'recovery', { MOCK_STREAM_DELAY_MS: '0' });
  await waitReady(recoveryApi.base, recoveryApi.child);
  const history = await fetch(`${recoveryApi.base}/api/conversations`, { headers: { Cookie: sessionCookie } });
  assert.equal(history.status, 200);
  const recovered = await pool.query(`SELECT status, content FROM "Message" WHERE "id" = $1::uuid`, [partial.id]);
  assert.equal(recovered.rows[0].status, 'partial');
  assert.equal(recovered.rows[0].content, 'partial response');

  const regenerated = await fetch(`${recoveryApi.base}/api/chat/stream`, {
    method: 'POST', headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, modelId: 'mock:echo', regenerate: true }),
  });
  assert.equal(regenerated.status, 200);
  const regenerationText = await responseText(regenerated);
  assert.match(regenerationText, /event: done/);
  assert.match(regenerationText, /"status":"complete"/);
  const finalRows = await pool.query(`SELECT id, content, status, "inputTokens", "outputTokens" FROM "Message" WHERE "conversationId" = $1::uuid AND role = 'assistant' ORDER BY sequence`, [conversationId]);
  assert.equal(finalRows.rowCount, 1, 'regeneration must replace the interrupted row without duplicates');
  assert.equal(finalRows.rows[0].status, 'complete');
  assert.match(finalRows.rows[0].content, /local mock response/);
  assert.ok(finalRows.rows[0].inputTokens > 0 && finalRows.rows[0].outputTokens > 0);
  const usage = await pool.query(`SELECT "messageId", "inputTokens", "outputTokens" FROM "UsageRecord" WHERE "conversationId" = $1::uuid`, [conversationId]);
  assert.equal(usage.rowCount, 1);
  assert.equal(usage.rows[0].messageId, finalRows.rows[0].id);
  assert.equal(usage.rows[0].inputTokens, finalRows.rows[0].inputTokens);
  assert.equal(usage.rows[0].outputTokens, finalRows.rows[0].outputTokens);

  console.log(JSON.stringify({
    result: 'passed',
    backendProcessKilled: true,
    firstDeltaPersistedBeforeCrash: partial.content,
    orphanStatusBeforeRecovery: partial.status,
    leaseWasActiveAfterCrash: lease.rows[0].active,
    leaseExpirySimulatedByAgingTestRow: true,
    recoveredStatus: recovered.rows[0].status,
    assistantRowsAfterRegeneration: finalRows.rowCount,
    replacementStatus: finalRows.rows[0].status,
    replacementUsagePersisted: usage.rowCount === 1,
  }, null, 2));
} finally {
  await stop(interruptedApi?.child, false);
  await stop(recoveryApi?.child, false);
  if (userId) await pool.query(`DELETE FROM "User" WHERE "id" = $1::uuid`, [userId]).catch(() => {});
  await pool.end();
}
