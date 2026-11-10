import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { config } from './config.js';

export type SummaryJobLease = {
  conversationId: string; requestedThroughSequence: number; attempts: number; leaseToken: string; leaseGeneration: bigint;
};

export async function enqueueSummaryJobTx(tx: any, conversationId: string, requestedThroughSequence: number) {
  await tx.$executeRaw`INSERT INTO "ConversationSummaryJob" ("conversationId", "requestedThroughSequence", "status", "availableAt", "createdAt", "updatedAt")
    VALUES (${conversationId}::uuid, ${requestedThroughSequence}, 'queued', now(), now(), now())
    ON CONFLICT ("conversationId") DO UPDATE SET
      "requestedThroughSequence" = GREATEST("ConversationSummaryJob"."requestedThroughSequence", EXCLUDED."requestedThroughSequence"),
      "status" = CASE WHEN "ConversationSummaryJob"."status" = 'leased' AND "ConversationSummaryJob"."leaseExpiresAt" > now() THEN 'leased' ELSE 'queued' END,
      "availableAt" = CASE WHEN "ConversationSummaryJob"."status" = 'leased' AND "ConversationSummaryJob"."leaseExpiresAt" > now() THEN "ConversationSummaryJob"."availableAt" ELSE now() END,
      "updatedAt" = now()`;
}

export async function enqueueSummaryJob(pool: Pool, conversationId: string, requestedThroughSequence: number) {
  await pool.query(`INSERT INTO "ConversationSummaryJob" ("conversationId", "requestedThroughSequence", "status", "availableAt", "createdAt", "updatedAt")
    VALUES ($1::uuid, $2, 'queued', now(), now(), now())
    ON CONFLICT ("conversationId") DO UPDATE SET
      "requestedThroughSequence" = GREATEST("ConversationSummaryJob"."requestedThroughSequence", EXCLUDED."requestedThroughSequence"),
      "status" = CASE WHEN "ConversationSummaryJob"."status" = 'leased' AND "ConversationSummaryJob"."leaseExpiresAt" > now() THEN 'leased' ELSE 'queued' END,
      "availableAt" = CASE WHEN "ConversationSummaryJob"."status" = 'leased' AND "ConversationSummaryJob"."leaseExpiresAt" > now() THEN "ConversationSummaryJob"."availableAt" ELSE now() END,
      "updatedAt" = now()`, [conversationId, requestedThroughSequence]);
}

