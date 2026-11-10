import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { prisma, pool } from './db.js';
import { allocateMessageSequence } from './coordination.js';
import { enqueueSummaryJob } from './summary-queue.js';
import { processOneSummaryJob } from './summary-worker.js';
import { SummaryService } from './summary-service.js';
import type { AIProvider } from './ai.js';
import type { ModelDefinition } from './model-registry.js';

after(async () => { await prisma.$disconnect(); await pool.end(); });

test('terminated summary worker lease expires and a replacement worker completes recovery', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  for (let i = 0; i < 5; i++) {
    const u = await allocateMessageSequence(conversation.id);
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: `question ${i}`, sequence: u } });
    const a = await allocateMessageSequence(conversation.id);
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: `answer ${i}`, sequence: a } });
  }
  let child: ReturnType<typeof spawn> | undefined;
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let childExited: Promise<void> = Promise.resolve();
  try {
    await enqueueSummaryJob(pool, conversation.id, 10);
    const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
    const childScript = fileURLToPath(new URL('./summary-worker-crash-child.ts', import.meta.url));
    child = spawn(process.execPath, [tsxCli, childScript], { cwd: projectRoot, env: { ...process.env, SUMMARY_CRASH_CONVERSATION_ID: conversation.id }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errorOutput = '';
    childExited = new Promise<void>(resolveExit => child!.once('exit', (code, signal) => { childExit = { code, signal }; resolveExit(); }));
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.stdout!.on('data', data => { output += String(data); }); child.stderr!.on('data', data => { errorOutput += String(data); });
    const started = Date.now();
    while (!output.includes('SUMMARY_PROVIDER_BLOCKED') && Date.now() - started < 20_000) {
      if (childExit || spawnError) throw new Error(`Worker exited before provider wait (${childExit?.code}/${childExit?.signal}): ${spawnError?.message ?? errorOutput}`);
      await delay(20);
    }
    assert.match(output, /SUMMARY_PROVIDER_BLOCKED/, `child did not reach the provider call: ${errorOutput}`);
    child.kill('SIGKILL');
    await childExited;
    await delay(350);
    const model: ModelDefinition = { id: 'test:summary', providerId: 'test', providerModelId: 'test-summary', displayName: 'Test summary', description: '', enabled: true, configured: true, capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 20_000, maxOutputTokens: 800, tokenizer: 'conservative_utf8_approximation', parameters: {} };
    const provider: AIProvider = { id: 'test', async stream() { throw new Error('unused'); }, async countInputTokens(request) { return Math.ceil(request.input[0]!.content.length / 4) + 20; }, async generate() { return { text: JSON.stringify({ facts: ['recovered'], decisions: [], requirements: [], openQuestions: [], context: [] }), usage: { inputTokens: 90, outputTokens: 12 } }; } };
    const service = new SummaryService(model, provider, 800);
    assert.equal(await processOneSummaryJob({ prisma, pool, leaseSeconds: 30, timeoutMs: 5000, serviceFactory: () => ({ model, provider, service }) }), true);
    const active = await prisma.conversationSummary.findMany({ where: { conversationId: conversation.id, status: 'active' } });
    const job = await prisma.conversationSummaryJob.findUniqueOrThrow({ where: { conversationId: conversation.id } });
    assert.equal(active.length, 1);
    assert.equal(job.status, 'complete');
    assert.equal(job.leaseGeneration, 2n);
    assert.equal(await prisma.usageOutbox.count({ where: { idempotencyKey: `summary:${conversation.id}:1` } }), 1);
  } finally {
    if (child && !childExit) { child.kill('SIGKILL'); await childExited.catch(() => {}); }
    await prisma.user.delete({ where: { id: user.id } });
  }
});
