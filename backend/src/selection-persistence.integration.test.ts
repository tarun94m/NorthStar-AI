import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from 'express-rate-limit';
import { prisma, pool } from './db.js';
import { createApp } from './app.js';
import { createToken } from './auth.js';
import { ModelRegistry, modelRegistry } from './model-registry.js';
import type { AIProvider } from './ai.js';

after(async () => { await prisma.$disconnect(); await pool.end(); });

async function fixture({ guest = false, mode = 'MANUAL' as 'MANUAL' | 'AUTO', withSettings = true } = {}) {
  const user = await prisma.user.create({ data: {
    email: guest ? null : `${randomUUID()}@selection.test`, isGuest: guest,
    ...(withSettings ? { settings: { create: { selectionMode: mode } } } : {}),
  } });
  const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
  return { user, session, cookie: `session=${createToken({ id: user.id, guest }, session.id)}` };
}
async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
const json = (value: unknown) => JSON.stringify(value);
const testRateLimitStores = () => ({ api: new MemoryStore(), guestCreation: new MemoryStore() });
const mockModel = modelRegistry.all().find(item => item.id === 'mock:echo')!;
const mockProvider: AIProvider = {
  id: 'mock',
  async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; },
  async stream() { return { chunks: (async function* () { yield 'legacy response'; })(), usage: Promise.resolve({ inputTokens: 2, outputTokens: 2 }) }; },
};

