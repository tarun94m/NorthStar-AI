import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { config } from './config.js';
import { modelRegistry } from './model-registry.js';

export type UsageEvent = {
  idempotencyKey: string; operation: 'chat' | 'summary' | 'memory_extraction' | 'provider_attempt'; userId: string; conversationId?: string | null; messageId?: string | null;
  provider: string; model: string; inputTokens?: number | null; outputTokens?: number | null;
  estimatedInputTokens?: number | null; estimatedOutputTokens?: number | null; usageStatus?: 'provider_reported' | 'estimated' | 'partial' | 'unknown' | 'legacy';
  estimatedCost?: number | null; pricingCurrency?: string | null; pricingVersion?: string | null; pricingEffectiveAt?: Date | null;
  attemptId?: string | null; attemptNumber?: number | null; errorCode?: string | null;
};
export type UsageOutboxLease = UsageEvent & { id: string; leaseToken: string; leaseGeneration: number; attempts: number };

export async function enqueueUsageEvent(tx: any, event: UsageEvent) {
  const pricing = modelRegistry.getPricingSnapshot(event.model);
  const normalized = {
    ...event,
    conversationId: event.conversationId ?? null,
    messageId: event.messageId ?? null,
    inputTokens: event.inputTokens ?? null,
    outputTokens: event.outputTokens ?? null,
    estimatedInputTokens: event.estimatedInputTokens ?? null,
    estimatedOutputTokens: event.estimatedOutputTokens ?? null,
    usageStatus: event.usageStatus ?? 'provider_reported',
    estimatedCost: event.estimatedCost ?? null,
    pricingCurrency: event.pricingCurrency ?? pricing.pricingCurrency,
    pricingVersion: event.pricingVersion ?? pricing.pricingVersion,
    pricingEffectiveAt: event.pricingEffectiveAt ?? pricing.pricingEffectiveAt,
    attemptId: event.attemptId ?? null,
    attemptNumber: event.attemptNumber ?? null,
    errorCode: event.errorCode ?? null,
  };
  return tx.usageOutbox.upsert({
    where: { idempotencyKey: event.idempotencyKey },
    create: normalized,
    update: {},
  });
}

export async function claimUsageOutbox(pool: Pool, leaseSeconds = 30, idempotencyKey?: string): Promise<UsageOutboxLease | null> {
  const client = await pool.connect();
  const token = randomUUID();
  try {
    await client.query('BEGIN');
    const selected = await client.query(`SELECT "id" FROM "UsageOutbox"
      WHERE ($1::text IS NULL OR "idempotencyKey" = $1) AND "deliveredAt" IS NULL AND "availableAt" <= now()
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= now())
      ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1`, [idempotencyKey ?? null]);
    if (!selected.rowCount) { await client.query('COMMIT'); return null; }
    const updated = await client.query(`UPDATE "UsageOutbox" SET
      "leaseToken" = $2::uuid, "leaseExpiresAt" = now() + ($3 * interval '1 second'), "attempts" = "attempts" + 1
      WHERE "id" = $1::uuid RETURNING *`, [selected.rows[0].id, token, leaseSeconds]);
    await client.query('COMMIT');
    const row = updated.rows[0];
    return { ...row, leaseGeneration: row.attempts, leaseToken: row.leaseToken } as UsageOutboxLease;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function commitUsageOutbox(pool: Pool, lease: UsageOutboxLease): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(`SELECT * FROM "UsageOutbox" WHERE "id" = $1::uuid
      AND "leaseToken" = $2::uuid AND "leaseExpiresAt" > now() AND "deliveredAt" IS NULL FOR UPDATE`, [lease.id, lease.leaseToken]);
    if (!locked.rowCount) { await client.query('ROLLBACK'); return false; }
    const row = locked.rows[0];
    await client.query(`INSERT INTO "UsageRecord" (
      "id", "userId", "conversationId", "messageId", "provider", "model", "inputTokens", "outputTokens",
      "estimatedInputTokens", "estimatedOutputTokens", "usageStatus", "estimatedCost", "pricingCurrency", "pricingVersion", "pricingEffectiveAt",
      "operation", "attemptId", "attemptNumber", "errorCode", "idempotencyKey", "createdAt"
    ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::uuid,$18,$19,$20,now())
    ON CONFLICT ("idempotencyKey") DO NOTHING`, [randomUUID(), row.userId, row.conversationId, row.messageId, row.provider, row.model, row.inputTokens, row.outputTokens, row.estimatedInputTokens, row.estimatedOutputTokens, row.usageStatus, row.estimatedCost, row.pricingCurrency, row.pricingVersion, row.pricingEffectiveAt, row.operation, row.attemptId, row.attemptNumber, row.errorCode, row.idempotencyKey]);
    const result = await client.query(`UPDATE "UsageOutbox" SET "deliveredAt" = now(), "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = NULL
      WHERE "id" = $1::uuid AND "leaseToken" = $2::uuid AND "leaseExpiresAt" > now() AND "deliveredAt" IS NULL`, [lease.id, lease.leaseToken]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function retryUsageOutbox(pool: Pool, lease: UsageOutboxLease, error: unknown) {
  const delaySeconds = Math.min(3600, 2 ** Math.min(lease.attempts, 10));
  const code = typeof (error as any)?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test((error as any).code) ? (error as any).code : 'USAGE_DELIVERY_FAILED';
  await pool.query(`UPDATE "UsageOutbox" SET "availableAt" = now() + ($3 * interval '1 second'),
    "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = $4
    WHERE "id" = $1::uuid AND "leaseToken" = $2::uuid AND "deliveredAt" IS NULL`, [lease.id, lease.leaseToken, delaySeconds, code]);
}

export async function deliverUsageOutbox(pool: Pool, idempotencyKey: string) {
  const lease = await claimUsageOutbox(pool, 30, idempotencyKey);
  if (!lease) return false;
  try { return await commitUsageOutbox(pool, lease); }
  catch (error) { await retryUsageOutbox(pool, lease, error); return false; }
}

export function startUsageOutboxWorker(pool: Pool) {
  let stopped = false; let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (let count = 0; count < 50 && !stopped; count++) {
        const lease = await claimUsageOutbox(pool);
        if (!lease) break;
        try { await commitUsageOutbox(pool, lease); }
        catch (error) { await retryUsageOutbox(pool, lease, error); }
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick().catch(() => {}); }, config.USAGE_OUTBOX_POLL_MS);
  timer.unref();
  void tick().catch(() => {});
  return async () => { stopped = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 10)); };
}
