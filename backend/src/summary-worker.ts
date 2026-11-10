import type { PrismaClient } from './generated/prisma/client.js';
import type { Pool } from 'pg';
import { config } from './config.js';
import { modelRegistry, type ModelDefinition } from './model-registry.js';
import { providerRegistry, type AIProvider } from './ai.js';
import { claimSummaryJob, failSummaryJob, releaseStaleSummaryJob, renewSummaryLease, type SummaryJobLease } from './summary-queue.js';
import { SummaryProviderError, SummaryService, type SummaryResult, type SummarySourceMessage } from './summary-service.js';
import { enqueueUsageEvent } from './usage-outbox.js';

type SummaryWorkerDependencies = {
  prisma: PrismaClient; pool: Pool; serviceFactory?: () => { service: SummaryService; model: ModelDefinition; provider: AIProvider };
  leaseSeconds?: number; timeoutMs?: number;
};
const RECENT_RAW_TOKEN_CAP = 6000;
const tokenApproximation = (turn: SummarySourceMessage[]) => Math.ceil(turn.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0) / 3);

function completeTurnPrefix(rows: Array<SummarySourceMessage & { status: string }>, coveredThroughSequence: number) {
  const groups: Array<{ messages: SummarySourceMessage[]; complete: boolean }> = [];
  let current: { messages: SummarySourceMessage[]; complete: boolean } | undefined;
  const finish = () => { if (current) groups.push(current); current = undefined; };
  for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
    const message: SummarySourceMessage = { id: row.id, role: row.role, content: row.content, sequence: row.sequence };
    if (row.role === 'user') { finish(); current = { messages: [message], complete: false }; }
    else if (current) {
      current.messages.push(message);
      current.complete = row.status === 'complete';
    } else groups.push({ messages: [message], complete: false });
  }
  finish();
  const prefix: SummarySourceMessage[][] = [];
  let blockedByIncomplete = false;
  for (const turn of groups) {
    const end = turn.messages.at(-1)!.sequence;
    if (end <= coveredThroughSequence) continue;
    if (!turn.complete) { blockedByIncomplete = true; break; }
    prefix.push(turn.messages);
  }
  return { turns: prefix, blockedByIncomplete };
}

export function configuredSummaryService() {
  const model = modelRegistry.resolve(config.SUMMARY_MODEL_ID, { maxOutputTokens: Math.min(config.SUMMARY_MAX_OUTPUT_TOKENS, modelRegistry.all().find(item => item.id === config.SUMMARY_MODEL_ID)?.maxOutputTokens ?? config.SUMMARY_MAX_OUTPUT_TOKENS) });
  if (!model.capabilities.nonStreaming) throw new SummaryProviderError('SUMMARY_MODEL_UNAVAILABLE', 'The configured summary model does not support non-streaming generation.');
  if (model.providerId === 'mock' && config.NODE_ENV === 'production') throw new SummaryProviderError('SUMMARY_MODEL_UNAVAILABLE', 'A mock model cannot be used for production summaries.');
  const provider = providerRegistry.resolve(model.providerId);
  return { model, provider, service: new SummaryService(model, provider, Math.min(config.SUMMARY_MAX_OUTPUT_TOKENS, model.maxOutputTokens)) };
}

