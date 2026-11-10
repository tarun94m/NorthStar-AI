import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageBreakdown, decodeUsageCursor, encodeUsageCursor, normalizeCurrencyCostGroups, parseUsageReportFilters, periodWhere, usageRecordWhere } from './usage-report.js';

test('usage report uses bounded inclusive UTC dates and a 30-day default period', () => {
  const now = new Date('2026-11-10T17:30:00.000Z');
  const empty = parseUsageReportFilters({}, now);
  assert.ok(empty.filters);
  assert.equal(empty.filters.periodFrom.toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(empty.filters.periodToExclusive.toISOString(), '2026-11-11T00:00:00.000Z');
  assert.equal(empty.filters.explicitRange, false);

  const bounded = parseUsageReportFilters({ from: '2026-11-01', to: '2026-11-10' }, now);
  assert.ok(bounded.filters);
  assert.equal(bounded.filters.listFrom?.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(bounded.filters.listToExclusive?.toISOString(), '2026-11-11T00:00:00.000Z');
  assert.equal(bounded.filters.periodFrom.toISOString(), bounded.filters.listFrom?.toISOString());
  assert.equal(parseUsageReportFilters({ from: '2026-02-30' }, now).filters, undefined);
  assert.equal(parseUsageReportFilters({ from: '2024-01-01', to: '2025-01-02' }, now).filters, undefined);
  assert.equal(parseUsageReportFilters({ operation: 'embeddings' }, now).filters, undefined);
  assert.equal(parseUsageReportFilters({ limit: '101' }, now).filters, undefined);
});

test('usage cursors are opaque stable timestamps and malformed values are rejected', () => {
  const cursor = { createdAt: new Date('2026-11-10T12:34:56.789Z'), id: 'd9428888-122b-4f9a-a3c1-4b1f3b5f8c91' };
  const encoded = encodeUsageCursor(cursor);
  assert.deepEqual(decodeUsageCursor(encoded), cursor);
  assert.equal(decodeUsageCursor('not-a-cursor'), undefined);
  assert.equal(parseUsageReportFilters({ cursor: 'not-a-cursor' }).filters, undefined);
});

test('usage query predicates always include owner and apply filters before pagination', () => {
  const parsed = parseUsageReportFilters({ provider: 'openai', model: 'gpt-4.1-mini', operation: 'chat', usageStatus: 'partial', from: '2026-11-01', to: '2026-11-10' });
  assert.ok(parsed.filters);
  const where = usageRecordWhere('owner-a', parsed.filters, true) as any;
  assert.equal(where.userId, 'owner-a');
  assert.equal(where.provider, 'openai');
  assert.equal(where.model, 'gpt-4.1-mini');
  assert.deepEqual(where.operation, { in: ['chat', 'provider_attempt'] });
  assert.equal(where.usageStatus, 'partial');
  assert.equal(where.createdAt.gte.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(periodWhere('owner-b', parsed.filters).userId, 'owner-b');
});

test('currency aggregates keep currencies separate and legacy priced rows resolve to USD', () => {
  const result = normalizeCurrencyCostGroups([
    { pricingCurrency: 'USD', _sum: { estimatedCost: 0.42 }, _count: { _all: 3, estimatedCost: 2 } },
    { pricingCurrency: 'EUR', _sum: { estimatedCost: 0.25 }, _count: { _all: 1, estimatedCost: 1 } },
    { pricingCurrency: null, _sum: { estimatedCost: 0.03 }, _count: { _all: 2, estimatedCost: 1 } },
  ]);
  assert.deepEqual(result, [
    { currency: 'EUR', estimatedCost: 0.25, pricedRecordCount: 1, unknownCostRecordCount: 0 },
    { currency: 'UNKNOWN', estimatedCost: 0, pricedRecordCount: 0, unknownCostRecordCount: 1 },
    { currency: 'USD', estimatedCost: 0.45, pricedRecordCount: 3, unknownCostRecordCount: 1 },
  ]);
});

test('breakdown combines currency groups without hiding usage events', () => {
  const result = buildUsageBreakdown([
    { provider: 'openai', pricingCurrency: 'USD', _sum: { estimatedCost: 0.1 }, _count: { _all: 1, estimatedCost: 1 } },
    { provider: 'openai', pricingCurrency: null, _sum: { estimatedCost: null }, _count: { _all: 1, estimatedCost: 0 } },
    { provider: 'gemini', pricingCurrency: 'EUR', _sum: { estimatedCost: 0.2 }, _count: { _all: 1, estimatedCost: 1 } },
  ], 'provider');
  assert.equal(result[0]?.provider, 'gemini');
  assert.equal(result[0]?.recordCount, 1);
  assert.equal(result[1]?.provider, 'openai');
  assert.equal(result[1]?.recordCount, 2);
  assert.equal(result[1]?.estimatedCostByCurrency.find(item => item.currency === 'USD')?.estimatedCost, 0.1);
  assert.equal(result[1]?.estimatedCostByCurrency.find(item => item.currency === 'UNKNOWN')?.unknownCostRecordCount, 1);
});