test('database defaults keep existing accounts and conversations in Manual mode', async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@legacy-selection.test` } });
  try {
    const settings = await prisma.userSettings.create({ data: { userId: user.id } });
    const conversation = await prisma.conversation.create({ data: { userId: user.id } });
    assert.equal(settings.selectionMode, 'MANUAL');
    assert.equal(conversation.selectionMode, 'MANUAL');
    assert.equal(conversation.selectionModelId, null);
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('settings are owner-scoped, guest-restricted, and preserve model availability and supported parameters', async () => {
  const owner = await fixture(); const other = await fixture(); const guest = await fixture({ guest: true });
  const server = await listen(createApp(prisma));
  try {
    const get = await fetch(`${server.base}/api/settings`, { headers: { Cookie: owner.cookie } });
    assert.equal(get.status, 200);
    const initial = await get.json() as any;
    assert.equal(initial.settings.selectionMode, 'MANUAL');
    assert.equal(initial.settings.defaultModelId, 'openai:gpt-4.1-mini');
    assert.equal(initial.settings.defaultModelAvailability.status, 'provider_not_configured');
    assert.equal(initial.settings.temperature, null);
    assert.equal(initial.settings.temperatureSupported, null);
    const changed = await fetch(`${server.base}/api/settings`, { method: 'PATCH', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ selectionMode: 'AUTO', responsePreferences: 'Concise', memoryEnabled: true }) });
    assert.equal(changed.status, 200);
    const updated = await prisma.userSettings.findUnique({ where: { userId: owner.user.id } });
    assert.equal(updated?.selectionMode, 'AUTO'); assert.equal(updated?.responsePreferences, 'Concise'); assert.equal(updated?.memoryEnabled, true);

    const saveTemperature = await fetch(`${server.base}/api/settings`, { method: 'PATCH', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ temperature: 0.7 }) });
    assert.equal(saveTemperature.status, 200);
    const unsupportedSavedParameter = await fetch(`${server.base}/api/settings`, { method: 'PATCH', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ defaultModelId: 'mock:echo' }) });
    assert.equal(unsupportedSavedParameter.status, 409);
    assert.equal((await unsupportedSavedParameter.json() as any).code, 'SAVED_PARAMETER_UNSUPPORTED');
    const afterRejectedChange = await prisma.userSettings.findUnique({ where: { userId: owner.user.id } });
    assert.equal(afterRejectedChange?.provider, 'openai'); assert.equal(afterRejectedChange?.model, 'gpt-4.1-mini');
    const clearTemperature = await fetch(`${server.base}/api/settings`, { method: 'PATCH', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ temperature: null }) });
    assert.equal(clearTemperature.status, 200); assert.equal((await clearTemperature.json() as any).settings.temperature, null);

    const forbidden = await fetch(`${server.base}/api/settings`, { headers: { Cookie: guest.cookie } });
    assert.equal(forbidden.status, 403); assert.equal((await forbidden.json() as any).code, 'SETTINGS_REGISTERED_ACCOUNT_REQUIRED');
    const isolatedPatch = await fetch(`${server.base}/api/settings`, { method: 'PATCH', headers: { Cookie: other.cookie, 'Content-Type': 'application/json' }, body: json({ responsePreferences: 'Only for other user' }) });
    assert.equal(isolatedPatch.status, 200);
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: owner.user.id } }))?.responsePreferences, 'Concise');
    const unavailableSavedPreference = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: other.cookie, 'Content-Type': 'application/json' }, body: json({ content: 'do not substitute an unavailable saved model' }) });
    assert.equal(unavailableSavedPreference.status, 503); assert.equal((await unavailableSavedPreference.json() as any).code, 'MODEL_UNAVAILABLE');
    assert.equal(await prisma.conversation.count({ where: { userId: other.user.id } }), 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [owner.user.id, other.user.id, guest.user.id] } } });
  }
});

test('new registrations default to Auto; guest and conversation selection rules are explicit', async () => {
  const selectionModels = new ModelRegistry(modelRegistry.all().map(model => model.id === 'openai:gpt-4.1-mini' ? { ...model, enabled: true, configured: true } : model));
  const server = await listen(createApp(prisma, { models: selectionModels, rateLimitStores: testRateLimitStores() }));
  let registeredId: string | undefined; let guestId: string | undefined; let upgradedId: string | undefined; let legacyServer: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    const guestCreation = await fetch(`${server.base}/api/auth/guest`, { method: 'POST' });
    assert.equal(guestCreation.status, 200);
    const guestCreated = await guestCreation.json() as any; guestId = guestCreated.user.id;
    const guestCookie = guestCreation.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal(await prisma.userSettings.findUnique({ where: { userId: guestId! } }), null, 'guest creation must not persist account defaults');

    const register = await fetch(`${server.base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ email: `${randomUUID()}@new-selection.test`, password: 'correct horse battery staple' }) });
    assert.equal(register.status, 201);
    const registered = await register.json() as any; registeredId = registered.user.id;
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: registeredId! } }))?.selectionMode, 'AUTO');
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: registeredId! } }))?.temperature, null);

    const upgradeGuest = await fetch(`${server.base}/api/auth/guest`, { method: 'POST' });
    const upgradeGuestData = await upgradeGuest.json() as any; upgradedId = upgradeGuestData.user.id;
    const upgradeCookie = upgradeGuest.headers.get('set-cookie')!.split(';')[0]!;
    const upgrade = await fetch(`${server.base}/api/auth/register`, { method: 'POST', headers: { Cookie: upgradeCookie, 'Content-Type': 'application/json' }, body: json({ email: `${randomUUID()}@upgraded-selection.test`, password: 'correct horse battery staple' }) });
    assert.equal(upgrade.status, 201);
    assert.equal((await upgrade.json() as any).user.id, upgradedId);
    assert.equal((await prisma.userSettings.findUnique({ where: { userId: upgradedId! } }))?.selectionMode, 'AUTO');

    const registeredCookie = register.headers.get('set-cookie')!.split(';')[0]!;
    const created = await fetch(`${server.base}/api/conversations`, { method: 'POST', headers: { Cookie: registeredCookie } });
    assert.equal(created.status, 201);
    const registeredConversation = (await created.json() as any).conversation;
    assert.equal(registeredConversation.selectionMode, 'AUTO'); assert.equal(registeredConversation.selectionModelId, null);

    const manual = await fetch(`${server.base}/api/conversations/${registeredConversation.id}/model-selection`, { method: 'PATCH', headers: { Cookie: registeredCookie, 'Content-Type': 'application/json' }, body: json({ selectionMode: 'MANUAL', selectionModelId: 'openai:gpt-4.1-mini' }) });
    assert.equal(manual.status, 200);
    const savedManual = (await manual.json() as any).conversation;
    assert.equal(savedManual.selectionMode, 'MANUAL'); assert.equal(savedManual.selectionModelId, 'openai:gpt-4.1-mini');
    const invalidAutoSelection = await fetch(`${server.base}/api/conversations/${registeredConversation.id}/model-selection`, { method: 'PATCH', headers: { Cookie: registeredCookie, 'Content-Type': 'application/json' }, body: json({ selectionMode: 'AUTO', selectionModelId: 'mock:echo' }) });
    assert.equal(invalidAutoSelection.status, 400); assert.equal((await invalidAutoSelection.json() as any).code, 'SELECTION_CONFLICT');
    const otherOwner = await fixture();
    try {
      const isolated = await fetch(`${server.base}/api/conversations/${registeredConversation.id}/model-selection`, { method: 'PATCH', headers: { Cookie: otherOwner.cookie, 'Content-Type': 'application/json' }, body: json({ selectionMode: 'MANUAL' }) });
      assert.equal(isolated.status, 404);
    } finally { await prisma.user.delete({ where: { id: otherOwner.user.id } }); }

    const guestConversation = await fetch(`${server.base}/api/conversations`, { method: 'POST', headers: { Cookie: guestCookie } });
    assert.equal(guestConversation.status, 201);
    const guestConversationRow = (await guestConversation.json() as any).conversation;
    assert.equal(guestConversationRow.selectionMode, 'MANUAL'); assert.equal(guestConversationRow.selectionModelId, null);
    const guestSelection = await fetch(`${server.base}/api/conversations/${guestConversationRow.id}/model-selection`, { method: 'PATCH', headers: { Cookie: guestCookie, 'Content-Type': 'application/json' }, body: json({ selectionMode: 'MANUAL' }) });
    assert.equal(guestSelection.status, 403); assert.equal((await guestSelection.json() as any).code, 'GUEST_CONVERSATION_SELECTION_UNAVAILABLE');
    legacyServer = await listen(createApp(prisma, { rateLimitStores: testRateLimitStores() }));
    const legacyGuestChat = await fetch(`${legacyServer.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: guestCookie, 'Content-Type': 'application/json' }, body: json({ conversationId: guestConversationRow.id, content: 'legacy caller omits selection fields' }) });
    assert.equal(legacyGuestChat.status, 200); assert.match(await legacyGuestChat.text(), /event: done/);
    const guestAssistant = await prisma.message.findFirst({ where: { conversationId: guestConversationRow.id, role: 'assistant' } });
    assert.equal(guestAssistant?.provider, 'mock'); assert.equal(guestAssistant?.requestedSelectionMode, 'MANUAL');
    assert.equal(guestAssistant?.requestedModelId, 'mock:echo');
  } finally {
    await legacyServer?.close(); await server.close();
    if (registeredId) await prisma.user.delete({ where: { id: registeredId } });
    if (guestId) await prisma.user.delete({ where: { id: guestId } });
    if (upgradedId) await prisma.user.delete({ where: { id: upgradedId } });
  }
});

test('Auto uses the registry router, legacy modelId requests remain Manual, and conflicting selectors are rejected', async () => {
  const owner = await fixture({ mode: 'AUTO' });
  const autoModel = { ...mockModel, enabled: true, configured: true, parameters: { temperature: { type: 'number' as const, min: 0, max: 2 } } };
  const server = await listen(createApp(prisma, { provider: mockProvider, models: new ModelRegistry([autoModel]) }));
  try {
    const conversation = await prisma.conversation.create({ data: { userId: owner.user.id, selectionMode: 'AUTO' } });
    const send = (body: Record<string, unknown>) => fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ conversationId: conversation.id, ...body }) });
    const conflict = await send({ content: 'conflicting selectors', selectionMode: 'AUTO', modelId: 'mock:echo' });
    assert.equal(conflict.status, 400); assert.equal((await conflict.json() as any).code, 'SELECTION_CONFLICT');
    const automatic = await send({ content: 'explain a small idea', selectionMode: 'AUTO', parameters: { temperature: 0.7 } });
    assert.equal(automatic.status, 200);
    const autoSse = await automatic.text(); assert.match(autoSse, /event: meta/); assert.match(autoSse, /"requestedSelectionMode":"AUTO"/); assert.match(autoSse, /"taskType":"general_conversation"/); assert.match(autoSse, /event: done/);
    const legacy = await send({ content: 'legacy request', modelId: 'mock:echo' });
    assert.equal(legacy.status, 200); assert.match(await legacy.text(), /event: done/);
    const assistants = await prisma.message.findMany({ where: { conversationId: conversation.id, role: 'assistant' }, orderBy: { sequence: 'asc' } });
    const autoAssistant = assistants[0]; const assistant = assistants[1];
    assert.equal(autoAssistant?.requestedSelectionMode, 'AUTO'); assert.equal(autoAssistant?.requestedModelId, null); assert.equal(autoAssistant?.taskType, 'general_conversation');
    assert.ok(autoAssistant?.routingPolicyVersion); assert.equal(autoAssistant?.provider, 'mock');
    assert.equal(assistant?.provider, 'mock'); assert.equal(assistant?.model, 'echo');
    assert.equal(assistant?.requestedSelectionMode, 'MANUAL');
    assert.equal(assistant?.requestedModelId, 'mock:echo');
    assert.equal(assistant?.routingReasonCode, 'explicit_model_selection');
    assert.equal(await prisma.message.count({ where: { conversationId: conversation.id, role: 'user' } }), 2);
  } finally { await server.close(); await prisma.user.delete({ where: { id: owner.user.id } }); }
});

test('persisted Manual temperature is passed when supported and rejected instead of dropped when unsupported', async () => {
  const supportedOwner = await fixture();
  await prisma.userSettings.update({ where: { userId: supportedOwner.user.id }, data: { provider: 'mock', model: 'echo', temperature: 0.42 } });
  let actualTemperature: number | undefined;
  const supportedProvider: AIProvider = {
    id: 'mock', async generate() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; },
    async stream(request) { actualTemperature = request.parameters.temperature; return { chunks: (async function* () { yield 'response'; })(), usage: Promise.resolve({ inputTokens: 2, outputTokens: 1 }) }; },
  };
  const supportedModel = { ...mockModel, enabled: true, configured: true, parameters: { temperature: { type: 'number' as const, min: 0, max: 2 } } };
  const supportedServer = await listen(createApp(prisma, { provider: supportedProvider, models: new ModelRegistry([supportedModel]) }));
  const unsupportedOwner = await fixture();
  await prisma.userSettings.update({ where: { userId: unsupportedOwner.user.id }, data: { provider: 'mock', model: 'echo', temperature: 0.42 } });
  const unsupportedServer = await listen(createApp(prisma, { provider: mockProvider, models: new ModelRegistry([{ ...mockModel, enabled: true, configured: true }]) }));
  try {
    const supported = await fetch(`${supportedServer.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: supportedOwner.cookie, 'Content-Type': 'application/json' }, body: json({ content: 'use account temperature' }) });
    assert.equal(supported.status, 200); await supported.text();
    assert.equal(actualTemperature, 0.42);

    const unsupported = await fetch(`${unsupportedServer.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: unsupportedOwner.cookie, 'Content-Type': 'application/json' }, body: json({ content: 'do not drop saved temperature' }) });
    assert.equal(unsupported.status, 409); assert.equal((await unsupported.json() as any).code, 'SAVED_PARAMETER_UNSUPPORTED');
    assert.equal(await prisma.conversation.count({ where: { userId: unsupportedOwner.user.id } }), 0);
  } finally {
    await supportedServer.close(); await unsupportedServer.close();
    await prisma.user.deleteMany({ where: { id: { in: [supportedOwner.user.id, unsupportedOwner.user.id] } } });
  }
});

test('legacy registered callers without persisted settings retain configured-default behavior', async () => {
  const owner = await fixture({ withSettings: false });
  const server = await listen(createApp(prisma, {
    provider: mockProvider,
    models: new ModelRegistry([{ ...mockModel, enabled: true, configured: true }]),
    rateLimitStores: testRateLimitStores(),
  }));
  try {
    const response = await fetch(`${server.base}/api/chat/stream`, { method: 'POST', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' }, body: json({ content: 'legacy configured default' }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
    const conversation = await prisma.conversation.findFirst({ where: { userId: owner.user.id }, include: { messages: true } });
    assert.equal(conversation?.selectionMode, 'MANUAL'); assert.equal(conversation?.selectionModelId, null);
    const assistant = conversation?.messages.find(message => message.role === 'assistant');
    assert.equal(assistant?.provider, 'mock'); assert.equal(assistant?.model, 'echo');
    assert.equal(assistant?.requestedSelectionMode, 'MANUAL');
    assert.equal(assistant?.requestedModelId, 'mock:echo');
    assert.equal(assistant?.routingReasonCode, 'legacy_configured_default');
  } finally { await server.close(); await prisma.user.delete({ where: { id: owner.user.id } }); }
});
