import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, pool } from './db.js';
import { allocateMessageSequence } from './coordination.js';
import { enqueueSummaryJob, claimSummaryJob, renewSummaryLease } from './summary-queue.js';
import { processOneSummaryJob } from './summary-worker.js';
import { SummaryService } from './summary-service.js';
import type { AIProvider, GenerationRequest } from './ai.js';
import type { ModelDefinition } from './model-registry.js';
import { commitUsageOutbox, claimUsageOutbox } from './usage-outbox.js';

after(async () => { await prisma.$disconnect(); await pool.end(); });

const model: ModelDefinition = { id: 'test:summary', providerId: 'test', providerModelId: 'test-summary', displayName: 'Test summary', description: '', enabled: true, configured: true, capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 30_000, maxOutputTokens: 1000, tokenizer: 'conservative_utf8_approximation', parameters: {} };
const goodJson = (note = 'durable test summary') => JSON.stringify({ facts: [note], decisions: [], requirements: [], openQuestions: [], context: [] });
const mkProvider = (generate: (request: GenerationRequest) => Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> = async () => ({ text: goodJson(), usage: { inputTokens: 50, outputTokens: 20 } })): AIProvider => ({
  id: 'test', async stream() { throw new Error('stream not used'); },
  async countInputTokens(request) { return Math.ceil(request.input.reduce((n, message) => n + message.content.length, 0) / 4) + 20; },
  async generate(request) { return generate(request); },
});
const factory = (provider = mkProvider()) => ({ service: new SummaryService(model, provider, 800), model, provider });

async function fixture(turnCount = 5) {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  for (let i = 1; i <= turnCount; i++) {
    const userSequence = await allocateMessageSequence(conversation.id);
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: `user fact ${i}`, sequence: userSequence } });
    const assistantSequence = await allocateMessageSequence(conversation.id);
    await prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: `assistant response ${i}`, sequence: assistantSequence } });
  }
  return { user, conversation };
}
async function appendTurn(conversationId: string, label: string) {
  const userSequence = await allocateMessageSequence(conversationId);
  await prisma.message.create({ data: { conversationId, role: 'user', content: `user fact ${label}`, sequence: userSequence } });
  const assistantSequence = await allocateMessageSequence(conversationId);
  await prisma.message.create({ data: { conversationId, role: 'assistant', content: `assistant response ${label}`, sequence: assistantSequence } });
  return assistantSequence;
}
const worker = (provider = mkProvider(), leaseSeconds = 90) => ({ prisma, pool, leaseSeconds, timeoutMs: 10_000, serviceFactory: () => factory(provider) });

