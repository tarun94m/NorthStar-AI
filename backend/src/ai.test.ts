import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'phase-one-test-secret-with-at-least-32-characters';
const { MockProvider, OpenAIProvider, GeminiProvider, ProviderRegistry, ProviderError } = await import('./ai.js');
const { modelRegistry, ModelRegistry, ModelResolutionError, estimateCost } = await import('./model-registry.js');
const req = (providerModelId: string, input = [{ role: 'user' as const, content: 'Hi' }], signal = new AbortController().signal) => ({ input, modelId: `${providerModelId}:id`, providerModelId, parameters: {}, signal });

test('catalog definitions contain provider identity, limits, capabilities, and constrained parameters', () => {
  const models = modelRegistry.all();
  assert.deepEqual(models.map(m => m.id), ['openai:gpt-4.1-mini', 'openai:gpt-4.1', 'gemini:gemini-3.8-flash', 'mock:echo']);
  for (const model of models) {
    assert.ok(model.providerModelId && model.displayName && model.description);
    assert.ok(model.contextWindow > 0 && model.maxOutputTokens > 0);
    assert.equal(model.capabilities.streaming, true);
    if (model.providerId === 'openai') assert.ok(model.parameters.temperature.min === 0 && model.parameters.temperature.max === 2);
  }
  assert.equal(models.find(m => m.id === 'gemini:gemini-3.8-flash')?.contextWindow, 1_048_576);
  assert.equal(models.find(m => m.id === 'openai:gpt-4.1-mini')?.tokenizer, 'openai_o200k_base');
  assert.equal(models.find(m => m.id === 'gemini:gemini-3.8-flash')?.tokenizer, 'provider_count_tokens');
  assert.equal(models.find(m => m.id === 'gemini:gemini-3.8-flash')?.parameters.temperature, undefined);
  assert.equal(models.find(m => m.id === 'mock:echo')?.tokenizer, 'conservative_utf8_approximation');
});

test('model registry distinguishes unknown, unavailable, disabled, and unsupported parameters', () => {
  assert.throws(() => modelRegistry.resolve('provider:unknown'), (e: unknown) => e instanceof ModelResolutionError && e.code === 'MODEL_NOT_FOUND');
  const custom = new ModelRegistry([{ ...modelRegistry.all()[0]!, enabled: true, configured: false }]);
  assert.throws(() => custom.resolve('openai:gpt-4.1-mini'), (e: unknown) => e instanceof ModelResolutionError && e.code === 'MODEL_UNAVAILABLE');
  const ready = new ModelRegistry([{ ...modelRegistry.all()[0]!, configured: true }]);
  assert.throws(() => ready.resolve('openai:gpt-4.1-mini', { topK: 8 }), (e: unknown) => e instanceof ModelResolutionError && e.code === 'UNSUPPORTED_PARAMETER');
  assert.throws(() => ready.resolve('openai:gpt-4.1-mini', { temperature: 3 }), (e: unknown) => e instanceof ModelResolutionError && e.code === 'UNSUPPORTED_PARAMETER');
  assert.equal(ready.resolve('openai:gpt-4.1-mini', { temperature: 1.2 }).providerModelId, 'gpt-4.1-mini');
  const readyGemini = new ModelRegistry([{ ...modelRegistry.all().find(model => model.id === 'gemini:gemini-3.8-flash')!, configured: true }]);
  assert.throws(() => readyGemini.resolve('gemini:gemini-3.8-flash', { temperature: 0.7 }), (e: unknown) => e instanceof ModelResolutionError && e.code === 'UNSUPPORTED_PARAMETER');
  const geminiCost = estimateCost('gemini:gemini-3.8-flash', 1000, 1000); assert.ok(geminiCost !== null && geminiCost > 0);
});

