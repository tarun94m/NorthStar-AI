import { useEffect, useState } from 'react';

type CostBucket = { currency: string; estimatedCost: number; pricedRecordCount: number; unknownCostRecordCount: number };
type UsageRow = {
  id: string; provider: string; model: string; operation: string; usageStatus: string; estimatedCost: number | null;
  pricingCurrency: string | null; pricingVersion: string | null; pricingEffectiveAt: string | null;
  inputTokens: number | null; outputTokens: number | null; estimatedInputTokens: number | null; estimatedOutputTokens: number | null;
  attemptId: string | null; attemptNumber: number | null; errorCode: string | null; createdAt: string;
};
type Breakdown = { provider?: string; model?: string; operation?: string; recordCount: number; estimatedCostByCurrency: CostBucket[] };
type UsageData = {
  usage: UsageRow[]; totalCount: number; totalEstimatedCost: number | null; recentEstimatedCostByCurrency: Array<{ currency: string; amount: number }>;
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
  period: {
    from: string; to: string; timezone: 'UTC'; recordCount: number; requestCount: number;
    providerAttemptCount: number; failedProviderAttemptCount: number; totalEstimatedCost: number | null;
    estimatedCostByCurrency: CostBucket[];
    tokens: { providerReportedInput: number; providerReportedOutput: number; estimatedInput: number; estimatedOutput: number };
    usageStatusCounts: Record<string, number>;
    providerBreakdown: Breakdown[]; modelBreakdown: Breakdown[]; operationBreakdown: Breakdown[];
  };
};