test('initial and incremental summaries preserve sequence coverage, source high-water and prior summary', async () => {
  const f = await fixture(5);
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10);
    assert.equal(await processOneSummaryJob(worker()), true);
    const first = await prisma.conversationSummary.findFirst({ where: { conversationId: f.conversation.id, status: 'active' } });
    assert.equal(first?.version, 1);
    assert.equal(first?.coveredThroughSequence, 2, 'the active summary covers only the complete old turn before the recent raw window');
    assert.equal(first?.sourceHighWaterSequence, 10);
    assert.equal((await prisma.conversationSummaryJob.findUnique({ where: { conversationId: f.conversation.id } }))?.status, 'complete');

    for (let i = 6; i <= 10; i++) await appendTurn(f.conversation.id, String(i));
    await enqueueSummaryJob(pool, f.conversation.id, 20);
    let sawPrior = false;
    const incrementalProvider = mkProvider(async request => {
      sawPrior ||= request.input[0]!.content.includes('durable test summary');
      return { text: goodJson('incremental summary'), usage: { inputTokens: 80, outputTokens: 30 } };
    });
    await processOneSummaryJob(worker(incrementalProvider));
    const current = await prisma.conversationSummary.findFirst({ where: { conversationId: f.conversation.id, status: 'active' } });
    assert.equal(current?.version, 2);
    assert.equal(current?.coveredThroughSequence, 12, 'incremental coverage advances through complete newly uncovered turns');
    assert.equal(current?.sourceHighWaterSequence, 20);
    assert.equal(sawPrior, true);
    const event = await prisma.usageOutbox.findUnique({ where: { idempotencyKey: `summary:${f.conversation.id}:2` } });
    assert.equal(event?.operation, 'summary');
    assert.equal(event?.inputTokens, 80);
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('messages appended while provider generation runs remain raw and requeue for later summarization', async () => {
  const f = await fixture(5); let started!: () => void; let release!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocking = mkProvider(async () => { started(); await gate; return { text: goodJson(), usage: { inputTokens: 70, outputTokens: 20 } }; });
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10);
    const running = processOneSummaryJob(worker(blocking));
    await startedPromise;
    const newHighWater = await appendTurn(f.conversation.id, 'during-summary');
    await enqueueSummaryJob(pool, f.conversation.id, newHighWater);
    release(); await running;
    const summary = await prisma.conversationSummary.findFirst({ where: { conversationId: f.conversation.id, status: 'active' } });
    const job = await prisma.conversationSummaryJob.findUnique({ where: { conversationId: f.conversation.id } });
    assert.equal(summary?.sourceHighWaterSequence, 10, 'the in-flight candidate records its snapshot high-water');
    assert.ok(summary!.coveredThroughSequence < newHighWater);
    assert.equal(job?.status, 'queued', 'the coalesced later sequence remains available for the next pass');
    assert.equal(job?.requestedThroughSequence, newHighWater);
    await processOneSummaryJob(worker());
    assert.equal((await prisma.conversationSummaryJob.findUnique({ where: { conversationId: f.conversation.id } }))?.status, 'complete');
  } finally { release(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('incomplete turns block sequence coverage and are retried when regeneration completes them', async () => {
  const f = await fixture(6);
  try {
    await prisma.message.update({ where: { conversationId_sequence: { conversationId: f.conversation.id, sequence: 4 } }, data: { status: 'partial' } });
    await enqueueSummaryJob(pool, f.conversation.id, 12); await processOneSummaryJob(worker());
    assert.equal(await prisma.conversationSummary.count({ where: { conversationId: f.conversation.id, status: 'active' } }), 0, 'coverage must not skip an unfinished turn');
    assert.equal((await prisma.conversationSummaryJob.findUniqueOrThrow({ where: { conversationId: f.conversation.id } })).status, 'waiting');
    await prisma.message.update({ where: { conversationId_sequence: { conversationId: f.conversation.id, sequence: 4 } }, data: { status: 'complete' } });
    await enqueueSummaryJob(pool, f.conversation.id, 12); await processOneSummaryJob(worker());
    const active = await prisma.conversationSummary.findFirstOrThrow({ where: { conversationId: f.conversation.id, status: 'active' } });
    assert.equal(active.coveredThroughSequence, 4);
    assert.equal((await prisma.conversationSummaryJob.findUniqueOrThrow({ where: { conversationId: f.conversation.id } })).status, 'complete');
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('concurrent workers claim one summary job once; expired lease is fenced and reclaimable', async () => {
  const f = await fixture(5);
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10);
    const claims = await Promise.all([claimSummaryJob(pool, 1), claimSummaryJob(pool, 1)]);
    const first = claims.find(Boolean)!;
    assert.equal(claims.filter(Boolean).length, 1);
    await pool.query(`UPDATE "ConversationSummaryJob" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "conversationId" = $1`, [f.conversation.id]);
    const replacement = await claimSummaryJob(pool, 30);
    assert.ok(replacement);
    assert.ok(replacement!.leaseGeneration > first.leaseGeneration);
    assert.equal(await renewSummaryLease(pool, first, 30), false, 'an expired worker cannot renew its old fencing generation');
    assert.notEqual(replacement!.leaseToken, first.leaseToken);
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('an edit during summarization invalidates the candidate and rebuilds from the changed transcript', async () => {
  const f = await fixture(5); let started!: () => void; let release!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let changed = false;
  const provider = mkProvider(async () => {
    started(); await gate;
    if (!changed) {
      changed = true;
      await prisma.$transaction(async tx => {
        await noteMutationForTest(tx, f.conversation.id, 1);
        await tx.message.update({ where: { conversationId_sequence: { conversationId: f.conversation.id, sequence: 1 } }, data: { content: 'edited fact' } });
      });
    }
    return { text: goodJson(), usage: { inputTokens: 40, outputTokens: 10 } };
  });
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10);
    const running = processOneSummaryJob(worker(provider)); await startedPromise; release(); await running;
    assert.equal(await prisma.conversationSummary.count({ where: { conversationId: f.conversation.id, status: 'active' } }), 0);
    assert.equal((await prisma.conversationSummaryJob.findUnique({ where: { conversationId: f.conversation.id } }))?.status, 'queued');
    await processOneSummaryJob(worker());
    const summary = await prisma.conversationSummary.findFirst({ where: { conversationId: f.conversation.id, status: 'active' } });
    assert.ok(summary);
    assert.equal(summary?.transcriptRevision, 1);
  } finally { release(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

async function noteMutationForTest(tx: any, conversationId: string, sequence: number) {
  const { noteTranscriptMutation } = await import('./summary-queue.js');
  await noteTranscriptMutation(tx, conversationId, sequence);
}

test('covered message edits invalidate active summaries and queue a versioned rebuild', async () => {
  const f = await fixture(5);
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10); await processOneSummaryJob(worker());
    const old = await prisma.conversationSummary.findFirstOrThrow({ where: { conversationId: f.conversation.id, status: 'active' } });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${f.conversation.id}::uuid FOR UPDATE`;
      await noteMutationForTest(tx, f.conversation.id, 1);
      await tx.message.update({ where: { conversationId_sequence: { conversationId: f.conversation.id, sequence: 1 } }, data: { content: 'corrected fact' } });
    });
    assert.equal((await prisma.conversationSummary.findUnique({ where: { id: old.id } }))?.status, 'invalidated');
    assert.equal((await prisma.conversationSummaryJob.findUnique({ where: { conversationId: f.conversation.id } }))?.status, 'queued');
    await processOneSummaryJob(worker());
    const current = await prisma.conversationSummary.findFirstOrThrow({ where: { conversationId: f.conversation.id, status: 'active' } });
    assert.equal(current.version, 2);
    assert.equal(current.transcriptRevision, 1);
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('concurrent active-version conflict discards candidate without replacing the winner', async () => {
  const f = await fixture(5); let inserted = false;
  const provider = mkProvider(async () => {
    if (!inserted) {
      inserted = true;
      await prisma.conversationSummary.create({ data: { conversationId: f.conversation.id, version: 1, coveredThroughSequence: 2, sourceHighWaterSequence: 10, transcriptRevision: 0, summaryText: 'concurrent winner' } });
    }
    return { text: goodJson(), usage: { inputTokens: 40, outputTokens: 10 } };
  });
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10); await processOneSummaryJob(worker(provider));
    const active = await prisma.conversationSummary.findFirst({ where: { conversationId: f.conversation.id, status: 'active' } });
    assert.equal(active?.summaryText, 'concurrent winner');
    assert.equal((await prisma.conversationSummaryJob.findUnique({ where: { conversationId: f.conversation.id } }))?.status, 'queued');
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('expired worker candidate is fenced after a new lease generation takes ownership', async () => {
  const f = await fixture(5); let stolen = false;
  const provider = mkProvider(async () => {
    if (!stolen) {
      stolen = true;
      await pool.query(`UPDATE "ConversationSummaryJob" SET "leaseToken" = $2, "leaseGeneration" = "leaseGeneration" + 1, "leaseExpiresAt" = now() + interval '1 minute' WHERE "conversationId" = $1`, [f.conversation.id, 'd43c2825-4df1-4f0d-a317-d90fe4f24a7b']);
    }
    return { text: goodJson(), usage: { inputTokens: 40, outputTokens: 10 } };
  });
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10); await processOneSummaryJob(worker(provider));
    assert.equal(await prisma.conversationSummary.count({ where: { conversationId: f.conversation.id } }), 0);
    const job = await prisma.conversationSummaryJob.findUniqueOrThrow({ where: { conversationId: f.conversation.id } });
    assert.equal(job.status, 'leased');
    assert.equal(job.leaseToken, 'd43c2825-4df1-4f0d-a317-d90fe4f24a7b');
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('summary provider timeout remains retryable and never activates a partial candidate', async () => {
  const f = await fixture(5);
  const provider = mkProvider(async request => new Promise((_resolve, reject) => {
    if (request.signal.aborted) reject(new Error('aborted'));
    else request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10);
    await processOneSummaryJob({ ...worker(provider, 30), timeoutMs: 25 });
    assert.equal(await prisma.conversationSummary.count({ where: { conversationId: f.conversation.id, status: 'active' } }), 0);
    const job = await prisma.conversationSummaryJob.findUniqueOrThrow({ where: { conversationId: f.conversation.id } });
    assert.equal(job.status, 'queued'); assert.equal(job.lastErrorCode, 'SUMMARY_CANCELLED');
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('provider failure preserves active summary and retries with backoff', async () => {
  const f = await fixture(5); let shouldFail = false;
  const provider = mkProvider(async () => { if (shouldFail) throw Object.assign(new Error('hidden upstream detail'), { code: 'UPSTREAM_500' }); return { text: goodJson(), usage: { inputTokens: 40, outputTokens: 10 } }; });
  try {
    await enqueueSummaryJob(pool, f.conversation.id, 10); await processOneSummaryJob(worker(provider));
    const active = await prisma.conversationSummary.findFirstOrThrow({ where: { conversationId: f.conversation.id, status: 'active' } });
    for (let i = 6; i <= 10; i++) await appendTurn(f.conversation.id, String(i));
    await enqueueSummaryJob(pool, f.conversation.id, 20); shouldFail = true; await processOneSummaryJob(worker(provider));
    const afterFail = await prisma.conversationSummary.findMany({ where: { conversationId: f.conversation.id, status: 'active' } });
    const job = await prisma.conversationSummaryJob.findUniqueOrThrow({ where: { conversationId: f.conversation.id } });
    assert.equal(afterFail.length, 1); assert.equal(afterFail[0]?.id, active.id);
    assert.equal(job.status, 'queued'); assert.equal(job.lastErrorCode, 'SUMMARY_PROVIDER_FAILURE'); assert.ok(job.availableAt > new Date());
    shouldFail = false; await pool.query(`UPDATE "ConversationSummaryJob" SET "availableAt" = now() WHERE "conversationId" = $1`, [f.conversation.id]);
    await processOneSummaryJob(worker(provider));
    assert.equal((await prisma.conversationSummary.findMany({ where: { conversationId: f.conversation.id, status: 'active' } })).length, 1);
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('conversation deletion cascades summaries and jobs', async () => {
  const f = await fixture(5);
  await enqueueSummaryJob(pool, f.conversation.id, 10); await processOneSummaryJob(worker());
  await enqueueSummaryJob(pool, f.conversation.id, 10);
  await prisma.conversation.delete({ where: { id: f.conversation.id } });
  assert.equal(await prisma.conversationSummary.count({ where: { conversationId: f.conversation.id } }), 0);
  assert.equal(await prisma.conversationSummaryJob.count({ where: { conversationId: f.conversation.id } }), 0);
  await prisma.user.delete({ where: { id: f.user.id } });
});

test('usage outbox retries after worker loss and prevents duplicate event delivery', async () => {
  const f = await fixture(1);
  try {
    await prisma.usageOutbox.create({ data: { idempotencyKey: `crash-test:${f.conversation.id}`, operation: 'chat', userId: f.user.id, conversationId: f.conversation.id, provider: 'test', model: 'test-model', inputTokens: 8, outputTokens: 3, estimatedCost: 0.001 } });
    const crashedWorkerLease = await claimUsageOutbox(pool, 1);
    assert.ok(crashedWorkerLease);
    await pool.query(`UPDATE "UsageOutbox" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = $1`, [crashedWorkerLease!.id]);
    const recoveredLease = await claimUsageOutbox(pool, 30, `crash-test:${f.conversation.id}`);
    assert.ok(recoveredLease);
    assert.equal(await commitUsageOutbox(pool, crashedWorkerLease!), false, 'expired worker token cannot commit');
    assert.equal(await commitUsageOutbox(pool, recoveredLease!), true);
    assert.equal(await commitUsageOutbox(pool, recoveredLease!), false, 'redelivery is idempotent');
    const records = await prisma.usageRecord.findMany({ where: { idempotencyKey: `crash-test:${f.conversation.id}` } });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.operation, 'chat');
  } finally { await prisma.user.delete({ where: { id: f.user.id } }); }
});
