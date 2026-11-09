import express from 'express';
import { PrismaClient } from './generated/prisma/client.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { prisma, pool } from './db.js';
import { ModelRegistry, modelRegistry } from './model-registry.js';
import type { AIProvider, GenerationRequest, Usage } from './ai.js';
import { randomUUID } from 'node:crypto';
import { createToken } from './auth.js';

type Call = { started: boolean; blocked: boolean; abortReceived: boolean; completed: boolean };
const calls: Call[] = [];
const testResponsePreference = 'fixture preference must not enter logs';
let releaseFirst!: () => void;
const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

const controlledProvider: AIProvider = {
  id: 'mock',
  async generate() { throw new Error('The browser recovery fixture uses streaming only.'); },
  async stream(request: GenerationRequest) {
    const callIndex = calls.length;
    const state: Call = { started: true, blocked: false, abortReceived: false, completed: false };
    calls.push(state);
    let resolveUsage!: (usage: Usage) => void;
    const usage = new Promise<Usage>(resolve => { resolveUsage = resolve; });
    const chunks = (async function* () {
      try {
        if (callIndex === 0) {
          yield 'partial response';
          state.blocked = true;
          const outcome = await new Promise<'released' | 'aborted'>(resolve => {
            const onAbort = () => { state.abortReceived = true; resolve('aborted'); };
            if (request.signal.aborted) onAbort();
            else request.signal.addEventListener('abort', onAbort, { once: true });
            firstGate.then(() => resolve('released'));
          });
          if (outcome === 'released') {
            yield ' after explicit release';
            state.completed = true;
          }
          resolveUsage({ inputTokens: 11, outputTokens: outcome === 'released' ? 6 : 3 });
        } else {
          yield 'Final controlled response';
          state.completed = true;
          resolveUsage({ inputTokens: 19, outputTokens: 5 });
        }
      } finally {
        if (!state.completed && !state.abortReceived) resolveUsage({ inputTokens: 0, outputTokens: 0 });
      }
    })();
    return { chunks, usage };
  },
};

await prisma.$connect();
const testUser = await prisma.user.create({ data: { email: `browser-recovery-${randomUUID()}@example.test`, settings: { create: { responsePreferences: testResponsePreference } } } });
const testSession = await prisma.session.create({ data: { userId: testUser.id, expiresAt: new Date(Date.now() + 60 * 60_000) } });
const testSessionToken = createToken({ id: testUser.id, guest: false }, testSession.id);
const mockDefinition = modelRegistry.all().find(model => model.id === 'mock:echo')!;
const app = createApp(prisma as PrismaClient, {
  provider: controlledProvider,
  models: new ModelRegistry([{ ...mockDefinition, enabled: true, configured: true }]),
  providerTimeoutMs: 120_000,
});
app.get('/__test/session', (_req, res) => res.json({ token: testSessionToken }));
app.get('/__test/state', async (req, res) => {
  const title = String(req.query.title ?? '');
  const conversation = await prisma.conversation.findFirst({
    where: { title },
    include: { messages: { orderBy: { sequence: 'asc' } }, usageRecords: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conversation) { res.status(404).json({ error: 'Conversation not found.' }); return; }
  const lock = await prisma.conversationGenerationLock.findUnique({ where: { conversationId: conversation.id } });
  res.json({
    conversationId: conversation.id,
    messages: conversation.messages.map(({ id, role, content, status, inputTokens, outputTokens }) => ({ id, role, content, status, inputTokens, outputTokens })),
    usageRecords: conversation.usageRecords.map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens })),
    generationActive: Boolean(lock && lock.expiresAt > new Date()),
    providerCalls: calls.map(call => ({ ...call })),
  });
});
app.post('/__test/release-first', (_req, res) => { releaseFirst(); res.status(204).end(); });

const server = app.listen(config.PORT, () => console.log(`controlled recovery API listening on ${config.PORT}`));
async function shutdown() {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
