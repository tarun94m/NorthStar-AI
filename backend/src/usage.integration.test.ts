import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, pool } from './db.js';
import { createToken } from './auth.js';
import { createApp } from './app.js';

after(async () => { await prisma.$disconnect(); await pool.end(); });

async function fixture() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@usage.test`, isGuest: true } });
  const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
  return { user, cookie: `session=${createToken({ id: user.id, guest: true }, session.id)}` };
}
async function listen() {
  const server = createApp(prisma).listen(0);
  return new Promise<{ base: string; close: () => Promise<void> }>(resolve => server.once('listening', () => {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    resolve({ base: `http://127.0.0.1:${address.port}`, close: () => new Promise((done, reject) => server.close(error => error ? reject(error) : done())) });
  }));
}
async function record(userId: string, data: Record<string, unknown>) {
  return prisma.usageRecord.create({ data: { userId, provider: 'mock', model: 'echo', operation: 'chat', usageStatus: 'provider_reported', ...data } as any });
}

test('usage endpoint aggregates all matching events, keeps currencies separate, filters dates, and isolates users', async () => {
  const owner = await fixture(); const other = await fixture(); const empty = await fixture(); const history = await fixture();
  const server = await listen();
  const date = (value: string) => new Date(value);
  try {
    await record(owner.user.id, { provider: 'openai', model: 'gpt-4.1-mini', inputTokens: 12, outputTokens: 3, estimatedCost: 0.0001, pricingCurrency: 'USD', pricingVersion: 'openai-v1', pricingEffectiveAt: date('2026-01-01T00:00:00.000Z'), createdAt: date('2026-11-05T12:00:00.000Z'), idempotencyKey: randomUUID() });
    await record(owner.user.id, { provider: 'gemini', model: 'gemini-3.8-flash', operation: 'provider_attempt', usageStatus: 'unknown', estimatedCost: null, pricingCurrency: 'USD', attemptId: randomUUID(), attemptNumber: 1, errorCode: 'UPSTREAM_TIMEOUT', createdAt: date('2026-11-05T12:01:00.000Z'), idempotencyKey: randomUUID() });
    await record(owner.user.id, { provider: 'openai', model: 'gpt-4.1', operation: 'summary', inputTokens: 20, outputTokens: 8, estimatedCost: 0.0002, pricingCurrency: 'USD', pricingVersion: 'openai-v2', createdAt: date('2026-11-10T22:00:00.000Z'), idempotencyKey: randomUUID() });
    await record(owner.user.id, { provider: 'openai', model: 'gpt-4.1-mini', operation: 'memory_extraction', usageStatus: 'estimated', estimatedInputTokens: 30, estimatedOutputTokens: 6, estimatedCost: 0.00004, pricingCurrency: 'EUR', pricingVersion: 'eur-v1', createdAt: date('2026-11-03T08:00:00.000Z'), idempotencyKey: randomUUID() });
    await record(owner.user.id, { provider: 'openai', model: 'gpt-4.1-mini', inputTokens: 100, outputTokens: 10, estimatedCost: 0.01, pricingCurrency: 'USD', createdAt: date('2026-10-31T23:59:59.999Z'), idempotencyKey: randomUUID() });
    await record(other.user.id, { provider: 'openai', model: 'gpt-4.1-mini', inputTokens: 9000, outputTokens: 9000, estimatedCost: 99, pricingCurrency: 'USD', createdAt: date('2026-11-05T12:00:00.000Z'), idempotencyKey: randomUUID() });

    const url = `${server.base}/api/usage?from=2026-11-01&to=2026-11-10&limit=2`;
    const firstResponse = await fetch(url, { headers: { Cookie: owner.cookie } });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as any;
    assert.equal(first.totalCount, 4);
    assert.equal(first.usage.length, 2);
    assert.equal(first.pagination.hasMore, true);
    assert.ok(first.pagination.nextCursor);
    assert.equal(first.period.timezone, 'UTC');
    assert.equal(first.period.from, '2026-11-01');
    assert.equal(first.period.to, '2026-11-10');
    assert.equal(first.period.recordCount, 4);
    assert.equal(first.period.requestCount, 3);
    assert.equal(first.period.providerAttemptCount, 1);
    assert.equal(first.period.failedProviderAttemptCount, 1);
    assert.equal(first.period.usageStatusCounts.unknown, 1);
    assert.equal(first.period.tokens.providerReportedInput, 32);
    assert.equal(first.period.tokens.estimatedInput, 30);
    assert.equal(first.period.totalEstimatedCost, null, 'mixed currencies and an unknown attempt cost cannot be reported as a complete single-currency total');
    assert.equal(first.period.estimatedCostByCurrency.find((item: any) => item.currency === 'USD')?.estimatedCost, 0.0003);
    assert.equal(first.period.estimatedCostByCurrency.find((item: any) => item.currency === 'EUR')?.estimatedCost, 0.00004);
    assert.equal(first.period.estimatedCostByCurrency.find((item: any) => item.currency === 'USD')?.unknownCostRecordCount, 1);
    assert.deepEqual(first.recentEstimatedCostByCurrency, [{ currency: 'EUR', amount: 0.00004 }, { currency: 'USD', amount: 0.0003 }]);
    assert.equal(first.totalEstimatedCost, null, 'the compatibility subtotal is null rather than adding different currencies');

    const secondResponse = await fetch(`${server.base}/api/usage?from=2026-11-01&to=2026-11-10&limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`, { headers: { Cookie: owner.cookie } });
    const second = await secondResponse.json() as any;
    assert.equal(second.usage.length, 2);
    assert.equal(second.pagination.hasMore, false);
    assert.equal(new Set([...first.usage, ...second.usage].map((row: any) => row.id)).size, 4, 'cursor pages do not repeat events');

    const chat = await (await fetch(`${server.base}/api/usage?from=2026-11-01&to=2026-11-10&operation=chat`, { headers: { Cookie: owner.cookie } })).json() as any;
    assert.equal(chat.totalCount, 2, 'chat filter includes the failed provider attempt rows');
    assert.deepEqual(new Set(chat.usage.map((row: any) => row.operation)), new Set(['chat', 'provider_attempt']));
    assert.equal(chat.period.requestCount, 1);
    assert.equal(chat.period.failedProviderAttemptCount, 1);

    const unknown = await (await fetch(`${server.base}/api/usage?from=2026-11-01&to=2026-11-10&usageStatus=unknown`, { headers: { Cookie: owner.cookie } })).json() as any;
    assert.equal(unknown.totalCount, 1);
    assert.equal(unknown.usage[0].errorCode, 'UPSTREAM_TIMEOUT');
    assert.equal(unknown.usage[0].estimatedCost, null);

    const otherResult = await (await fetch(`${server.base}/api/usage?from=2026-11-01&to=2026-11-10`, { headers: { Cookie: other.cookie } })).json() as any;
    assert.equal(otherResult.totalCount, 1);
    assert.equal(otherResult.usage[0].estimatedCost, 99);
    const emptyResult = await (await fetch(`${server.base}/api/usage?from=2026-11-01&to=2026-11-10`, { headers: { Cookie: empty.cookie } })).json() as any;
    assert.equal(emptyResult.totalCount, 0);
    assert.deepEqual(emptyResult.usage, []);
    assert.equal(emptyResult.period.requestCount, 0);
    assert.equal(emptyResult.period.totalEstimatedCost, 0);
    assert.equal(emptyResult.totalEstimatedCost, 0);

    await prisma.usageRecord.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
      userId: history.user.id, provider: 'openai', model: 'test-model', operation: 'chat', usageStatus: 'estimated',
      estimatedCost: 0.01, pricingCurrency: 'USD', idempotencyKey: `history-${history.user.id}-${index}`,
      createdAt: new Date(Date.UTC(2026, 10, 10, 0, index)),
    })) });
    const legacyRecent = await (await fetch(`${server.base}/api/usage?from=2026-11-01&to=2026-11-10`, { headers: { Cookie: history.cookie } })).json() as any;
    assert.equal(legacyRecent.totalCount, 105);
    assert.equal(legacyRecent.usage.length, 100, 'the existing maximum history response remains 100 records');
    assert.equal(legacyRecent.totalEstimatedCost, 1, 'the legacy field remains the recent-100-record subtotal');
    assert.equal(legacyRecent.period.totalEstimatedCost, 1.05, 'the named period aggregate covers all records in the selected dates');

    const invalid = await fetch(`${server.base}/api/usage?from=2026-02-30`, { headers: { Cookie: owner.cookie } });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as any).code, 'VALIDATION_ERROR');
    const tooWide = await fetch(`${server.base}/api/usage?from=2024-01-01&to=2025-01-02`, { headers: { Cookie: owner.cookie } });
    assert.equal(tooWide.status, 400);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [owner.user.id, other.user.id, empty.user.id, history.user.id] } } });
  }
});

test('usage endpoint requires a valid owner session', async () => {
  const server = await listen();
  try {
    const response = await fetch(`${server.base}/api/usage`);
    assert.equal(response.status, 401);
  } finally { await server.close(); }
});
