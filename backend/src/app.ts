import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { z } from 'zod';
import { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, createToken, readToken, type Principal } from './auth.js';
import { provider, providerRegistry, ProviderRegistry, type AIProvider, type GenerationParameters } from './ai.js';
import { modelRegistry, ModelRegistry, ModelResolutionError, estimateCost } from './model-registry.js';
import { acquireGenerationLock, allocateMessageSequence, consumeGuestQuota, recoverStaleGenerations } from './coordination.js';
import { PostgresRateLimitStore } from './rate-limit-store.js';
import { conversationTitle, requestId, sse } from './utils.js';
import { ContextBudgetError, ContextBuilder } from './context-builder.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const emailSchema = z.string().email().max(254).transform(v => v.toLowerCase());
const credentialsSchema = z.object({ email: emailSchema, password: z.string().min(10).max(128) });
const chatSchema = z.object({ conversationId: z.string().uuid().optional(), content: z.string().trim().min(1).max(240000).optional(), modelId: z.string().min(1).max(120).optional(), parameters: z.record(z.string(), z.unknown()).optional(), regenerate: z.boolean().optional() }).refine(v => v.content || (v.conversationId && v.regenerate), { message: 'A message is required.' });

function cookieOptions() { return { httpOnly: true, sameSite: 'lax' as const, secure: config.NODE_ENV === 'production', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 }; }
function authenticate(prisma: PrismaClient): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.session;
      if (!token) { res.status(401).json({ error: 'Please sign in or continue as a guest.', code: 'UNAUTHENTICATED' }); return; }
      const principal = readToken(token);
      const user = await prisma.user.findUnique({ where: { id: principal.id } });
      const session = await prisma.session.findFirst({ where: { id: principal.sessionId, userId: principal.id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
      if (!user || !session) { res.status(401).json({ error: 'Session expired. Please sign in again.', code: 'SESSION_EXPIRED' }); return; }
      (req as any).principal = { id: user.id, guest: user.isGuest, sessionId: principal.sessionId } satisfies Principal;
      next();
    } catch { res.status(401).json({ error: 'Session expired. Please sign in again.', code: 'SESSION_EXPIRED' }); }
  };
}
const principal = (req: express.Request) => (req as any).principal as Principal;