async function finishNoop(prisma: PrismaClient, lease: SummaryJobLease, revision: number, highWater: number, blockedByIncomplete = false) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${lease.conversationId}::uuid FOR UPDATE`;
    const owner = await tx.$queryRaw<Array<{ leaseToken: string; leaseGeneration: bigint; valid: boolean }>>`SELECT "leaseToken", "leaseGeneration", "leaseExpiresAt" > now() AS "valid" FROM "ConversationSummaryJob" WHERE "conversationId" = ${lease.conversationId}::uuid FOR UPDATE`;
    if (!owner.length || owner[0].leaseToken !== lease.leaseToken || BigInt(owner[0].leaseGeneration) !== lease.leaseGeneration || !owner[0].valid) return;
    const job = await tx.conversationSummaryJob.findUnique({ where: { conversationId: lease.conversationId } });
    if (!job || job.status !== 'leased' || job.leaseToken !== lease.leaseToken || job.leaseGeneration !== lease.leaseGeneration || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) return;
    const conversation = await tx.conversation.findUnique({ where: { id: lease.conversationId }, select: { transcriptRevision: true, lastMessageSequence: true } });
    const stale = !conversation || conversation.transcriptRevision !== revision;
    const moreRequested = job.requestedThroughSequence > highWater || Boolean(conversation && conversation.lastMessageSequence > highWater);
    const nextStatus = stale || moreRequested ? 'queued' : blockedByIncomplete ? 'waiting' : 'complete';
    const changed = await tx.$executeRaw`UPDATE "ConversationSummaryJob" SET "status" = ${nextStatus},
      "availableAt" = now(), "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = NULL, "updatedAt" = now()
      WHERE "conversationId" = ${lease.conversationId}::uuid AND "leaseToken" = ${lease.leaseToken}::uuid
        AND "leaseGeneration" = ${lease.leaseGeneration} AND "leaseExpiresAt" > now()`;
    if (!changed) throw new Error('SUMMARY_LEASE_FENCED');
  });
}

async function activateCandidate(deps: SummaryWorkerDependencies, lease: SummaryJobLease, snapshot: { revision: number; highWater: number; activeId: string | null; activeVersion: number | null }, result: SummaryResult, selection: { coveredThrough: number; blockedByIncomplete: boolean; provider: AIProvider; model: ModelDefinition }) {
  const cost = modelRegistry.estimateCost(selection.model.id, result.usage.inputTokens, result.usage.outputTokens);
  const pricing = modelRegistry.getPricingSnapshot(selection.model.id);
  const usageEstimated = result.usage.source === 'estimated';
  return deps.prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${lease.conversationId}::uuid FOR UPDATE`;
    const owner = await tx.$queryRaw<Array<{ leaseToken: string; leaseGeneration: bigint; valid: boolean }>>`SELECT "leaseToken", "leaseGeneration", "leaseExpiresAt" > now() AS "valid" FROM "ConversationSummaryJob" WHERE "conversationId" = ${lease.conversationId}::uuid FOR UPDATE`;
    if (!owner.length || owner[0].leaseToken !== lease.leaseToken || BigInt(owner[0].leaseGeneration) !== lease.leaseGeneration || !owner[0].valid) return false;
    const job = await tx.conversationSummaryJob.findUnique({ where: { conversationId: lease.conversationId } });
    if (!job || job.status !== 'leased' || job.leaseToken !== lease.leaseToken || job.leaseGeneration !== lease.leaseGeneration || !job.leaseExpiresAt || job.leaseExpiresAt <= new Date()) return false;
    const conversation = await tx.conversation.findUnique({ where: { id: lease.conversationId }, select: { userId: true, transcriptRevision: true, lastMessageSequence: true } });
    const active = await tx.conversationSummary.findFirst({ where: { conversationId: lease.conversationId, status: 'active' }, select: { id: true, version: true, coveredThroughSequence: true } });
    if (!conversation) return false;
    const conflict = conversation.transcriptRevision !== snapshot.revision || (active?.id ?? null) !== snapshot.activeId || (active?.version ?? null) !== snapshot.activeVersion;
    if (conflict) {
      await tx.$executeRaw`UPDATE "ConversationSummaryJob" SET "status" = 'queued', "availableAt" = now(), "leaseToken" = NULL,
        "leaseExpiresAt" = NULL, "lastErrorCode" = 'SUMMARY_SNAPSHOT_STALE', "updatedAt" = now()
        WHERE "conversationId" = ${lease.conversationId}::uuid AND "leaseToken" = ${lease.leaseToken}::uuid
          AND "leaseGeneration" = ${lease.leaseGeneration} AND "leaseExpiresAt" > now()`;
      return false;
    }
    const version = (await tx.conversationSummary.aggregate({ where: { conversationId: lease.conversationId }, _max: { version: true } }))._max.version ?? 0;
    if (active) await tx.conversationSummary.update({ where: { id: active.id }, data: { status: 'superseded' } });
    const summary = await tx.conversationSummary.create({ data: {
      conversationId: lease.conversationId, version: version + 1, coveredThroughSequence: selection.coveredThrough,
      sourceHighWaterSequence: snapshot.highWater, transcriptRevision: snapshot.revision, summaryText: result.summaryText, status: 'active',
    } });
    await enqueueUsageEvent(tx, {
      idempotencyKey: `summary:${lease.conversationId}:${summary.version}`, operation: 'summary', userId: conversation.userId,
      conversationId: lease.conversationId, provider: selection.provider.id, model: selection.model.providerModelId,
      inputTokens: usageEstimated ? null : result.usage.inputTokens, outputTokens: usageEstimated ? null : result.usage.outputTokens,
      estimatedInputTokens: usageEstimated ? result.usage.inputTokens : null, estimatedOutputTokens: usageEstimated ? result.usage.outputTokens : null,
      usageStatus: usageEstimated ? 'estimated' : 'provider_reported', estimatedCost: cost, ...pricing,
    });
    const moreRequested = job.requestedThroughSequence > snapshot.highWater || conversation.lastMessageSequence > snapshot.highWater;
    const nextStatus = moreRequested ? 'queued' : selection.blockedByIncomplete ? 'waiting' : 'complete';
    const changed = await tx.$executeRaw`UPDATE "ConversationSummaryJob" SET "status" = ${nextStatus},
      "availableAt" = now(), "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = NULL, "updatedAt" = now()
      WHERE "conversationId" = ${lease.conversationId}::uuid AND "leaseToken" = ${lease.leaseToken}::uuid
        AND "leaseGeneration" = ${lease.leaseGeneration} AND "leaseExpiresAt" > now()`;
    if (!changed) throw new Error('SUMMARY_LEASE_FENCED');
    return true;
  }, { timeout: 10_000 });
}