export async function claimSummaryJob(pool: Pool, leaseSeconds = config.SUMMARY_JOB_LEASE_SECONDS): Promise<SummaryJobLease | null> {
  const leaseToken = randomUUID();
  const result = await pool.query(`WITH candidate AS (
      SELECT "conversationId" FROM "ConversationSummaryJob"
      WHERE ("status" = 'queued' AND "availableAt" <= now())
         OR ("status" = 'leased' AND "leaseExpiresAt" <= now())
      ORDER BY "availableAt", "createdAt", "conversationId"
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "ConversationSummaryJob" AS job SET "status" = 'leased', "leaseToken" = $1::uuid,
      "leaseGeneration" = job."leaseGeneration" + 1, "leaseExpiresAt" = now() + ($2 * interval '1 second'),
      "attempts" = job."attempts" + 1, "lastErrorCode" = NULL, "updatedAt" = now()
    FROM candidate WHERE job."conversationId" = candidate."conversationId"
    RETURNING job.*`, [leaseToken, leaseSeconds]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return { conversationId: row.conversationId, requestedThroughSequence: row.requestedThroughSequence, attempts: row.attempts, leaseToken, leaseGeneration: BigInt(row.leaseGeneration) };
}

export async function renewSummaryLease(pool: Pool, lease: SummaryJobLease, leaseSeconds = config.SUMMARY_JOB_LEASE_SECONDS) {
  const result = await pool.query(`UPDATE "ConversationSummaryJob" SET "leaseExpiresAt" = now() + ($4 * interval '1 second'), "updatedAt" = now()
    WHERE "conversationId" = $1::uuid AND "leaseToken" = $2::uuid AND "leaseGeneration" = $3::bigint
      AND "status" = 'leased' AND "leaseExpiresAt" > now()`, [lease.conversationId, lease.leaseToken, lease.leaseGeneration.toString(), leaseSeconds]);
  return result.rowCount === 1;
}

export async function failSummaryJob(pool: Pool, lease: SummaryJobLease, errorCode: string) {
  const delaySeconds = Math.min(3600, 2 ** Math.min(lease.attempts, 10));
  const safeCode = /^[A-Z0-9_]{1,48}$/.test(errorCode) ? errorCode : 'SUMMARY_FAILED';
  const result = await pool.query(`UPDATE "ConversationSummaryJob" SET "status" = 'queued', "availableAt" = now() + ($4 * interval '1 second'),
    "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = $5, "updatedAt" = now()
    WHERE "conversationId" = $1::uuid AND "leaseToken" = $2::uuid AND "leaseGeneration" = $3::bigint AND "status" = 'leased'`,
  [lease.conversationId, lease.leaseToken, lease.leaseGeneration.toString(), delaySeconds, safeCode]);
  return result.rowCount === 1;
}

export async function releaseStaleSummaryJob(pool: Pool, lease: SummaryJobLease) {
  const result = await pool.query(`UPDATE "ConversationSummaryJob" SET "status" = 'queued', "availableAt" = now(),
    "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
    WHERE "conversationId" = $1::uuid AND "leaseToken" = $2::uuid AND "leaseGeneration" = $3::bigint AND "status" = 'leased'`,
  [lease.conversationId, lease.leaseToken, lease.leaseGeneration.toString()]);
  return result.rowCount === 1;
}

export async function noteTranscriptMutation(tx: any, conversationId: string, changedThroughSequence: number) {
  const locked = await tx.$queryRaw`SELECT "transcriptRevision", "lastMessageSequence" FROM "Conversation" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
  if (!locked.length) return { invalidated: false, revision: null };
  const revision = Number(locked[0].transcriptRevision) + 1;
  await tx.conversation.update({ where: { id: conversationId }, data: { transcriptRevision: revision } });
  const active = await tx.conversationSummary.findFirst({ where: { conversationId, status: 'active' }, select: { id: true, coveredThroughSequence: true } });
  const affectedActive = Boolean(active && changedThroughSequence <= active.coveredThroughSequence);
  if (affectedActive) await tx.conversationSummary.update({ where: { id: active!.id }, data: { status: 'invalidated' } });
  const job = await tx.conversationSummaryJob.findUnique({ where: { conversationId }, select: { status: true } });
  if (affectedActive || (job && job.status !== 'complete')) {
    const target = Number(locked[0].lastMessageSequence);
    await tx.$executeRaw`INSERT INTO "ConversationSummaryJob" ("conversationId", "requestedThroughSequence", "status", "availableAt", "createdAt", "updatedAt")
      VALUES (${conversationId}::uuid, ${target}, 'queued', now(), now(), now())
      ON CONFLICT ("conversationId") DO UPDATE SET
        "requestedThroughSequence" = GREATEST("ConversationSummaryJob"."requestedThroughSequence", EXCLUDED."requestedThroughSequence"),
        "status" = CASE WHEN "ConversationSummaryJob"."status" = 'leased' AND "ConversationSummaryJob"."leaseExpiresAt" > now() THEN 'leased' ELSE 'queued' END,
        "availableAt" = CASE WHEN "ConversationSummaryJob"."status" = 'leased' AND "ConversationSummaryJob"."leaseExpiresAt" > now() THEN "ConversationSummaryJob"."availableAt" ELSE now() END,
        "updatedAt" = now()`;
  }
  return { invalidated: affectedActive, revision };
}
