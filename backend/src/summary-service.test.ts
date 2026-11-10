import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryProviderError, SummaryService, redactCredentials, toCompleteTurns, type SummarySourceMessage } from './summary-service.js';
import type { AIProvider, GenerationRequest } from './ai.js';
import type { ModelDefinition } from './model-registry.js';

const model: ModelDefinition = {
  id: 'test:model', providerId: 'test', providerModelId: 'test-model', displayName: 'Test model', description: '', enabled: true, configured: true,
  capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 5000, maxOutputTokens: 1000,
  tokenizer: 'conservative_utf8_approximation', parameters: {},
};
const jsonSummary = (context = 'kept'): string => JSON.stringify({ facts: ['fact'], decisions: [], requirements: ['requirement'], openQuestions: ['open question'], context: [context] });
const request = (input: GenerationRequest['input'][number][], signal = new AbortController().signal): GenerationRequest => ({ input, modelId: model.id, providerModelId: model.providerModelId, parameters: { maxOutputTokens: 500 }, signal, systemInstructions: '' });
const msg = (id: string, role: 'user' | 'assistant', content: string, sequence: number): SummarySourceMessage => ({ id, role, content, sequence });

test('summary generation preserves required sections and accumulates provider usage', async () => {
  const calls: GenerationRequest[] = [];
  const provider: AIProvider = {
    id: 'test', async stream() { throw new Error('unused'); },
    async countInputTokens(req) { return Math.ceil(req.input.reduce((n, item) => n + item.content.length, 0) / 4) + 30; },
    async generate(req) { calls.push(req); return { text: jsonSummary('important context'), usage: { inputTokens: 31, outputTokens: 17 } }; },
  };
  const result = await new SummaryService(model, provider, 500).summarize('', [[msg('u1','user','Question',1), msg('a1','assistant','Answer',2)]], new AbortController().signal);
  assert.match(result.summaryText, /Facts:[\s\S]*fact/);
  assert.match(result.summaryText, /Requirements:[\s\S]*requirement/);
  assert.equal(result.usage.inputTokens, 31);
  assert.equal(result.usage.outputTokens, 17);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.systemInstructions ?? '', /untrusted reference data/);
});

test('summary usage preserves estimated provenance from providers without usage metadata', async () => {
  const provider: AIProvider = {
    id: 'test', async stream() { throw new Error('unused'); },
    async generate() { return { text: jsonSummary(), usage: { inputTokens: 31, outputTokens: 17, source: 'estimated' as const } }; },
  };
  const result = await new SummaryService(model, provider, 500).summarize('', [[msg('u1','user','Question',1), msg('a1','assistant','Answer',2)]], new AbortController().signal);
  assert.equal(result.usage.inputTokens, 31);
  assert.equal(result.usage.outputTokens, 17);
  assert.equal(result.usage.source, 'estimated');
});

test('oversized messages are chunked without silently dropping transcript characters', async () => {
  const pieces: string[] = [];
  const provider: AIProvider = {
    id: 'test', async stream() { throw new Error('unused'); },
    async countInputTokens(req) { return Math.ceil(req.input.reduce((n, item) => n + item.content.length, 0) / 3) + 80; },
    async generate(req) {
      const raw = req.input[0]!.content.split('Transcript messages (sequence and role are metadata):\n')[1]!;
      const rows = JSON.parse(raw) as Array<{ content: string }>;
      pieces.push(...rows.map(row => row.content));
      return { text: jsonSummary(`chunk-${pieces.length}`), usage: { inputTokens: 10, outputTokens: 4 } };
    },
  };
  const long = 'all transcript detail must be processed. '.repeat(180);
  const service = new SummaryService({ ...model, contextWindow: 1400 }, provider, 200);
  const result = await service.summarize('', [[msg('u1','user',long,1), msg('a1','assistant','ok',2)]], new AbortController().signal);
  assert.ok(pieces.length > 1, 'the long turn should require multiple bounded provider requests');
  assert.equal(pieces.filter(part => part !== 'ok').join(''), long);
  assert.ok(result.usage.inputTokens > 10);
  assert.match(result.summaryText, /Context:/);
});

test('malformed provider output fails closed with a retryable summary error', async () => {
  const provider: AIProvider = { id: 'test', async stream() { throw new Error('unused'); }, async generate() { return { text: 'not JSON', usage: { inputTokens: 3, outputTokens: 2 } }; } };
  await assert.rejects(() => new SummaryService(model, provider, 500).summarize('', [[msg('u','user','hello',1), msg('a','assistant','reply',2)]], new AbortController().signal),
    (error: unknown) => error instanceof SummaryProviderError && error.code === 'SUMMARY_MALFORMED');
});

test('summary generation respects abort signals', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const provider: AIProvider = { id: 'test', async stream() { throw new Error('unused'); }, async generate() { throw new Error('must not call provider'); } };
  await assert.rejects(() => new SummaryService(model, provider, 500).summarize('', [[msg('u','user','hello',1), msg('a','assistant','reply',2)]], controller.signal),
    (error: unknown) => error instanceof SummaryProviderError && error.code === 'SUMMARY_CANCELLED');
});

test('credential-like content is redacted and incomplete turns are not summarized', () => {
  assert.equal(redactCredentials('Use key sk-abcdefghijklmnopqrstuvwxyz123456 and password=super-secret-value'), 'Use key [REDACTED CREDENTIAL] and [REDACTED CREDENTIAL]');
  assert.equal(redactCredentials('The password is hunter2 and the API key: abcdefghijklmnopqrstuvwxyz'), 'The [REDACTED CREDENTIAL] and the [REDACTED CREDENTIAL]');
  assert.equal(redactCredentials('Google key AIza123456789012345678901234567890123 and AWS AKIA1234567890ABCDEF'), 'Google key [REDACTED CREDENTIAL] and AWS [REDACTED CREDENTIAL]');
  const turns = toCompleteTurns([msg('u1','user','incomplete',1), msg('u2','user','complete',2), msg('a2','assistant','answer',3)]);
  assert.deepEqual(turns.map(turn => turn.map(message => message.id)), [['u2','a2']]);
});