const operationLabels: Record<string, string> = {
  chat: 'Chat', summary: 'Conversation summary', memory_extraction: 'Memory extraction', provider_attempt: 'Provider attempt',
};
const statusLabels: Record<string, string> = {
  provider_reported: 'Provider-reported', estimated: 'Estimated tokens', partial: 'Partial provider usage', unknown: 'Unknown usage', legacy: 'Legacy record',
};
function currency(amount: number, code: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 6 }).format(amount); }
  catch { return `${code} ${amount.toFixed(6)}`; }
}
function costs(buckets: CostBucket[]) {
  if (!buckets.length) return <span className="usage-unknown">No estimate recorded</span>;
  return <span className="usage-cost-list">{buckets.map(bucket => <span key={bucket.currency}>
    {bucket.currency === 'UNKNOWN' ? 'Unknown currency' : `${currency(bucket.estimatedCost, bucket.currency)} estimate`}
    {bucket.unknownCostRecordCount > 0 && <small>{bucket.unknownCostRecordCount} record{bucket.unknownCostRecordCount === 1 ? '' : 's'} with unknown amount</small>}
  </span>)}</span>;
}
function breakdownValue(title: string, row: Breakdown) {
  if (title === 'Providers') return row.provider;
  if (title === 'Models') return row.model;
  return row.operation;
}
function breakdownTable(title: string, rows: Breakdown[]) {
  return <section className="usage-breakdown"><h3>{title}</h3>{rows.length ? <table><tbody>{rows.map(row => {
    const value = breakdownValue(title, row) ?? 'Unknown';
    return <tr key={value}><th scope="row">{title === 'Operations' ? operationLabels[value] ?? value : value}</th><td>{row.recordCount} event{row.recordCount === 1 ? '' : 's'}</td><td>{costs(row.estimatedCostByCurrency)}</td></tr>;
  })}</tbody></table> : <p className="usage-empty-small">No usage in this period.</p>}</section>;
}
function utcDayOffset(day: string, offset: number) {
  const value = new Date(`${day}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10);
}

export default function UsageDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(utcDayOffset(today, -29));
  const [to, setTo] = useState(today);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [operation, setOperation] = useState('');
  const [usageStatus, setUsageStatus] = useState('');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const cursor = cursorStack.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ from, to, limit: '25' });
    if (provider) query.set('provider', provider);
    if (model) query.set('model', model);
    if (operation) query.set('operation', operation);
    if (usageStatus) query.set('usageStatus', usageStatus);
    if (cursor) query.set('cursor', cursor);
    setLoading(true); setError('');
    fetch(`/api/usage?${query.toString()}`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Usage request failed (${response.status}).`);
        return result as UsageData;
      })
      .then(setData).catch((reason: unknown) => { if ((reason as Error).name !== 'AbortError') setError((reason as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [from, to, provider, model, operation, usageStatus, cursor]);

  const resetFilters = () => { setFrom(utcDayOffset(today, -29)); setTo(today); setProvider(''); setModel(''); setOperation(''); setUsageStatus(''); setCursorStack([]); };
  const period = data?.period;
  const currencyTotal = period?.totalEstimatedCost;
  const periodCurrency = period?.estimatedCostByCurrency.find(item => item.currency !== 'UNKNOWN' && item.pricedRecordCount > 0)?.currency ?? 'USD';
  const unknownCostCount = period?.estimatedCostByCurrency.reduce((sum, item) => sum + item.unknownCostRecordCount, 0) ?? 0;

  return <section className="usage-dashboard" aria-label="Usage and cost dashboard">
    <div className="usage-heading"><div><p className="eyebrow">PERSONAL USAGE</p><h1>Usage &amp; cost</h1><p>Estimated costs are based on the saved pricing snapshot. They are not provider bills or invoices.</p></div><button type="button" onClick={resetFilters}>Last 30 UTC days</button></div>
    <div className="usage-filters" aria-label="Usage filters">
      <label>From (UTC)<input aria-label="Usage start date" type="date" value={from} onChange={event => { setFrom(event.target.value); setCursorStack([]); }}/></label>
      <label>To (UTC)<input aria-label="Usage end date" type="date" value={to} onChange={event => { setTo(event.target.value); setCursorStack([]); }}/></label>
      <label>Provider<select aria-label="Filter provider" value={provider} onChange={event => { setProvider(event.target.value); setCursorStack([]); }}><option value="">All providers</option>{(period?.providerBreakdown ?? []).map(row => <option key={row.provider} value={row.provider}>{row.provider}</option>)}</select></label>
      <label>Model<select aria-label="Filter model" value={model} onChange={event => { setModel(event.target.value); setCursorStack([]); }}><option value="">All models</option>{(period?.modelBreakdown ?? []).map(row => <option key={row.model} value={row.model}>{row.model}</option>)}</select></label>
      <label>Operation<select aria-label="Filter operation" value={operation} onChange={event => { setOperation(event.target.value); setCursorStack([]); }}><option value="">All operations</option>{Object.entries(operationLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>Usage status<select aria-label="Filter usage status" value={usageStatus} onChange={event => { setUsageStatus(event.target.value); setCursorStack([]); }}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    </div>
    {error && <div className="usage-error" role="alert">{error}</div>}
    {loading && <p className="usage-loading" role="status">Loading usage…</p>}
    {period && <>
      <div className="usage-period-note">{period.from} – {period.to} UTC · totals cover the selected period and filters.</div>
      <div className="usage-stats">
        <article><small>ESTIMATED AI COST</small><strong>{period.recordCount === 0 ? 'No usage recorded' : currencyTotal == null ? (period.estimatedCostByCurrency.filter(item => item.pricedRecordCount > 0).length > 1 ? 'Multiple currencies' : 'Unknown total') : currency(currencyTotal, periodCurrency)}</strong><span>{period.estimatedCostByCurrency.length ? costs(period.estimatedCostByCurrency) : 'No usage recorded'}</span>{unknownCostCount > 0 && <small>Some records have unknown cost.</small>}</article>
        <article><small>REQUESTS</small><strong>{period.requestCount.toLocaleString()}</strong><span>{period.providerAttemptCount} provider attempts · {period.failedProviderAttemptCount} failed attempts</span></article>
        <article><small>PROVIDER-REPORTED TOKENS</small><strong>{(period.tokens.providerReportedInput + period.tokens.providerReportedOutput).toLocaleString()}</strong><span>{period.tokens.providerReportedInput.toLocaleString()} input · {period.tokens.providerReportedOutput.toLocaleString()} output</span></article>
        <article><small>ESTIMATED TOKENS</small><strong>{(period.tokens.estimatedInput + period.tokens.estimatedOutput).toLocaleString()}</strong><span>{period.tokens.estimatedInput.toLocaleString()} input · {period.tokens.estimatedOutput.toLocaleString()} output</span></article>
      </div>
      <div className="usage-breakdown-grid">
        {breakdownTable('Providers', period.providerBreakdown)}
        {breakdownTable('Models', period.modelBreakdown)}
        {breakdownTable('Operations', period.operationBreakdown)}
      </div>
      <section className="usage-history"><div className="usage-history-heading"><div><h2>Usage history</h2><p>{data?.totalCount.toLocaleString()} matching events · estimates use the row’s recorded pricing snapshot.</p></div><span>{period.usageStatusCounts.unknown ?? 0} unknown · {period.usageStatusCounts.partial ?? 0} partial usage records</span></div>
        <div className="usage-table-scroll"><table><thead><tr><th>Date (UTC)</th><th>Operation</th><th>Provider / model</th><th>Tokens</th><th>Cost</th><th>Status / attempts</th></tr></thead><tbody>
          {(data?.usage ?? []).map(row => <tr key={row.id}>
            <td>{new Date(row.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</td>
            <td>{operationLabels[row.operation] ?? row.operation}</td>
            <td>{row.provider}<small>{row.model}</small></td>
            <td><span>{row.inputTokens ?? '—'} in · {row.outputTokens ?? '—'} out</span><small>{row.estimatedInputTokens !== null || row.estimatedOutputTokens !== null ? `${row.estimatedInputTokens ?? '—'} estimated in · ${row.estimatedOutputTokens ?? '—'} estimated out` : statusLabels[row.usageStatus] ?? row.usageStatus}</small></td>
            <td>{row.estimatedCost === null ? <span className="usage-unknown">Unknown</span> : <>{currency(row.estimatedCost, row.pricingCurrency ?? 'USD')}<small>estimate</small></>}</td>
            <td><span className={`usage-status status-${row.usageStatus}`}>{statusLabels[row.usageStatus] ?? row.usageStatus}</span>{row.attemptNumber !== null && <small>Attempt {row.attemptNumber}{row.errorCode ? ` · ${row.errorCode}` : ''}</small>}{row.pricingVersion && <small title={row.pricingEffectiveAt ? `Pricing active since ${new Date(row.pricingEffectiveAt).toISOString()}` : undefined}>Pricing {row.pricingVersion}</small>}</td>
          </tr>)}
        </tbody></table></div>
        {!data?.usage.length && !loading && <p className="usage-empty">No usage records match this range and these filters.</p>}
        <div className="usage-pagination"><button type="button" disabled={cursorStack.length === 0 || loading} onClick={() => setCursorStack(stack => stack.slice(0, -1))}>Previous</button><span>Page {cursorStack.length + 1}</span><button type="button" disabled={!data?.pagination.hasMore || loading} onClick={() => { if (data?.pagination.nextCursor) setCursorStack(stack => [...stack, data.pagination.nextCursor!]); }}>Next</button></div>
      </section>
    </>}
  </section>;
}
