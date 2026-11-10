import { z } from 'zod';

const operations = ['chat', 'summary', 'memory_extraction', 'provider_attempt'] as const;
const statuses = ['provider_reported', 'estimated', 'partial', 'unknown', 'legacy'] as const;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must use YYYY-MM-DD in UTC.');
const querySchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  provider: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  operation: z.enum(operations).optional(),
  usageStatus: z.enum(statuses).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().max(300).optional(),
}).strict();

export type UsageOperation = typeof operations[number];
export type UsageStatus = typeof statuses[number];
export type UsageCursor = { createdAt: Date; id: string };
export type UsageReportFilters = {
  provider?: string; model?: string; operation?: UsageOperation; usageStatus?: UsageStatus;
  explicitRange: boolean; listFrom?: Date; listToExclusive?: Date;
  periodFrom: Date; periodToExclusive: Date; limit: number; cursor?: UsageCursor;
};

function utcDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? null : date;
}
function dateString(date: Date) { return date.toISOString().slice(0, 10); }
function addUtcDays(date: Date, days: number) { const copy = new Date(date); copy.setUTCDate(copy.getUTCDate() + days); return copy; }

export function decodeUsageCursor(value: string | undefined): UsageCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const parsed = z.object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict().safeParse(decoded);
    if (!parsed.success) return undefined;
    const createdAt = new Date(parsed.data.createdAt);
    return Number.isNaN(createdAt.valueOf()) ? undefined : { createdAt, id: parsed.data.id };
  } catch { return undefined; }
}

export function encodeUsageCursor(value: UsageCursor) {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id }), 'utf8').toString('base64url');
}

export function parseUsageReportFilters(input: unknown, now = new Date()): { filters: UsageReportFilters; error?: never } | { filters?: never; error: string } {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) return { error: 'Usage filters are invalid. Use UTC calendar dates, a supported operation/status, and a limit from 1 to 100.' };
  const query = parsed.data;
  const from = query.from ? utcDate(query.from) : undefined;
  const to = query.to ? utcDate(query.to) : undefined;
  if ((query.from && !from) || (query.to && !to)) return { error: 'Usage dates must be valid UTC dates in YYYY-MM-DD format.' };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periodTo = to ?? today;
  const periodFrom = from ?? addUtcDays(periodTo, -29);
  const rangeDays = Math.floor((periodTo.valueOf() - periodFrom.valueOf()) / 86_400_000) + 1;
  if (periodFrom > periodTo) return { error: '`from` must be the same date or earlier than `to`.' };
  if (rangeDays > 366) return { error: 'Usage date ranges are limited to 366 UTC calendar days.' };
  if (query.cursor && !decodeUsageCursor(query.cursor)) return { error: 'The usage pagination cursor is invalid.' };
  return { filters: {
    ...(query.provider ? { provider: query.provider } : {}), ...(query.model ? { model: query.model } : {}),
    ...(query.operation ? { operation: query.operation } : {}), ...(query.usageStatus ? { usageStatus: query.usageStatus } : {}),
    explicitRange: Boolean(query.from || query.to),
    ...(query.from || query.to ? { listFrom: periodFrom, listToExclusive: addUtcDays(periodTo, 1) } : {}),
    periodFrom, periodToExclusive: addUtcDays(periodTo, 1), limit: query.limit,
    ...(query.cursor ? { cursor: decodeUsageCursor(query.cursor)! } : {}),
  } };
}

export function usageRecordWhere(userId: string, filters: UsageReportFilters, includeCursor = false) {
  const where: Record<string, unknown> = { userId };
  if (filters.provider) where.provider = filters.provider;
  if (filters.model) where.model = filters.model;
  if (filters.operation === 'chat') where.operation = { in: ['chat', 'provider_attempt'] };
  else if (filters.operation) where.operation = filters.operation;
  if (filters.usageStatus) where.usageStatus = filters.usageStatus;
  if (filters.explicitRange) where.createdAt = { gte: filters.listFrom, lt: filters.listToExclusive };
  if (includeCursor && filters.cursor) {
    where.OR = [
      { createdAt: { lt: filters.cursor.createdAt } },
      { createdAt: filters.cursor.createdAt, id: { lt: filters.cursor.id } },
    ];
  }
  return where;
}