test('pricing snapshots retain explicit versions and historical estimates after rates change', () => {
  const source = modelRegistry.all().find(model => model.id === 'openai:gpt-4.1-mini')!;
  const originalModel = { ...source, pricing: { inputPerMillion: 2, outputPerMillion: 6, currency: 'USD', version: 'fixture-v1-rate-a', effectiveAt: '2026-01-01T00:00:00.000Z' } };
  const originalRegistry = new ModelRegistry([originalModel]);
  const originalSnapshot = originalRegistry.getPricingSnapshot(originalModel.id);
  const originalCost = originalRegistry.estimateCost(originalModel.id, 1000, 1000);
  const changedModel = { ...originalModel, pricing: { inputPerMillion: 4, outputPerMillion: 8, currency: 'USD', version: 'fixture-v2-rate-b', effectiveAt: '2026-11-10T00:00:00.000Z' } };
  const changedRegistry = new ModelRegistry([changedModel]);
  assert.equal(originalCost, 0.008);
  assert.notEqual(changedRegistry.estimateCost(changedModel.id, 1000, 1000), originalCost);
  assert.equal(originalSnapshot.pricingVersion, 'fixture-v1-rate-a');
  assert.equal(originalSnapshot.pricingEffectiveAt.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(changedRegistry.getPricingSnapshot(changedModel.id), {
    pricingCurrency: 'USD', pricingVersion: 'fixture-v2-rate-b', pricingEffectiveAt: new Date('2026-11-10T00:00:00.000Z'),
  });
});

test('provider registry resolves explicitly and rejects unavailable providers', () => {
  const mock = new MockProvider(); const registry = new ProviderRegistry(new Map([['mock', mock]]));
  assert.equal(registry.resolve('mock'), mock);
  assert.throws(() => registry.resolve('gemini'), (e: unknown) => e instanceof ProviderError && e.code === 'PROVIDER_CONFIGURATION');
});

test('mock provider streams marked development fallback output, usage, and cancellation', async () => {
  const generation = await new MockProvider().stream(req('echo'));
  let result = ''; for await (const chunk of generation.chunks) result += chunk;
  assert.match(result, /local mock response/); assert.match(result, /Hi/);
  const usage = await generation.usage; assert.ok(typeof usage.inputTokens === 'number' && usage.inputTokens > 0 && typeof usage.outputTokens === 'number' && usage.outputTokens > 0); assert.equal(usage.source, 'estimated');
  const controller = new AbortController(); controller.abort();
  const stopped = await new MockProvider().stream(req('echo', undefined, controller.signal));
  let text = ''; for await (const chunk of stopped.chunks) text += chunk;
  assert.equal(text, '');
});

test('OpenAI Responses streaming forwards supported options and normalizes deltas and usage', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'Hello ' }, { type: 'response.output_text.delta', delta: 'world' },
    { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4 } } },
  ];
  const controller = new AbortController();
  let sentBody: any; let sentOptions: any;
  const fakeClient = { responses: { create: async (body: any, options: any) => {
    sentBody = body; sentOptions = options;
    return (async function* () { yield* events; })();
  } } };
  const generation = await new OpenAIProvider(fakeClient as any).stream({ ...req('gpt-4.1-mini', undefined, controller.signal), parameters: { temperature: 0.4, topP: 0.8 }, systemInstructions: 'Be useful.', responsePreferences: 'Use bullets.' });
  assert.equal(sentBody.stream, true); assert.equal(sentBody.model, 'gpt-4.1-mini');
  assert.equal(sentBody.temperature, 0.4); assert.equal(sentBody.top_p, 0.8); assert.equal(sentOptions.signal, controller.signal);
  assert.equal(sentBody.instructions, 'Be useful.\n\nResponse preferences:\nUse bullets.');
  let text = ''; for await (const chunk of generation.chunks) text += chunk;
  assert.equal(text, 'Hello world'); assert.deepEqual(await generation.usage, { inputTokens: 12, outputTokens: 4 });
});

test('OpenAI rejects provider failure and missing completion while retaining partial deltas', async () => {
  for (const events of [[{ type: 'error' }], [{ type: 'response.output_text.delta', delta: 'partial' }]]) {
    const fakeClient = { responses: { create: async () => (async function* () { yield* events; })() } };
    const generation = await new OpenAIProvider(fakeClient as any).stream(req('gpt-4.1-mini'));
    let partial = ''; await assert.rejects(async () => { for await (const chunk of generation.chunks) partial += chunk; });
    assert.deepEqual(await generation.usage, {});
    if (events[0]?.type === 'response.output_text.delta') assert.equal(partial, 'partial');
  }
});

test('OpenAI classifies retryable stream error codes even when the event has no HTTP status', async () => {
  const fakeClient = { responses: { create: async () => (async function* () {
    yield { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } };
  })() } };
  const generation = await new OpenAIProvider(fakeClient as any).stream(req('gpt-4.1-mini'));
  await assert.rejects(async () => { for await (const _chunk of generation.chunks) { /* drain */ } },
    (error: unknown) => error instanceof ProviderError && error.retryable);
});

test('OpenAI non-streaming generation normalizes response text and usage', async () => {
  const fakeClient = { responses: { create: async (body: any) => {
    assert.equal(body.model, 'gpt-4.1-mini');
    return { output_text: 'complete', usage: { input_tokens: 8, output_tokens: 3 } };
  } } };
  assert.deepEqual(await new OpenAIProvider(fakeClient as any).generate(req('gpt-4.1-mini')), { text: 'complete', usage: { inputTokens: 8, outputTokens: 3, source: 'provider_reported' } });
});