export async function processOneSummaryJob(deps: SummaryWorkerDependencies): Promise<boolean> {
  const lease = await claimSummaryJob(deps.pool, deps.leaseSeconds ?? config.SUMMARY_JOB_LEASE_SECONDS);
  if (!lease) return false;
  let renewal: NodeJS.Timeout | undefined; let timeout: NodeJS.Timeout | undefined; let leaseLost = false;
  const controller = new AbortController();
  const renewMs = Math.max(1000, Math.floor((deps.leaseSeconds ?? config.SUMMARY_JOB_LEASE_SECONDS) * 1000 / 3));
  renewal = setInterval(() => { void renewSummaryLease(deps.pool, lease, deps.leaseSeconds).then(ok => {
    if (!ok) { leaseLost = true; controller.abort(new Error('Summary job lease lost')); }
  }).catch(() => { leaseLost = true; controller.abort(new Error('Summary job lease renewal failed')); }); }, renewMs);
  renewal.unref();
  timeout = setTimeout(() => controller.abort(new Error('Summary provider timeout')), deps.timeoutMs ?? config.PROVIDER_TIMEOUT_MS);
  timeout.unref();
  try {
    const resolved = (deps.serviceFactory ?? configuredSummaryService)();
    const conversation = await deps.prisma.conversation.findUnique({ where: { id: lease.conversationId }, select: { id: true, userId: true, transcriptRevision: true, lastMessageSequence: true } });
    if (!conversation) return true;
    const highWater = conversation.lastMessageSequence;
    // The conversation counter is the authoritative snapshot. It also closes the race
    // where a completed chat committed before this snapshot but its coalesced enqueue
    // arrived just after the worker claimed the older requested target.
    const requestedThrough = highWater;
    const active = await deps.prisma.conversationSummary.findFirst({ where: { conversationId: lease.conversationId, status: 'active' }, orderBy: { version: 'desc' } });
    const rows = await deps.prisma.message.findMany({ where: { conversationId: lease.conversationId, sequence: { lte: requestedThrough } }, orderBy: { sequence: 'asc' }, select: { id: true, role: true, content: true, sequence: true, status: true } });
    const completion = completeTurnPrefix(rows.map(m => ({ ...m, role: m.role as 'user' | 'assistant' })), active?.coveredThroughSequence ?? 0);
    const uncovered = completion.turns;
    let recentTokens = 0; let recentCount = 0; let splitAt = uncovered.length;
    for (let i = uncovered.length - 1; i >= 0 && recentCount < config.SUMMARY_RECENT_TURNS; i--) {
      const size = tokenApproximation(uncovered[i]!);
      if (recentCount > 0 && recentTokens + size > RECENT_RAW_TOKEN_CAP) break;
      if (size > RECENT_RAW_TOKEN_CAP && recentCount === 0) break;
      recentTokens += size; recentCount++; splitAt = i;
    }
    const toSummarize = uncovered.slice(0, splitAt);
    if (!toSummarize.length) { await finishNoop(deps.prisma, lease, conversation.transcriptRevision, highWater, completion.blockedByIncomplete); return true; }
    const coveredThrough = toSummarize.at(-1)!.at(-1)!.sequence;
    const result = await resolved.service.summarize(active?.summaryText ?? '', toSummarize, controller.signal);
    if (leaseLost) { await releaseStaleSummaryJob(deps.pool, lease); return true; }
    if (controller.signal.aborted) { await failSummaryJob(deps.pool, lease, 'SUMMARY_TIMEOUT'); return true; }
    const activated = await activateCandidate(deps, lease, { revision: conversation.transcriptRevision, highWater, activeId: active?.id ?? null, activeVersion: active?.version ?? null }, result, { coveredThrough, blockedByIncomplete: completion.blockedByIncomplete, provider: resolved.provider, model: resolved.model });
    if (!activated) await releaseStaleSummaryJob(deps.pool, lease);
    return true;
  } catch (error) {
    if (leaseLost) { await releaseStaleSummaryJob(deps.pool, lease); return true; }
    const errorCode = (error as any)?.code;
    const code = error instanceof SummaryProviderError ? error.code : errorCode === 'MODEL_UNAVAILABLE' ? 'SUMMARY_MODEL_UNAVAILABLE' : controller.signal.aborted ? 'SUMMARY_TIMEOUT' : 'SUMMARY_PROVIDER_FAILURE';
    await failSummaryJob(deps.pool, lease, code);
    return true;
  } finally { if (renewal) clearInterval(renewal); if (timeout) clearTimeout(timeout); }
}

export function startSummaryWorker(deps: SummaryWorkerDependencies) {
  let stopped = false; let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { while (!stopped && await processOneSummaryJob(deps)) { /* drain available jobs */ } }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick().catch(() => {}); }, config.SUMMARY_WORKER_POLL_MS);
  timer.unref();
  void tick().catch(() => {});
  return async () => { stopped = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 10)); };
}