export function periodWhere(userId: string, filters: UsageReportFilters) {
  const where = usageRecordWhere(userId, filters, false);
  where.createdAt = { gte: filters.periodFrom, lt: filters.periodToExclusive };
  return where;
}

export type CurrencyCostGroup = { pricingCurrency: string | null; _sum: { estimatedCost: number | null }; _count: { _all: number; estimatedCost: number } };
export function roundEstimatedCost(value: number) { return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000; }
export function normalizeCurrencyCostGroups(groups: CurrencyCostGroup[]) {
  const results = new Map<string, { currency: string; estimatedCost: number; pricedRecordCount: number; unknownCostRecordCount: number }>();
  for (const group of groups) {
    const priced = group._count.estimatedCost;
    const unpriced = group._count._all - priced;
    if (priced) {
      const currency = group.pricingCurrency ?? 'USD'; // Legacy costs were explicitly USD estimates.
      const current = results.get(currency) ?? { currency, estimatedCost: 0, pricedRecordCount: 0, unknownCostRecordCount: 0 };
      current.estimatedCost += group._sum.estimatedCost ?? 0;
      current.pricedRecordCount += priced;
      results.set(currency, current);
    }
    if (unpriced) {
      const currency = group.pricingCurrency ?? 'UNKNOWN';
      const current = results.get(currency) ?? { currency, estimatedCost: 0, pricedRecordCount: 0, unknownCostRecordCount: 0 };
      current.unknownCostRecordCount += unpriced;
      results.set(currency, current);
    }
  }
  return [...results.values()].map(item => ({ ...item, estimatedCost: roundEstimatedCost(item.estimatedCost) })).sort((a, b) => a.currency.localeCompare(b.currency));
}

export function buildUsageBreakdown(rows: Array<Record<string, any>>, dimension: 'provider' | 'model' | 'operation') {
  const groups = new Map<string, { dimension: string; recordCount: number; costs: Map<string, { currency: string; estimatedCost: number; pricedRecordCount: number; unknownCostRecordCount: number }> }>();
  for (const row of rows) {
    const value = String(row[dimension]);
    const group = groups.get(value) ?? { dimension: value, recordCount: 0, costs: new Map() };
    group.recordCount += row._count._all;
    const priced = row._count.estimatedCost;
    const unpriced = row._count._all - priced;
    if (priced) {
      const currency = row.pricingCurrency ?? 'USD';
      const amount = group.costs.get(currency) ?? { currency, estimatedCost: 0, pricedRecordCount: 0, unknownCostRecordCount: 0 };
      amount.estimatedCost += row._sum.estimatedCost ?? 0;
      amount.pricedRecordCount += priced;
      group.costs.set(currency, amount);
    }
    if (unpriced) {
      const currency = row.pricingCurrency ?? 'UNKNOWN';
      const amount = group.costs.get(currency) ?? { currency, estimatedCost: 0, pricedRecordCount: 0, unknownCostRecordCount: 0 };
      amount.unknownCostRecordCount += unpriced;
      group.costs.set(currency, amount);
    }
    groups.set(value, group);
  }
  return [...groups.values()].sort((a, b) => a.dimension.localeCompare(b.dimension)).map(group => ({
    [dimension]: group.dimension, recordCount: group.recordCount,
    estimatedCostByCurrency: [...group.costs.values()].map(item => ({ ...item, estimatedCost: roundEstimatedCost(item.estimatedCost) })).sort((a, b) => a.currency.localeCompare(b.currency)),
  }));
}

export const usageReportEnums = { operations, statuses } as const;