type AppServices = { provider?: AIProvider; providers?: ProviderRegistry; models?: ModelRegistry; acquireLock?: typeof acquireGenerationLock; consumeQuota?: typeof consumeGuestQuota; allocateSequence?: typeof allocateMessageSequence; providerTimeoutMs?: number; rateLimitStores?: { api: Store; guestCreation: Store } };
export function createApp(prisma: PrismaClient, services: AppServices = {}) {
  const app = express();
  const activeProvider = services.provider ?? provider;
  const models = services.models ?? modelRegistry;
  const providers = services.providers ?? providerRegistry;
  const lockConversation = services.acquireLock ?? acquireGenerationLock;
  const consumeQuota = services.consumeQuota ?? consumeGuestQuota;
  const allocateSequence = services.allocateSequence ?? allocateMessageSequence;
  const contextBuilder = new ContextBuilder();
  const apiRateLimitStore = services.rateLimitStores?.api ?? new PostgresRateLimitStore('api:');
  const guestCreationRateLimitStore = services.rateLimitStores?.guestCreation ?? new PostgresRateLimitStore('guest-create:');
  const createOrderedMessage = async (data: any) => prisma.message.create({ data: { ...data, sequence: await allocateSequence(data.conversationId) } });
  app.disable('x-powered-by');
  app.use((req, res, next) => { const id = requestId(); res.setHeader('X-Request-Id', id); (req as any).id = id; next(); });
  app.use(pinoHttp({
    genReqId: req => (req as any).id,
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'], censor: '[REDACTED]' },
    customLogLevel: (_req, res, err) => err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  }));
  app.use(helmet());
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false, store: apiRateLimitStore }));
  const auth = authenticate(prisma);
  async function issueSession(userId: string, guest: boolean) {
    const expiresAt = new Date(Date.now() + (guest ? 24 : 24 * 7) * 60 * 60 * 1000);
    const session = await prisma.session.create({ data: { userId, expiresAt } });
    return createToken({ id: userId, guest }, session.id);
  }

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'configured', provider: activeProvider.id }));
  app.get('/api/auth/me', auth, async (req, res) => {
    const p = principal(req); const user = await prisma.user.findUnique({ where: { id: p.id }, select: { id: true, email: true, isGuest: true } });
    res.json({ user, provider: activeProvider.id, guestDailyMessageLimit: config.GUEST_DAILY_MESSAGE_LIMIT });
  });
  app.post('/api/auth/guest', rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, store: guestCreationRateLimitStore }), async (_req, res, next) => {
    try {
      const user = await prisma.user.create({ data: { isGuest: true, settings: { create: {} } } });
      res.cookie('session', await issueSession(user.id, true), cookieOptions()).json({ user: { id: user.id, email: null, isGuest: true }, provider: activeProvider.id, guestDailyMessageLimit: config.GUEST_DAILY_MESSAGE_LIMIT });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/register', async (req, res, next) => {
    try {
      const body = credentialsSchema.parse(req.body); const currentToken = req.cookies?.session;
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) { res.status(409).json({ error: 'An account with that email already exists.', code: 'EMAIL_ALREADY_EXISTS' }); return; }
      let user;
      try {
        const p = readToken(currentToken);
        const activeSession = await prisma.session.findFirst({ where: { id: p.sessionId, userId: p.id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
        const guest = activeSession ? await prisma.user.findUnique({ where: { id: p.id } }) : null;
        user = guest?.isGuest ? await prisma.user.update({ where: { id: guest.id }, data: { email: body.email, passwordHash: await hashPassword(body.password), isGuest: false } }) : null;
      } catch { user = null; }
      user ??= await prisma.user.create({ data: { email: body.email, passwordHash: await hashPassword(body.password), settings: { create: {} } } });
      await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      res.cookie('session', await issueSession(user.id, false), cookieOptions()).status(201).json({ user: { id: user.id, email: user.email, isGuest: false } });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const body = credentialsSchema.parse(req.body); const user = await prisma.user.findUnique({ where: { email: body.email } });
      if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, body.password))) { res.status(401).json({ error: 'Email or password is incorrect.', code: 'INVALID_CREDENTIALS' }); return; }
      res.cookie('session', await issueSession(user.id, false), cookieOptions()).json({ user: { id: user.id, email: user.email, isGuest: false } });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/logout', auth, async (req, res) => {
    const p = principal(req);
    await prisma.session.updateMany({ where: { id: p.sessionId, userId: p.id, revokedAt: null }, data: { revokedAt: new Date() } });
    res.clearCookie('session', cookieOptions()).status(204).end();
  });
  app.post('/api/auth/logout-all', auth, async (req, res) => {
    await prisma.session.updateMany({ where: { userId: principal(req).id, revokedAt: null }, data: { revokedAt: new Date() } });
    res.clearCookie('session', cookieOptions()).status(204).end();
  });
  app.get('/api/models', auth, (_req, res) => res.json({ models: models.listForCatalog().map(model => ({
    id: model.id, provider: model.providerId, model: model.providerModelId, label: model.displayName, description: model.description,
    available: model.enabled && model.configured, availability: !model.enabled ? 'disabled' : model.configured ? 'available' : 'provider_not_configured',
    capabilities: model.capabilities, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, parameters: model.parameters,
  })), activeProvider: activeProvider.id }));
  app.get('/api/conversations', auth, async (req, res, next) => {
    try { await recoverStaleGenerations(principal(req).id); const rows = await prisma.conversation.findMany({ where: { userId: principal(req).id }, orderBy: { updatedAt: 'desc' }, include: { messages: { orderBy: { sequence: 'asc' } } } }); res.json({ conversations: rows }); }
    catch (e) { next(e); }
  });
  app.post('/api/conversations', auth, async (req, res, next) => {
    try { const row = await prisma.conversation.create({ data: { userId: principal(req).id, title: 'New chat' } }); res.status(201).json({ conversation: row }); }
    catch (e) { next(e); }
  });
  app.patch('/api/conversations/:id', auth, async (req, res, next) => {
    try { const title = z.object({ title: z.string().trim().min(1).max(80) }).parse(req.body).title; const result = await prisma.conversation.updateMany({ where: { id: String(req.params.id), userId: principal(req).id }, data: { title } }); if (!result.count) { res.status(404).json({ error: 'Conversation not found.', code: 'CONVERSATION_NOT_FOUND' }); return; } res.json({ ok: true }); }
    catch (e) { next(e); }
  });
  app.delete('/api/conversations/:id', auth, async (req, res, next) => {
    try { const result = await prisma.conversation.deleteMany({ where: { id: String(req.params.id), userId: principal(req).id } }); if (!result.count) { res.status(404).json({ error: 'Conversation not found.', code: 'CONVERSATION_NOT_FOUND' }); return; } res.status(204).end(); }
    catch (e) { next(e); }
  });
  app.patch('/api/messages/:id', auth, async (req, res, next) => {
    try {
      const content = z.object({ content: z.string().trim().min(1).max(20000) }).parse(req.body).content;
      const message = await prisma.message.findFirst({ where: { id: String(req.params.id), role: 'user', conversation: { userId: principal(req).id } } });
      if (!message) { res.status(404).json({ error: 'User message not found.', code: 'MESSAGE_NOT_FOUND' }); return; }
      const activeGeneration = await prisma.conversationGenerationLock.findFirst({ where: { conversationId: message.conversationId, expiresAt: { gt: new Date() } }, select: { conversationId: true } });
      if (activeGeneration) { res.status(409).json({ error: 'Messages cannot be edited while a response is being generated.', code: 'GENERATION_ACTIVE' }); return; }
      const messages = await prisma.message.findMany({ where: { conversationId: message.conversationId }, orderBy: { sequence: 'asc' } });
      const index = messages.findIndex(m => m.id === message.id); const later = messages.slice(index + 1).map(m => m.id);
      await prisma.$transaction([prisma.message.update({ where: { id: message.id }, data: { content } }), prisma.message.deleteMany({ where: { id: { in: later } } })]);
      if (index === 0) await prisma.conversation.update({ where: { id: message.conversationId }, data: { title: conversationTitle(content) } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get('/api/usage', auth, async (req, res, next) => {
    try { const rows = await prisma.usageRecord.findMany({ where: { userId: principal(req).id }, orderBy: { createdAt: 'desc' }, take: 100 }); res.json({ usage: rows, totalEstimatedCost: rows.reduce((s, r) => s + r.estimatedCost, 0) }); }
    catch (e) { next(e); }
  });

  app.post('/api/chat/stream', auth, async (req, res, next) => {
    const p = principal(req); const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'INVALID_REQUEST' }); return; }
    const inputBody = parsed.data; let modelEntry;
    try { modelEntry = models.resolve(inputBody.modelId, (inputBody.parameters ?? {}) as Record<string, unknown>); }
    catch (error) { if (error instanceof ModelResolutionError) { res.status(error.httpStatus).json({ error: error.message, code: error.code }); return; } throw error; }
    let generationProvider: AIProvider;
    try {
      generationProvider = services.provider ?? providers.resolve(modelEntry.providerId);
      if (generationProvider.id !== modelEntry.providerId) { res.status(503).json({ error: `Provider '${modelEntry.providerId}' is unavailable in this server configuration.`, code: 'MODEL_UNAVAILABLE' }); return; }
    } catch { res.status(503).json({ error: `Provider '${modelEntry.providerId}' is unavailable in this server configuration.`, code: 'MODEL_UNAVAILABLE' }); return; }
    const generationParameters: GenerationParameters = {
      ...(inputBody.parameters as GenerationParameters | undefined ?? {}),
      maxOutputTokens: (inputBody.parameters?.maxOutputTokens as number | undefined) ?? Math.min(config.MAX_OUTPUT_TOKENS, modelEntry.maxOutputTokens),
    };
    const controller = new AbortController(); let disconnected = false; let abortSource: 'provider_timeout' | 'request_aborted' | 'response_closed' | undefined; let answer = ''; let lastProgressPersistAt = 0; let assistantId: string | undefined; let releaseGeneration: (() => Promise<void>) | undefined;
    const timeout = setTimeout(() => { abortSource = 'provider_timeout'; controller.abort(new Error('Provider timeout')); }, services.providerTimeoutMs ?? config.PROVIDER_TIMEOUT_MS);
    req.on('aborted', () => { disconnected = true; abortSource ??= 'request_aborted'; controller.abort(); });
    res.on('close', () => { if (!res.writableEnded) { disconnected = true; abortSource ??= 'response_closed'; controller.abort(); } });
    try {
      let conversation = inputBody.conversationId ? await prisma.conversation.findFirst({ where: { id: inputBody.conversationId, userId: p.id } }) : null;
      if (inputBody.conversationId && !conversation) { res.status(404).json({ error: 'Conversation not found.', code: 'CONVERSATION_NOT_FOUND' }); return; }
      if (!conversation && inputBody.content) conversation = await prisma.conversation.create({ data: { userId: p.id, title: conversationTitle(inputBody.content) } });
      if (!conversation) { res.status(400).json({ error: 'Conversation not found.', code: 'CONVERSATION_NOT_FOUND' }); return; }
      releaseGeneration = await lockConversation(conversation.id) ?? undefined;
      if (!releaseGeneration) { res.status(409).json({ error: 'A response is already being generated for this conversation.', code: 'GENERATION_ACTIVE' }); return; }
      await prisma.message.updateMany({ where: { conversationId: conversation.id, status: 'streaming' }, data: { status: 'error', error: 'A previous generation was interrupted before it completed.' } });
      if (inputBody.regenerate) {
        const lastUser = await prisma.message.findFirst({ where: { conversationId: conversation.id, role: 'user' }, orderBy: { sequence: 'desc' } });
        if (!lastUser) { res.status(400).json({ error: 'There is no user message to regenerate.', code: 'NO_MESSAGE_TO_REGENERATE' }); return; }
      }
      if (inputBody.content && p.guest && !(await consumeQuota(p.id, config.GUEST_DAILY_MESSAGE_LIMIT))) { res.status(429).json({ error: 'Guest daily message limit reached. Create a free account to continue.', code: 'GUEST_QUOTA_EXCEEDED' }); return; }
      let userMessage;
      if (inputBody.content) {
        const isFirst = !(await prisma.message.count({ where: { conversationId: conversation.id, role: 'user' } }));
        userMessage = await createOrderedMessage({ conversationId: conversation.id, role: 'user', content: inputBody.content });
        if (isFirst) await prisma.conversation.update({ where: { id: conversation.id }, data: { title: conversationTitle(inputBody.content) } });
      }
      else userMessage = await prisma.message.findFirst({ where: { conversationId: conversation.id, role: 'user' }, orderBy: { sequence: 'desc' } });
      if (!userMessage) { res.status(400).json({ error: 'There is no user message to answer.', code: 'NO_MESSAGE_TO_ANSWER' }); return; }
      if (inputBody.regenerate) await prisma.message.deleteMany({ where: { conversationId: conversation.id, role: 'assistant', sequence: { gt: userMessage.sequence } } });
      const history = await prisma.message.findMany({ where: { conversationId: conversation.id, sequence: { lte: userMessage.sequence } }, orderBy: { sequence: 'asc' }, select: { id: true, role: true, content: true, sequence: true } });
      const settings = await prisma.userSettings.findUnique({ where: { userId: p.id }, select: { responsePreferences: true } });
      let builtContext;
      try {
        builtContext = await contextBuilder.build({
          model: modelEntry, messages: history.map(m => ({ ...m, role: m.role as 'user' | 'assistant' })), currentUserMessageId: userMessage.id,
          responsePreferences: settings?.responsePreferences ?? '', reservedOutputTokens: generationParameters.maxOutputTokens!, signal: controller.signal,
          countInputTokens: generationProvider.countInputTokens ? (input, systemInstructions, responsePreferences, signal) => generationProvider.countInputTokens!({ input, providerModelId: modelEntry.providerModelId, signal, systemInstructions, responsePreferences }) : undefined,
        });
      } catch (error) {
        if (error instanceof ContextBudgetError) { res.status(413).json({ error: error.message, code: error.code }); return; }
        throw error;
      }
      const context = builtContext.messages;
      logger.info({ requestId: (req as any).id, conversationId: conversation.id, model: modelEntry.id, ...builtContext.diagnostics }, 'chat context constructed');
      const assistant = await createOrderedMessage({ conversationId: conversation.id, role: 'assistant', content: '', status: 'streaming', provider: generationProvider.id, model: modelEntry.providerModelId });
      assistantId = assistant.id;
      await prisma.conversation.update({ where: { id: conversation.id }, data: { provider: generationProvider.id, model: modelEntry.providerModelId } });
      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      sse(res, 'meta', { conversationId: conversation.id, userMessageId: userMessage.id, assistantMessageId: assistant.id, provider: generationProvider.id, model: modelEntry.providerModelId, mock: generationProvider.id === 'mock' });
      const generation = await generationProvider.stream({ input: context.map(m => ({ role: m.role, content: m.content })), modelId: modelEntry.id, providerModelId: modelEntry.providerModelId, parameters: generationParameters, signal: controller.signal, systemInstructions: builtContext.systemInstructions, responsePreferences: builtContext.responsePreferences });
      for await (const chunk of generation.chunks) {
        if (controller.signal.aborted || disconnected) break;
        answer += chunk;
        const now = Date.now();
        if (!lastProgressPersistAt || now - lastProgressPersistAt >= 250) {
          await prisma.message.update({ where: { id: assistant.id }, data: { content: answer } });
          lastProgressPersistAt = now;
        }
        sse(res, 'delta', { text: chunk });
      }
      const usage = await generation.usage;
      const inputTokens = usage.inputTokens || builtContext.diagnostics.estimatedInputTokens;
      const outputTokens = usage.outputTokens || Math.ceil(answer.length / 4);
      const cost = estimateCost(modelEntry.id, inputTokens, outputTokens);
      const status = disconnected || controller.signal.aborted ? (answer ? 'partial' : 'cancelled') : 'complete';
      await prisma.message.update({ where: { id: assistant.id }, data: { content: answer, status, inputTokens, outputTokens, estimatedCost: cost } });
      await prisma.usageRecord.create({ data: { userId: p.id, conversationId: conversation.id, messageId: assistant.id, provider: generationProvider.id, model: modelEntry.providerModelId, inputTokens, outputTokens, estimatedCost: cost } });
      if (!disconnected) { sse(res, 'done', { status, inputTokens, outputTokens, estimatedCost: cost }); res.end(); }
      logger.info({ requestId: (req as any).id, conversationId: conversation.id, provider: generationProvider.id, model: modelEntry.providerModelId, status, terminationCause: abortSource ?? null, providerReportedInputTokens: usage.inputTokens || null, contextEstimatedInputTokens: builtContext.diagnostics.estimatedInputTokens, recordedInputTokens: inputTokens, providerReportedOutputTokens: usage.outputTokens || null, recordedOutputTokens: outputTokens, estimatedCost: cost }, 'chat generation finished');
    } catch (error: any) {
      if (assistantId) await prisma.message.update({ where: { id: assistantId }, data: { content: answer, status: answer ? 'partial' : 'error', error: controller.signal.aborted ? 'Generation cancelled or timed out.' : 'Provider request failed.' } }).catch(() => {});
      const code = error?.code && typeof error.code === 'string' ? error.code : controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_FAILURE';
      const message = controller.signal.aborted ? 'Generation timed out or was interrupted. Retry to continue.' : 'Generation failed. Retry the response.';
      if (!disconnected && res.headersSent) { sse(res, 'error', { error: message, code, partial: Boolean(answer) }); res.end(); }
      else if (!res.headersSent) {
        if (controller.signal.aborted) res.status(504).json({ error: message, code: 'PROVIDER_TIMEOUT' });
        else next(error);
      }
    } finally {
      clearTimeout(timeout);
      await releaseGeneration?.().catch(() => {});
    }
  });

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, requestId: (req as any).id }, 'request failed');
    if (res.headersSent) { res.end(); return; }
    if (err instanceof z.ZodError) { res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid request.', code: 'INVALID_REQUEST' }); return; }
    res.status(500).json({ error: 'Something went wrong. Please retry.', code: 'INTERNAL_ERROR', requestId: (req as any).id });
  });
  return app;
}