test('Gemini streaming maps roles, deltas, final usage, and finish reason', async () => {
  const streamed: any[] = [];
  const fakeClient = {
    generateContentStream: async (params: any) => {
      streamed.push(params);
      return (async function* () {
        yield { text: 'Gemini ' };
        yield { text: 'reply', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 }, candidates: [{ finishReason: 'STOP' }] };
      })();
    },
    generateContent: async () => ({ text: 'One-shot', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 }, candidates: [{ finishReason: 'STOP' }] }),
  };
  const generation = await new GeminiProvider(fakeClient as any).stream({ ...req('gemini-3.8-flash'), input: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }] });
  let text = ''; for await (const chunk of generation.chunks) text += chunk;
  assert.equal(text, 'Gemini reply'); assert.deepEqual(await generation.usage, { inputTokens: 7, outputTokens: 2 });
  assert.deepEqual(streamed[0].contents.map((item: any) => item.role), ['user', 'model']);
  assert.equal('temperature' in streamed[0].config, false); assert.equal('topP' in streamed[0].config, false);
  assert.equal((await new GeminiProvider(fakeClient as any).generate(req('gemini-3.8-flash'))).text, 'One-shot');
});

test('Gemini rejects parameters the selected model no longer supports instead of silently omitting them', async () => {
  const provider = new GeminiProvider({
    generateContentStream: async () => (async function* () {})(),
    generateContent: async () => ({ text: 'must not call', candidates: [{ finishReason: 'STOP' }] }),
  } as any);
  await assert.rejects(() => provider.generate({ ...req('gemini-3.8-flash'), parameters: { temperature: 0.7 } }),
    (error: unknown) => error instanceof ProviderError && error.code === 'UNSUPPORTED_PARAMETER' && error.httpStatus === 400);
});

test('Gemini errors, cancellation, and incomplete stream are normalized', async () => {
  const failing = new GeminiProvider({ generateContentStream: async () => (async function* () { throw new Error('secret provider detail'); })(), generateContent: async () => { throw new Error('failed'); } } as any);
  const generation = await failing.stream(req('gemini-3.8-flash'));
  await assert.rejects(async () => { for await (const _chunk of generation.chunks) { /* drain */ } }, (e: unknown) => e instanceof ProviderError && e.code === 'PROVIDER_FAILURE');
  assert.deepEqual(await generation.usage, {});
  const incomplete = new GeminiProvider({ generateContentStream: async () => (async function* () { yield { text: 'partial' }; })(), generateContent: async () => ({}) } as any);
  await assert.rejects(async () => { for await (const _chunk of (await incomplete.stream(req('gemini-3.8-flash'))).chunks) { /* drain */ } }, (e: unknown) => e instanceof ProviderError && e.code === 'PROVIDER_INCOMPLETE');
  const controller = new AbortController(); controller.abort(new Error('Provider timeout'));
  const cancelled = new GeminiProvider({ generateContentStream: async () => { throw new Error('abort'); }, generateContent: async () => ({}) } as any);
  await assert.rejects(() => cancelled.stream(req('gemini-3.8-flash', undefined, controller.signal)), (e: unknown) => e instanceof ProviderError && e.code === 'PROVIDER_TIMEOUT');
});

test('provider errors classify retryable HTTP/network failures without exposing provider details', async () => {
  const tooMany = Object.assign(new Error('sensitive upstream body'), { status: 429 });
  const provider429 = new OpenAIProvider({ responses: { create: async () => { throw tooMany; } } } as any);
  await assert.rejects(() => provider429.stream(req('gpt-4.1-mini')), (error: unknown) => error instanceof ProviderError && error.retryable && error.httpStatus === 503 && !error.message.includes('sensitive'));
  const authError = Object.assign(new Error('credential detail'), { status: 401 });
  const provider401 = new OpenAIProvider({ responses: { create: async () => { throw authError; } } } as any);
  await assert.rejects(() => provider401.stream(req('gpt-4.1-mini')), (error: unknown) => error instanceof ProviderError && !error.retryable && error.httpStatus === 502);
  const networkError = Object.assign(new Error('socket detail'), { code: 'ECONNRESET' });
  const providerNetwork = new OpenAIProvider({ responses: { create: async () => { throw networkError; } } } as any);
  await assert.rejects(() => providerNetwork.stream(req('gpt-4.1-mini')), (error: unknown) => error instanceof ProviderError && error.retryable);
});

test('Gemini context token counting forwards system instructions, preferences, and abort signal', async () => {
  const controller = new AbortController(); let params: any;
  const client = { generateContentStream: async () => (async function* () {})(), generateContent: async () => ({}), countTokens: async (input: any) => { params = input; return { totalTokens: 42 }; } };
  const count = await new GeminiProvider(client as any).countInputTokens!({ input: [{ role: 'user', content: 'hello' }], providerModelId: 'gemini-3.8-flash', signal: controller.signal, systemInstructions: 'System.', responsePreferences: 'Short.' });
  assert.equal(count, 42); assert.equal(params.model, 'gemini-3.8-flash');
  assert.match(params.config.systemInstruction, /Response preferences:\nShort\./);
  assert.equal(params.config.abortSignal, controller.signal);
});
