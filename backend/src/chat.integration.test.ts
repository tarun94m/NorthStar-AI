import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AIProvider } from './ai.js';
import { ProviderRegistry } from './ai.js';
import { ModelRegistry, modelRegistry } from './model-registry.js';
import { prisma, pool } from './db.js';
import { createToken } from './auth.js';
import { createApp } from './app.js';
after(async () => { await prisma.$disconnect(); await pool.end(); });

async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `${suffix}@example.test` } });
  const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  return { user, session, conversation, cookie: `session=${createToken({ id: user.id, guest: false }, session.id)}` };
}
function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0);
  return new Promise<{ base: string; close: () => Promise<void> }>(resolve => server.once('listening', () => {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    resolve({ base: `http://127.0.0.1:${address.port}`, close: () => new Promise((done, reject) => server.close(e => e ? reject(e) : done())) });
  }));
}
const generation = (text: string): any => ({ chunks: (async function* () { yield text; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) });
const params = (request: { signal: AbortSignal }) => request;

test('two API instances reject duplicate generation using the PostgreSQL lease', async () => {
  const f = await fixture();
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controlled: AIProvider = { id: 'mock', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream(raw) { const { signal } = params(raw);
    started();
    signal.addEventListener('abort', () => release(), { once: true });
    return { chunks: (async function* () { yield 'first'; await gate; yield ' response'; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }) };
  } };
  const firstServer = await listen(createApp(prisma, { provider: controlled }));
  const secondServer = await listen(createApp(prisma, { provider: controlled }));
  try {
    const body = JSON.stringify({ conversationId: f.conversation.id, content: 'hello', modelId: 'mock:echo' });
    const firstPromise = fetch(`${firstServer.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body });
    await startedPromise;
    const duplicate = await fetch(`${secondServer.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'duplicate', modelId: 'mock:echo' }) });
    assert.equal(duplicate.status, 409);
    release();
    const response = await firstPromise;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/);
    const rows = await prisma.message.findMany({ where: { conversationId: f.conversation.id }, orderBy: { sequence: 'asc' } });
    assert.equal(rows.filter(m => m.role === 'assistant').length, 1);
    assert.deepEqual(rows.map(m => m.sequence), [1, 2]);
    const persisted = await prisma.conversation.findUnique({ where: { id: f.conversation.id } });
    assert.equal(persisted?.provider, 'mock'); assert.equal(persisted?.model, 'echo');
  } finally { release(); await firstServer.close(); await secondServer.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('model catalog is registry-backed and unknown or unavailable IDs never fall back', async () => {
  const f = await fixture();
  const server = await listen(createApp(prisma, { provider: { id: 'mock', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream() { return generation('unused'); } } }));
  try {
    const catalogResponse = await fetch(`${server.base}/api/models`, { headers: { Cookie: f.cookie } });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as any;
    assert.ok(Array.isArray(catalog.models));
    assert.ok(catalog.models.every((model: any) => model.id && model.provider && model.model && model.capabilities && model.parameters));
    assert.equal(JSON.stringify(catalog).includes('API_KEY'), false);
    const unknown = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'hello', modelId: 'bogus:model' }) });
    assert.equal(unknown.status, 400); assert.equal((await unknown.json() as any).code, 'MODEL_NOT_FOUND');
    const unsupported = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'hello', modelId: 'mock:echo', parameters: { temperature: 0.5 } }) });
    assert.equal(unsupported.status, 400); assert.equal((await unsupported.json() as any).code, 'UNSUPPORTED_PARAMETER');
    const unavailable = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'hello', modelId: 'gemini:gemini-3.8-flash' }) });
    assert.equal(unavailable.status, 503); assert.equal((await unavailable.json() as any).code, 'MODEL_UNAVAILABLE');
    assert.equal(await prisma.message.count({ where: { conversationId: f.conversation.id } }), 0);
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('chat rejects a current message that exceeds the selected model budget with an actionable error', async () => {
  const f = await fixture();
  const mockModel = { ...modelRegistry.all().find(model => model.id === 'mock:echo')!, contextWindow: 60_000, maxOutputTokens: 1200 };
  const mocked: AIProvider = { id: 'mock', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream() { return generation('unused'); } };
  const server = await listen(createApp(prisma, { provider: mocked, models: new ModelRegistry([mockModel]) }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'x'.repeat(200_000), modelId: 'mock:echo' }) });
    assert.equal(response.status, 413);
    const result = await response.json() as any;
    assert.equal(result.code, 'CONTEXT_TOO_LARGE');
    assert.match(result.error, /Shorten the message|larger context window/);
    assert.equal(await prisma.message.count({ where: { conversationId: f.conversation.id, role: 'assistant' } }), 0);
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('guest sessions can route a chat through the mock model and persist provider/model/usage', async () => {
  const guest = await prisma.user.create({ data: { isGuest: true, settings: { create: {} } } });
  await prisma.userSettings.update({ where: { userId: guest.id }, data: { responsePreferences: 'Use short bullet points.' } });
  const session = await prisma.session.create({ data: { userId: guest.id, expiresAt: new Date(Date.now() + 60_000) } });
  const cookie = `session=${createToken({ id: guest.id, guest: true }, session.id)}`;
  let routedRequest: any;
  const mocked: AIProvider = { id: 'mock', async generate() { return { text: 'unused', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream(request) { routedRequest = request; return generation('guest reply'); } };
  const server = await listen(createApp(prisma, { provider: mocked }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'guest question', modelId: 'mock:echo' }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
    const conversation = await prisma.conversation.findFirst({ where: { userId: guest.id }, include: { messages: { orderBy: { sequence: 'asc' } }, usageRecords: true } });
    assert.ok(conversation); assert.equal(conversation.provider, 'mock'); assert.equal(conversation.model, 'echo');
    assert.deepEqual(conversation.messages.map(message => message.role), ['user', 'assistant']);
    assert.equal(conversation.messages[1]?.content, 'guest reply'); assert.equal(conversation.usageRecords.length, 1);
    assert.match(routedRequest.systemInstructions, /helpful AI assistant/);
    assert.equal(routedRequest.responsePreferences, '', 'guest requests must not read registered-account settings');
    assert.equal(routedRequest.input[0].content, 'guest question');
    assert.equal((await prisma.dailyGuestQuota.findFirst({ where: { userId: guest.id } }))?.consumed, 1);
  } finally { await server.close(); await prisma.user.delete({ where: { id: guest.id } }); }
});

test('model selection routes to the selected Gemini provider and persists Gemini model identity', async () => {
  const f = await fixture();
  const geminiDefinition = { ...modelRegistry.all().find(model => model.providerId === 'gemini')!, configured: true, enabled: true };
  let routedRequest: any;
  const gemini: AIProvider = {
    id: 'gemini', async generate() { return { text: 'unused', usage: { inputTokens: 0, outputTokens: 0 } }; },
    async stream(request) { routedRequest = request; return generation('gemini reply'); },
  };
  const server = await listen(createApp(prisma, { models: new ModelRegistry([geminiDefinition]), providers: new ProviderRegistry(new Map([['gemini', gemini]])) }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'route this', modelId: geminiDefinition.id }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
    assert.equal(routedRequest.modelId, 'gemini:gemini-3.8-flash');
    assert.equal(routedRequest.providerModelId, 'gemini-3.8-flash');
    const saved = await prisma.conversation.findUnique({ where: { id: f.conversation.id } });
    assert.equal(saved?.provider, 'gemini'); assert.equal(saved?.model, 'gemini-3.8-flash');
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('provider receives the exact recent whole turns, composed preferences, and model-specific output reservation', async () => {
  const f = await fixture();
  await prisma.userSettings.create({ data: { userId: f.user.id, responsePreferences: 'Prefer compact bullet points.' } });
  const openaiModel = modelRegistry.all().find(model => model.id === 'openai:gpt-4.1-mini')!;
  const constrainedModel = { ...openaiModel, configured: true, enabled: true, contextWindow: 450, maxOutputTokens: 150 };
  await prisma.message.createMany({ data: [
    { conversationId: f.conversation.id, sequence: 1, role: 'user', content: 'old turn' },
    { conversationId: f.conversation.id, sequence: 2, role: 'assistant', content: 'old answer' },
    { conversationId: f.conversation.id, sequence: 3, role: 'user', content: 'recent turn' },
    { conversationId: f.conversation.id, sequence: 4, role: 'assistant', content: 'recent answer' },
  ] });
  await prisma.conversation.update({ where: { id: f.conversation.id }, data: { lastMessageSequence: 4 } });
  let routedRequest: any; const countRequests: any[] = [];
  const routed: AIProvider = {
    id: 'openai', async generate() { throw new Error('stream only'); },
    async countInputTokens(request) {
      countRequests.push(request);
      return request.input.length === 1 ? 80 : request.input.length === 3 ? 250 : 300;
    },
    async stream(request) { routedRequest = request; return generation('context reply'); },
  };
  const server = await listen(createApp(prisma, { provider: routed, models: new ModelRegistry([constrainedModel]) }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'current question', modelId: constrainedModel.id, parameters: { maxOutputTokens: 50 } }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
    assert.deepEqual(routedRequest.input.map((item: any) => item.content), ['recent turn', 'recent answer', 'current question']);
    assert.equal(routedRequest.parameters.maxOutputTokens, 50);
    assert.match(routedRequest.systemInstructions, /You are a helpful AI assistant/);
    assert.equal(routedRequest.responsePreferences, 'Prefer compact bullet points.');
    assert.ok(countRequests.length >= 2);
    assert.ok(countRequests.every(request => request.systemInstructions === routedRequest.systemInstructions && request.responsePreferences === routedRequest.responsePreferences));
    assert.ok(countRequests.every(request => request.input.at(-1)?.content === 'current question'));
    const saved = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'assistant' }, orderBy: { sequence: 'desc' } });
    assert.equal(saved?.inputTokens, 1, 'provider-reported usage stays distinct from the ContextBuilder estimate');
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('chat provider receives active summaries once as untrusted context and excludes covered raw messages', async () => {
  const f = await fixture();
  await prisma.message.createMany({ data: [
    { conversationId: f.conversation.id, sequence: 1, role: 'user', content: 'old raw user fact' },
    { conversationId: f.conversation.id, sequence: 2, role: 'assistant', content: 'old raw assistant answer' },
  ] });
  await prisma.conversation.update({ where: { id: f.conversation.id }, data: { lastMessageSequence: 2 } });
  await prisma.conversationSummary.create({ data: { conversationId: f.conversation.id, version: 1, coveredThroughSequence: 2, sourceHighWaterSequence: 2, transcriptRevision: 0, summaryText: 'remember the launch decision' } });
  let received: any;
  const routed: AIProvider = { id: 'mock', async generate() { throw new Error('stream only'); }, async stream(request) { received = request; return generation('summary-aware reply'); } };
  const server = await listen(createApp(prisma, { provider: routed }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'continue', modelId: 'mock:echo' }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
    assert.match(received.input[0].content, /untrusted conversation summary/i);
    assert.equal(received.input[0].content.includes('remember the launch decision'), true);
    assert.equal(received.input.some((item: any) => item.content.includes('old raw')), false, 'covered raw messages are not duplicated beside the summary');
    assert.equal(received.systemInstructions.includes('remember the launch decision'), false);
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('summary work is enqueued atomically with terminal assistant and usage finalization at the context threshold', async () => {
  const f = await fixture();
  const base = modelRegistry.all().find(model => model.id === 'openai:gpt-4.1-mini')!;
  const selected = { ...base, configured: true, enabled: true, contextWindow: 500, maxOutputTokens: 100 };
  const provider: AIProvider = { id: 'openai', async generate() { throw new Error('stream only'); }, async countInputTokens() { return 250; }, async stream() { return generation('threshold reply'); } };
  const server = await listen(createApp(prisma, { provider, models: new ModelRegistry([selected]) }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'queue summary', modelId: selected.id, parameters: { maxOutputTokens: 50 } }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
    const assistant = await prisma.message.findFirstOrThrow({ where: { conversationId: f.conversation.id, role: 'assistant' } });
    const [job, outbox] = await Promise.all([
      prisma.conversationSummaryJob.findUnique({ where: { conversationId: f.conversation.id } }),
      prisma.usageOutbox.findUnique({ where: { idempotencyKey: `chat:${assistant.id}` } }),
    ]);
    assert.equal(assistant.status, 'complete');
    assert.equal(job?.requestedThroughSequence, assistant.sequence);
    assert.equal(job?.status, 'queued');
    assert.ok(outbox, 'usage and summary work are durable at the finalization boundary');
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('selected model output reserve changes whole-turn boundary; oversized current context is never truncated', async () => {
  const f = await fixture();
  const base = modelRegistry.all().find(model => model.id === 'openai:gpt-4.1-mini')!;
  const constrained = { ...base, configured: true, enabled: true, contextWindow: 450, maxOutputTokens: 150 };
  await prisma.message.createMany({ data: [
    { conversationId: f.conversation.id, sequence: 1, role: 'user', content: 'prior' },
    { conversationId: f.conversation.id, sequence: 2, role: 'assistant', content: 'prior answer' },
  ] });
  await prisma.conversation.update({ where: { id: f.conversation.id }, data: { lastMessageSequence: 2 } });
  const largerReserveConversation = await prisma.conversation.create({ data: { userId: f.user.id } });
  await prisma.message.createMany({ data: [
    { conversationId: largerReserveConversation.id, sequence: 1, role: 'user', content: 'prior' },
    { conversationId: largerReserveConversation.id, sequence: 2, role: 'assistant', content: 'prior answer' },
  ] });
  await prisma.conversation.update({ where: { id: largerReserveConversation.id }, data: { lastMessageSequence: 2 } });
  const routedInput: any[] = [];
  const routed: AIProvider = { id: 'openai', async generate() { throw new Error('stream only'); }, async countInputTokens(request) { return request.input.length === 1 ? 80 : 240; }, async stream(request) { routedInput.push(request.input); return generation('reply'); } };
  const server = await listen(createApp(prisma, { provider: routed, models: new ModelRegistry([constrained]) }));
  try {
    const smallReserve = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'fit with smaller output', modelId: constrained.id, parameters: { maxOutputTokens: 50 } }) });
    assert.equal(smallReserve.status, 200); await smallReserve.text();
    assert.deepEqual(routedInput[0].map((item: any) => item.content), ['prior', 'prior answer', 'fit with smaller output']);
    const largerReserve = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: largerReserveConversation.id, content: 'fit only without history', modelId: constrained.id, parameters: { maxOutputTokens: 100 } }) });
    assert.equal(largerReserve.status, 200); await largerReserve.text();
    assert.deepEqual(routedInput[1].map((item: any) => item.content), ['fit only without history']);
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }

  const tooLarge = await fixture();
  let providerStarted = false;
  const rejectsCurrent: AIProvider = { id: 'openai', async generate() { throw new Error('unused'); }, async countInputTokens() { return 500; }, async stream() { providerStarted = true; return generation('must not run'); } };
  const rejectingServer = await listen(createApp(prisma, { provider: rejectsCurrent, models: new ModelRegistry([{ ...constrained, contextWindow: 450 }]) }));
  try {
    const response = await fetch(`${rejectingServer.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: tooLarge.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: tooLarge.conversation.id, content: 'do not truncate this current request', modelId: constrained.id, parameters: { maxOutputTokens: 50 } }) });
    assert.equal(response.status, 413); assert.equal((await response.json() as any).code, 'CONTEXT_TOO_LARGE');
    assert.equal(providerStarted, false);
  } finally { await rejectingServer.close(); await prisma.user.delete({ where: { id: tooLarge.user.id } }); }
});

test('regeneration replaces the prior answer; edit preserves sequence and clears later turns', async () => {
  const f = await fixture();
  let calls = 0;
  const scripted: AIProvider = { id: 'mock', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream() {
    calls++;
    if (calls === 2) return { chunks: (async function* () { yield 'partial replacement'; throw new Error('provider failed'); })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }) };
    return generation('first answer');
  } };
  const server = await listen(createApp(prisma, { provider: scripted }));
  try {
    const post = (body: unknown) => fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const initial = await post({ conversationId: f.conversation.id, content: 'question', modelId: 'mock:echo' });
    assert.match(await initial.text(), /event: done/);
    const userMessage = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'user' } });
    assert.ok(userMessage);
    const regenerated = await post({ conversationId: f.conversation.id, regenerate: true, modelId: 'mock:echo' });
    assert.match(await regenerated.text(), /event: error/);
    let rows = await prisma.message.findMany({ where: { conversationId: f.conversation.id }, orderBy: { sequence: 'asc' } });
    assert.equal(rows.filter(m => m.role === 'assistant').length, 1);
    assert.equal(rows.find(m => m.role === 'assistant')?.status, 'partial');
    const originalSequence = userMessage.sequence;
    const edited = await fetch(`${server.base}/api/messages/${userMessage.id}`, { method: 'PATCH', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'edited question' }) });
    assert.equal(edited.status, 200);
    rows = await prisma.message.findMany({ where: { conversationId: f.conversation.id }, orderBy: { sequence: 'asc' } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.content, 'edited question');
    assert.equal(rows[0]?.sequence, originalSequence);
    const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
    const otherSession = await prisma.session.create({ data: { userId: other.id, expiresAt: new Date(Date.now() + 60_000) } });
    const forbidden = await fetch(`${server.base}/api/messages/${userMessage.id}`, { method: 'PATCH', headers: { Cookie: `session=${createToken({ id: other.id, guest: false }, otherSession.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'unauthorized' }) });
    assert.equal(forbidden.status, 404);
    await prisma.user.delete({ where: { id: other.id } });
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('client disconnect cancels generation and persists the partial assistant response', async () => {
  const f = await fixture();
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const provider: AIProvider = { id: 'mock', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream(raw) { const { signal } = params(raw);
    return { chunks: (async function* () { yield 'partial'; started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) };
  } };
  const server = await listen(createApp(prisma, { provider }));
  const controller = new AbortController();
  try {
    const request = fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'cancel me', modelId: 'mock:echo' }), signal: controller.signal });
    const response = await request;
    const reader = response.body!.getReader();
    await startedPromise;
    const decoder = new TextDecoder(); let streamed = '';
    while (!streamed.includes('partial')) { const next = await reader.read(); assert.ok(next.value); streamed += decoder.decode(next.value); }
    controller.abort();
    await assert.rejects(async () => { await reader.read(); });
    for (let i = 0; i < 30; i++) {
      const assistant = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'assistant' } });
      if (assistant?.status === 'partial') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const assistant = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'assistant' } });
    assert.equal(assistant?.status, 'partial');
    assert.equal(assistant?.content, 'partial');
  } finally { controller.abort(); await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('assistant progress writes serialize before terminal completion and survive usage-record failure', async () => {
  const f = await fixture();
  let releaseProgress!: () => void; let progressStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseProgress = resolve; });
  const started = new Promise<void>(resolve => { progressStarted = resolve; });
  let activeWrites = 0; let maximumConcurrentWrites = 0;
  const writeOrder: string[] = [];
  const provider: AIProvider = {
    id: 'mock', async generate() { throw new Error('stream only'); },
    async stream() { return { chunks: (async function* () { yield 'first'; yield ' final'; })(), usage: Promise.resolve({ inputTokens: 13, outputTokens: 3 }) }; },
  };
  const server = await listen(createApp(prisma, {
    provider,
    persistAssistantMessage: async (id, data) => {
      activeWrites++; maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites);
      const label = data.status ?? 'progress'; writeOrder.push(label);
      try {
        if (!data.status && data.content === 'first final') { progressStarted(); await gate; }
        return await prisma.message.update({ where: { id }, data });
      } finally { activeWrites--; }
    },
    createUsageRecord: async () => { throw new Error('simulated usage-store failure'); },
  }));
  try {
    const request = fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'serialize progress', modelId: 'mock:echo' }) });
    await started;
    const streaming = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'assistant' } });
    assert.equal(streaming?.status, 'streaming');
    assert.equal(streaming?.content, 'first', 'the first delta was persisted before SSE headers; the later progress write remains held at its barrier');
    assert.equal(activeWrites, 1);
    releaseProgress();
    const response = await request;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/, 'the completed response is returned while usage delivery is retried from the outbox');
    assert.equal(maximumConcurrentWrites, 1, 'progress and final writes must never overlap');
    assert.deepEqual(writeOrder, ['progress', 'complete'], 'terminal completion must be written after the pending progress update');
    const saved = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'assistant' } });
    assert.equal(saved?.status, 'complete', 'post-finalization usage failure must not downgrade a completed response');
    assert.equal(saved?.content, 'first final');
    const outbox = await prisma.usageOutbox.findUnique({ where: { idempotencyKey: `chat:${saved!.id}` } });
    assert.ok(outbox, 'assistant completion and its usage event are committed atomically');
    assert.equal(outbox?.deliveredAt, null, 'a failed delivery remains durable for retry');
  } finally { releaseProgress(); await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('assistant progress persistence failure aborts provider generation and records an error state', async () => {
  const f = await fixture(); let providerSawAbort = false;
  const provider: AIProvider = {
    id: 'mock', async generate() { throw new Error('stream only'); },
    async stream(request) {
      request.signal.addEventListener('abort', () => { providerSawAbort = true; }, { once: true });
      return {
        chunks: (async function* () {
          try {
            yield 'unpersisted';
            await new Promise(resolve => setTimeout(resolve, 260));
            yield ' later';
            await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
          }
          finally { /* generator is closed when persistence fails */ }
        })(),
        usage: Promise.resolve({ inputTokens: 2, outputTokens: 1 }),
      };
    },
  };
  const server = await listen(createApp(prisma, {
    provider,
    async persistAssistantMessage(id, data) {
      if (!data.status) throw new Error('simulated progress database failure');
      return prisma.message.update({ where: { id }, data });
    },
  }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'save failure', modelId: 'mock:echo' }) });
    assert.match(await response.text(), /PERSISTENCE_FAILURE/);
    assert.equal(providerSawAbort, true, 'upstream generation must be cancelled when a progress write fails');
    const saved = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'assistant' } });
    assert.equal(saved?.status, 'partial');
    assert.equal(saved?.content, 'unpersisted later');
    assert.equal(saved?.error, 'Response persistence failed.');
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('provider timeout persists a cancelled assistant state and releases its lease', async () => {
  const f = await fixture();
  const provider: AIProvider = { id: 'mock', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }, async stream(raw) { const { signal } = params(raw);
    return { chunks: (async function* () { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }) };
  } };
  const server = await listen(createApp(prisma, { provider, providerTimeoutMs: 25 }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: f.conversation.id, content: 'timeout me', modelId: 'mock:echo' }) });
    assert.equal(response.status, 504, 'a timeout before the first text delta is a pre-stream provider error');
    assert.equal((await response.json() as any).code, 'PROVIDER_TIMEOUT');
    const assistant = await prisma.message.findFirst({ where: { conversationId: f.conversation.id, role: 'assistant' } });
    assert.equal(assistant, null, 'no assistant response is created until the first non-empty provider delta is available');
    const attempt = await prisma.usageRecord.findFirst({ where: { userId: f.user.id, operation: 'provider_attempt' } });
    assert.equal(attempt?.usageStatus, 'provider_reported'); assert.equal(attempt?.inputTokens, 1);
    let lock = await prisma.conversationGenerationLock.findUnique({ where: { conversationId: f.conversation.id } });
    for (let i = 0; lock && i < 30; i++) { await new Promise(resolve => setTimeout(resolve, 25)); lock = await prisma.conversationGenerationLock.findUnique({ where: { conversationId: f.conversation.id } }); }
    assert.equal(lock, null);
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});

test('conversation recovery preserves live leased generations and marks orphaned streaming rows partial', async () => {
  const f = await fixture();
  const active = await prisma.message.create({ data: { conversationId: f.conversation.id, sequence: 1, role: 'assistant', content: 'still generating', status: 'streaming' } });
  await prisma.conversation.update({ where: { id: f.conversation.id }, data: { lastMessageSequence: 1 } });
  await prisma.conversationGenerationLock.create({ data: { conversationId: f.conversation.id, ownerToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
  const server = await listen(createApp(prisma));
  try {
    const read = () => fetch(`${server.base}/api/conversations`, { headers: { Cookie: f.cookie } });
    let response = await read(); assert.equal(response.status, 200);
    let state = await prisma.message.findUnique({ where: { id: active.id } });
    assert.equal(state?.status, 'streaming', 'a live lease must prevent stale recovery');
    await prisma.conversationGenerationLock.delete({ where: { conversationId: f.conversation.id } });
    response = await read(); assert.equal(response.status, 200);
    state = await prisma.message.findUnique({ where: { id: active.id } });
    assert.equal(state?.status, 'partial', 'an orphaned streaming message should recover as partial when content exists');
  } finally { await server.close(); await prisma.user.delete({ where: { id: f.user.id } }); }
});
