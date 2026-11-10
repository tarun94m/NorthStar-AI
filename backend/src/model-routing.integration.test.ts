import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, pool } from './db.js';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { ModelRegistry, type ModelDefinition } from './model-registry.js';
import { ProviderError, ProviderRegistry, type AIProvider } from './ai.js';

after(async () => { await prisma.$disconnect(); await pool.end(); });

const definition = (id: string, providerId: string): ModelDefinition => ({
  id, providerId, providerModelId: id.split(':')[1]!, displayName: id, description: id,
  enabled: true, configured: true, capabilities: { streaming: true, nonStreaming: true, text: true, imageInput: false, webSearch: false, documentInput: false, structuredOutput: false, toolCalling: false },
  contextWindow: 50_000, maxOutputTokens: 2_000, tokenizer: 'conservative_utf8_approximation',
  parameters: providerId === 'gemini' ? {} : { temperature: { type: 'number', min: 0, max: 2 } },
});
async function fixture() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@router.test`, settings: { create: { selectionMode: 'AUTO' } } } });
  const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 120_000) } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, selectionMode: 'AUTO' } });
  return { user, conversation, cookie: `session=${createToken({ id: user.id, guest: false }, session.id)}` };
}
async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
const json = (value: unknown) => JSON.stringify(value);
const realMemoryStores = () => import('express-rate-limit').then(({ MemoryStore }) => ({ api: new MemoryStore(), guestCreation: new MemoryStore() }));
const replyProvider = (id: string, text: string, usage: { inputTokens: number; outputTokens: number }): AIProvider => ({
  id,
  async generate() { return { text, usage }; },
  async stream() { return { chunks: (async function* () { yield text; })(), usage: Promise.resolve(usage) }; },
});

test('Auto retries a retryable pre-delta provider failure, accounts unknown failed usage, and attributes the actual response', async () => {
  const owner = await fixture(); let openaiCalls = 0; let geminiCalls = 0;
  const openai: AIProvider = { id: 'openai', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream() { openaiCalls++; throw new ProviderError('PROVIDER_FAILURE', 'safe upstream error', true, 503); } };
  const gemini = replyProvider('gemini', 'fallback response', { inputTokens: 18, outputTokens: 4 });
  const wrappedGemini: AIProvider = { ...gemini, async stream(request) { geminiCalls++; return gemini.stream(request); } };
  const registry = new ModelRegistry([definition('openai:gpt-4.1-mini', 'openai'), definition('gemini:gemini-3.8-flash', 'gemini')]);
  const server = await listen(createApp(prisma, { providers: new ProviderRegistry(new Map([['openai', openai], ['gemini', wrappedGemini]])), models: registry, rateLimitStores: await realMemoryStores() }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ conversationId: owner.conversation.id, selectionMode: 'AUTO', content: 'debug this function' }) });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"provider":"gemini"/); assert.match(body, /"fallbackOccurred":true/); assert.match(body, /"routingReasonCode":"retryable_provider_failure"/);
    assert.equal(openaiCalls, 1); assert.equal(geminiCalls, 1);
    const assistant = await prisma.message.findFirst({ where: { conversationId: owner.conversation.id, role: 'assistant' } });
    assert.equal(assistant?.provider, 'gemini'); assert.equal(assistant?.model, 'gemini-3.8-flash'); assert.equal(assistant?.requestedSelectionMode, 'AUTO');
    assert.equal(assistant?.taskType, 'coding'); assert.equal(assistant?.routingReasonCode, 'retryable_provider_failure');
    const usage = await prisma.usageRecord.findMany({ where: { userId: owner.user.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(usage.length, 2);
    const failed = usage.find(item => item.operation === 'provider_attempt');
    const completed = usage.find(item => item.operation === 'chat');
    assert.ok(failed?.attemptId); assert.ok(completed?.attemptId); assert.notEqual(failed?.attemptId, completed?.attemptId);
    assert.equal(failed?.usageStatus, 'unknown'); assert.equal(failed?.inputTokens, null); assert.equal(failed?.outputTokens, null); assert.equal(failed?.estimatedCost, null);
    assert.equal(failed?.errorCode, 'PROVIDER_FAILURE');
    assert.equal(completed?.usageStatus, 'provider_reported'); assert.equal(completed?.inputTokens, 18); assert.equal(completed?.outputTokens, 4);
  } finally { await server.close(); await prisma.user.delete({ where: { id: owner.user.id } }); }
});

test('Manual mode never retries another provider after a retryable error', async () => {
  const owner = await fixture(); let openaiCalls = 0; let geminiCalls = 0;
  const openai: AIProvider = { id: 'openai', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream() { openaiCalls++; throw new ProviderError('PROVIDER_FAILURE', 'safe upstream error', true, 503); } };
  const gemini = replyProvider('gemini', 'must not run', { inputTokens: 1, outputTokens: 1 });
  const wrappedGemini: AIProvider = { ...gemini, async stream(request) { geminiCalls++; return gemini.stream(request); } };
  const server = await listen(createApp(prisma, { providers: new ProviderRegistry(new Map([['openai', openai], ['gemini', wrappedGemini]])), models: new ModelRegistry([definition('openai:gpt-4.1-mini', 'openai'), definition('gemini:gemini-3.8-flash', 'gemini')]), rateLimitStores: await realMemoryStores() }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ conversationId: owner.conversation.id, selectionMode: 'MANUAL', modelId: 'openai:gpt-4.1-mini', content: 'plain request' }) });
    const errorBody = await response.json() as any;
    assert.equal(response.status, 503, JSON.stringify(errorBody)); assert.equal(errorBody.code, 'PROVIDER_FAILURE');
    assert.equal(openaiCalls, 1); assert.equal(geminiCalls, 0);
    const attempt = await prisma.usageRecord.findFirst({ where: { userId: owner.user.id, operation: 'provider_attempt' } });
    assert.equal(attempt?.usageStatus, 'unknown'); assert.equal(attempt?.inputTokens, null); assert.equal(attempt?.outputTokens, null);
  } finally { await server.close(); await prisma.user.delete({ where: { id: owner.user.id } }); }
});

test('Auto does not retry a non-retryable provider error', async () => {
  const owner = await fixture(); let openaiCalls = 0; let geminiCalls = 0;
  const openai: AIProvider = { id: 'openai', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream() { openaiCalls++; throw new ProviderError('PROVIDER_FAILURE', 'non-retryable provider failure', false, 502); } };
  const gemini = replyProvider('gemini', 'must not run', { inputTokens: 1, outputTokens: 1 });
  const wrappedGemini: AIProvider = { ...gemini, async stream(request) { geminiCalls++; return gemini.stream(request); } };
  const server = await listen(createApp(prisma, { providers: new ProviderRegistry(new Map([['openai', openai], ['gemini', wrappedGemini]])), models: new ModelRegistry([definition('openai:gpt-4.1-mini', 'openai'), definition('gemini:gemini-3.8-flash', 'gemini')]), rateLimitStores: await realMemoryStores() }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ conversationId: owner.conversation.id, selectionMode: 'AUTO', content: 'plain request' }) });
    assert.equal(response.status, 502); assert.equal((await response.json() as any).code, 'PROVIDER_FAILURE');
    assert.equal(openaiCalls, 1); assert.equal(geminiCalls, 0);
    const attempt = await prisma.usageRecord.findFirst({ where: { userId: owner.user.id, operation: 'provider_attempt' } });
    assert.equal(attempt?.usageStatus, 'unknown'); assert.equal(attempt?.inputTokens, null); assert.equal(attempt?.outputTokens, null);
  } finally { await server.close(); await prisma.user.delete({ where: { id: owner.user.id } }); }
});

test('Auto does not switch after the first text delta and accounts the partial attempt', async () => {
  const owner = await fixture(); let openaiCalls = 0; let geminiCalls = 0;
  const openai: AIProvider = { id: 'openai', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream() {
    openaiCalls++;
    return { chunks: (async function* () { yield 'partial answer'; throw new ProviderError('PROVIDER_FAILURE', 'late retryable failure', true, 503); })(), usage: Promise.resolve({ inputTokens: 10, outputTokens: 2 }) };
  } };
  const gemini = replyProvider('gemini', 'must not be mixed in', { inputTokens: 1, outputTokens: 1 });
  const wrappedGemini: AIProvider = { ...gemini, async stream(request) { geminiCalls++; return gemini.stream(request); } };
  const server = await listen(createApp(prisma, { providers: new ProviderRegistry(new Map([['openai', openai], ['gemini', wrappedGemini]])), models: new ModelRegistry([definition('openai:gpt-4.1-mini', 'openai'), definition('gemini:gemini-3.8-flash', 'gemini')]), rateLimitStores: await realMemoryStores() }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ conversationId: owner.conversation.id, selectionMode: 'AUTO', taskType: 'coding', content: 'debug this function' }) });
    assert.equal(response.status, 200);
    const body = await response.text(); assert.match(body, /event: delta\ndata: \{"text":"partial answer"\}/); assert.match(body, /event: error/); assert.equal(body.includes('must not be mixed in'), false);
    assert.equal(openaiCalls, 1); assert.equal(geminiCalls, 0);
    const assistant = await prisma.message.findFirst({ where: { conversationId: owner.conversation.id, role: 'assistant' } });
    assert.equal(assistant?.content, 'partial answer'); assert.equal(assistant?.status, 'partial'); assert.equal(assistant?.provider, 'openai');
    const attempt = await prisma.usageRecord.findFirst({ where: { userId: owner.user.id, operation: 'provider_attempt' } });
    assert.equal(attempt?.usageStatus, 'provider_reported'); assert.equal(attempt?.inputTokens, 10); assert.equal(attempt?.outputTokens, 2);
  } finally { await server.close(); await prisma.user.delete({ where: { id: owner.user.id } }); }
});

test('a new Auto account can use Gemini provider defaults when Gemini is the only configured model', async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@router.test`, settings: { create: { selectionMode: 'AUTO' } } } });
  const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 120_000) } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, selectionMode: 'AUTO' } });
  const cookie = `session=${createToken({ id: user.id, guest: false }, session.id)}`;
  let receivedParameters: unknown;
  const gemini: AIProvider = { id: 'gemini', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream(request) {
    receivedParameters = request.parameters;
    return { chunks: (async function* () { yield 'Gemini response'; })(), usage: Promise.resolve({ inputTokens: 12, outputTokens: 3 }) };
  } };
  const server = await listen(createApp(prisma, { providers: new ProviderRegistry(new Map([['gemini', gemini]])), models: new ModelRegistry([definition('gemini:gemini-3.8-flash', 'gemini')]), rateLimitStores: await realMemoryStores() }));
  try {
    const accountSettings = await prisma.userSettings.findUnique({ where: { userId: user.id } });
    assert.equal(accountSettings?.temperature, null, 'new Auto account should use provider defaults unless a sampling preference is saved');
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: json({ conversationId: conversation.id, selectionMode: 'AUTO', content: 'Explain a database index.' }) });
    assert.equal(response.status, 200);
    const body = await response.text(); assert.match(body, /"provider":"gemini"/); assert.match(body, /Gemini response/);
    assert.deepEqual(receivedParameters, { maxOutputTokens: 1200 });
    const assistant = await prisma.message.findFirst({ where: { conversationId: conversation.id, role: 'assistant' } });
    assert.equal(assistant?.provider, 'gemini'); assert.equal(assistant?.model, 'gemini-3.8-flash');
  } finally { await server.close(); await prisma.user.delete({ where: { id: user.id } }); }
});
