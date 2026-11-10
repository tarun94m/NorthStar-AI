import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, pool } from './db.js';
import { claimUsageOutbox, deliverUsageOutbox, enqueueUsageEvent, retryUsageOutbox } from './usage-outbox.js';

after(async () => { await prisma.$disconnect(); await pool.end(); });

test('duplicate usage delivery preserves the creation-time pricing snapshot and never duplicates records', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const key = `usage-snapshot:${randomUUID()}`;
  const effectiveAt = new Date('2026-01-15T08:00:00.000Z');
  const base = { idempotencyKey: key, operation: 'chat' as const, userId: user.id, provider: 'mock', model: 'echo', inputTokens: 10, outputTokens: 5, usageStatus: 'provider_reported' as const, estimatedCost: 0.000123, pricingCurrency: 'USD', pricingVersion: 'fixture-v1', pricingEffectiveAt: effectiveAt };
  try {
    await prisma.$transaction(tx => enqueueUsageEvent(tx, base));
    await prisma.$transaction(tx => enqueueUsageEvent(tx, { ...base, estimatedCost: 9, pricingCurrency: 'EUR', pricingVersion: 'fixture-v2', pricingEffectiveAt: new Date('2026-11-10T00:00:00.000Z') }));
    const before = await prisma.usageOutbox.findUniqueOrThrow({ where: { idempotencyKey: key } });
    assert.equal(before.estimatedCost, 0.000123);
    assert.equal(before.pricingCurrency, 'USD');
    assert.equal(before.pricingVersion, 'fixture-v1');
    assert.equal(before.pricingEffectiveAt?.toISOString(), effectiveAt.toISOString());
    assert.equal(await deliverUsageOutbox(pool, key), true);
    assert.equal(await deliverUsageOutbox(pool, key), false);
    const delivered = await prisma.usageRecord.findMany({ where: { idempotencyKey: key } });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.estimatedCost, 0.000123);
    assert.equal(delivered[0]?.pricingCurrency, 'USD');
    assert.equal(delivered[0]?.pricingVersion, 'fixture-v1');
    assert.equal(delivered[0]?.pricingEffectiveAt?.toISOString(), effectiveAt.toISOString());
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('outbox retry changes delivery state only and retains pricing and unknown usage fields', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const key = `usage-retry:${randomUUID()}`;
  const effectiveAt = new Date('2026-02-01T00:00:00.000Z');
  try {
    await prisma.$transaction(tx => enqueueUsageEvent(tx, {
      idempotencyKey: key, operation: 'provider_attempt', userId: user.id, provider: 'gemini', model: 'gemini-3.8-flash',
      usageStatus: 'unknown', estimatedCost: null, pricingCurrency: 'USD', pricingVersion: 'fixture-gemini-v3', pricingEffectiveAt: effectiveAt,
      attemptId: randomUUID(), attemptNumber: 1, errorCode: 'UPSTREAM_TIMEOUT',
    }));
    const lease = await claimUsageOutbox(pool, 30, key);
    assert.ok(lease);
    await retryUsageOutbox(pool, lease, Object.assign(new Error('database unavailable'), { code: 'DB_UNAVAILABLE' }));
    const row = await prisma.usageOutbox.findUniqueOrThrow({ where: { idempotencyKey: key } });
    assert.equal(row.pricingCurrency, 'USD');
    assert.equal(row.pricingVersion, 'fixture-gemini-v3');
    assert.equal(row.pricingEffectiveAt?.toISOString(), effectiveAt.toISOString());
    assert.equal(row.usageStatus, 'unknown');
    assert.equal(row.estimatedCost, null);
    assert.equal(row.errorCode, 'UPSTREAM_TIMEOUT');
    assert.equal(row.lastErrorCode, 'DB_UNAVAILABLE');
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});
