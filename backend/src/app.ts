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
import { randomUUID } from 'node:crypto';
import { provider, providerRegistry, ProviderRegistry, ProviderError, type AIProvider, type GenerationParameters } from './ai.js';
import { modelRegistry, ModelRegistry, ModelResolutionError } from './model-registry.js';
import { acquireGenerationLock, allocateMessageSequence, consumeGuestQuota, recoverStaleGenerations } from './coordination.js';
import { PostgresRateLimitStore } from './rate-limit-store.js';
import { conversationTitle, requestId, sse } from './utils.js';
import { ContextBudgetError, ContextBuilder } from './context-builder.js';
import { pool } from './db.js';
import { enqueueSummaryJob, enqueueSummaryJobTx, noteTranscriptMutation } from './summary-queue.js';
import { deliverUsageOutbox, enqueueUsageEvent } from './usage-outbox.js';
import { createMemoriesRouter, createMemoryRouter } from './memory-routes.js';
import { retrieveMemories } from './memory-retrieval.js';
import { classifyTask, type PublicTaskType } from './task-classifier.js';
import { ModelRouter } from './model-router.js';
import { buildUsageBreakdown, encodeUsageCursor, normalizeCurrencyCostGroups, parseUsageReportFilters, periodWhere, roundEstimatedCost, usageRecordWhere } from './usage-report.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const emailSchema = z.string().email().max(254).transform(v => v.toLowerCase());
const credentialsSchema = z.object({ email: emailSchema, password: z.string().min(10).max(128) });
const publicTaskTypes = ['general_conversation', 'complex_reasoning', 'coding', 'writing', 'document_analysis', 'research', 'vision', 'structured_extraction', 'tool_intensive'] as const;
const chatSchema = z.object({ conversationId: z.string().uuid().optional(), content: z.string().trim().min(1).max(240000).optional(), selectionMode: z.enum(['AUTO', 'MANUAL']).optional(), modelId: z.string().min(1).max(120).optional(), taskType: z.enum(publicTaskTypes).optional(), parameters: z.record(z.string(), z.unknown()).optional(), regenerate: z.boolean().optional() }).refine(v => v.content || (v.conversationId && v.regenerate), { message: 'A message is required.' });
const settingsPatchSchema = z.object({ selectionMode: z.enum(['AUTO', 'MANUAL']).optional(), defaultModelId: z.string().min(1).max(120).optional(), temperature: z.number().finite().nullable().optional(), responsePreferences: z.string().max(4000).optional(), memoryEnabled: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0, 'At least one setting is required.');
const conversationSelectionSchema = z.object({ selectionMode: z.enum(['AUTO', 'MANUAL']), selectionModelId: z.string().min(1).max(120).optional() }).strict();
const accountModelId = (settings: { provider: string; model: string }) => `${settings.provider}:${settings.model}`;

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

type AppServices = { provider?: AIProvider; providers?: ProviderRegistry; models?: ModelRegistry; acquireLock?: typeof acquireGenerationLock; consumeQuota?: typeof consumeGuestQuota; allocateSequence?: typeof allocateMessageSequence; providerTimeoutMs?: number; rateLimitStores?: { api: Store; guestCreation: Store; memoryExtraction?: Store }; persistAssistantMessage?: (messageId: string, data: any, client?: any) => Promise<unknown>; createUsageRecord?: (data: any) => Promise<unknown>; enqueueSummary?: (conversationId: string, sequence: number) => Promise<void>; deliverUsage?: (idempotencyKey: string) => Promise<boolean> };
export function createApp(prisma: PrismaClient, services: AppServices = {}) {
  const app = express();
  const activeProvider = services.provider ?? provider;
  const models = services.models ?? modelRegistry;
  const modelRouter = new ModelRouter(models);
  const providers = services.providers ?? providerRegistry;
  const lockConversation = services.acquireLock ?? acquireGenerationLock;
  const consumeQuota = services.consumeQuota ?? consumeGuestQuota;
  const allocateSequence = services.allocateSequence ?? allocateMessageSequence;
  const persistAssistantMessage = services.persistAssistantMessage ?? ((messageId, data, client = prisma) => client.message.update({ where: { id: messageId }, data }));
  const enqueueSummary = services.enqueueSummary ?? ((conversationId, sequence) => enqueueSummaryJob(pool, conversationId, sequence));
  const deliverUsage = services.deliverUsage ?? ((key) => deliverUsageOutbox(pool, key));
  const contextBuilder = new ContextBuilder();
  const apiRateLimitStore = services.rateLimitStores?.api ?? new PostgresRateLimitStore('api:');
  const guestCreationRateLimitStore = services.rateLimitStores?.guestCreation ?? new PostgresRateLimitStore('guest-create:');
  const memoryExtractionRateLimitStore = services.rateLimitStores?.memoryExtraction ?? new PostgresRateLimitStore('memory-extraction:');
  const memoryDependencies = { prisma, pool, providers, models, extractionStore: memoryExtractionRateLimitStore, defaultProvider: activeProvider, deliverUsage };
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
  app.use('/api/memory', auth, createMemoryRouter(memoryDependencies));
  app.use('/api/memories', auth, createMemoriesRouter(memoryDependencies));
  async function issueSession(userId: string, guest: boolean) {
    const expiresAt = new Date(Date.now() + (guest ? 24 : 24 * 7) * 60 * 60 * 1000);
    const session = await prisma.session.create({ data: { userId, expiresAt } });
    return createToken({ id: userId, guest }, session.id);
  }

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'configured', provider: activeProvider?.id ?? null }));
  app.get('/api/auth/me', auth, async (req, res) => {
    const p = principal(req); const user = await prisma.user.findUnique({ where: { id: p.id }, select: { id: true, email: true, isGuest: true } });
    res.json({ user, provider: activeProvider?.id ?? null, guestDailyMessageLimit: config.GUEST_DAILY_MESSAGE_LIMIT });
  });
  app.post('/api/auth/guest', rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, store: guestCreationRateLimitStore }), async (_req, res, next) => {
    try {
      const user = await prisma.user.create({ data: { isGuest: true } });
      res.cookie('session', await issueSession(user.id, true), cookieOptions()).json({ user: { id: user.id, email: null, isGuest: true }, provider: activeProvider?.id ?? null, guestDailyMessageLimit: config.GUEST_DAILY_MESSAGE_LIMIT });
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
      if (user) await prisma.userSettings.upsert({ where: { userId: user.id }, create: { userId: user.id, selectionMode: 'AUTO' }, update: { selectionMode: 'AUTO' } });
      user ??= await prisma.user.create({ data: { email: body.email, passwordHash: await hashPassword(body.password), settings: { create: { selectionMode: 'AUTO' } } } });
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
    capabilities: model.capabilities, taskSuitability: model.taskSuitability ?? null, qualityEvidence: model.qualityEvidence ?? null,
    contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, parameters: model.parameters,
  })), activeProvider: activeProvider?.id ?? null }));
  app.get('/api/settings', auth, async (req, res, next) => {
    try {
      const p = principal(req);
      if (p.guest) { res.status(403).json({ error: 'Account settings require a registered account.', code: 'SETTINGS_REGISTERED_ACCOUNT_REQUIRED' }); return; }
      const settings = await prisma.userSettings.upsert({ where: { userId: p.id }, create: { userId: p.id }, update: {} });
      const modelId = accountModelId(settings);
      const model = models.find(modelId);
      const availability = !model ? 'model_not_found' : !model.enabled ? 'disabled' : !model.configured ? 'provider_not_configured' : 'available';
      const temperatureRule = model?.parameters.temperature;
      res.json({ settings: { selectionMode: settings.selectionMode, defaultModelId: modelId, defaultModelAvailability: { status: availability, modelId }, temperature: settings.temperature, temperatureSupported: settings.temperature === null ? null : Boolean(temperatureRule && settings.temperature >= temperatureRule.min && settings.temperature <= temperatureRule.max), responsePreferences: settings.responsePreferences, memoryEnabled: settings.memoryEnabled } });
    } catch (error) { next(error); }
  });
  app.patch('/api/settings', auth, async (req, res, next) => {
    try {
      const p = principal(req);
      if (p.guest) { res.status(403).json({ error: 'Account settings require a registered account.', code: 'SETTINGS_REGISTERED_ACCOUNT_REQUIRED' }); return; }
      const parsed = settingsPatchSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings.', code: 'VALIDATION_ERROR' }); return; }
      const current = await prisma.userSettings.upsert({ where: { userId: p.id }, create: { userId: p.id }, update: {} });
      const targetId = parsed.data.defaultModelId ?? accountModelId(current);
      const targetModel = models.find(targetId);
      if (parsed.data.defaultModelId) {
        if (!targetModel) { res.status(400).json({ error: 'Unknown model ID. Choose a model returned by GET /api/models.', code: 'MODEL_NOT_FOUND' }); return; }
        if (!targetModel.enabled || !targetModel.configured) { res.status(503).json({ error: `${targetModel.displayName} is unavailable because its provider is disabled or not configured.`, code: 'MODEL_UNAVAILABLE' }); return; }
      }
      const nextTemperature = parsed.data.temperature !== undefined ? parsed.data.temperature : current.temperature;
      if (nextTemperature !== null && (parsed.data.temperature !== undefined || parsed.data.defaultModelId !== undefined)) {
        if (!targetModel) { res.status(409).json({ error: 'The saved temperature cannot be validated because its saved model is unknown.', code: 'SAVED_PARAMETER_UNSUPPORTED' }); return; }
        try { models.validateParameters(targetModel, { temperature: nextTemperature }, 'SAVED_PARAMETER_UNSUPPORTED'); }
        catch (error) { if (error instanceof ModelResolutionError) { res.status(error.httpStatus).json({ error: error.message, code: error.code }); return; } throw error; }
      }
      const data: any = {};
      if (parsed.data.selectionMode !== undefined) data.selectionMode = parsed.data.selectionMode;
      if (parsed.data.defaultModelId !== undefined) { data.provider = targetModel!.providerId; data.model = targetModel!.providerModelId; }
      if (parsed.data.temperature !== undefined) data.temperature = parsed.data.temperature;
      if (parsed.data.responsePreferences !== undefined) data.responsePreferences = parsed.data.responsePreferences;
      if (parsed.data.memoryEnabled !== undefined) data.memoryEnabled = parsed.data.memoryEnabled;
      const updated = await prisma.userSettings.update({ where: { userId: p.id }, data });
      const modelId = accountModelId(updated); const savedModel = models.find(modelId); const rule = savedModel?.parameters.temperature;
      const status = !savedModel ? 'model_not_found' : !savedModel.enabled ? 'disabled' : !savedModel.configured ? 'provider_not_configured' : 'available';
      res.json({ settings: { selectionMode: updated.selectionMode, defaultModelId: modelId, defaultModelAvailability: { status, modelId }, temperature: updated.temperature, temperatureSupported: updated.temperature === null ? null : Boolean(rule && updated.temperature >= rule.min && updated.temperature <= rule.max), responsePreferences: updated.responsePreferences, memoryEnabled: updated.memoryEnabled } });
    } catch (error) { next(error); }
  });
  app.get('/api/conversations', auth, async (req, res, next) => {
    try { await recoverStaleGenerations(principal(req).id); const rows = await prisma.conversation.findMany({ where: { userId: principal(req).id }, orderBy: { updatedAt: 'desc' }, include: { messages: { orderBy: { sequence: 'asc' } } } }); res.json({ conversations: rows }); }
    catch (e) { next(e); }
  });
  app.post('/api/conversations', auth, async (req, res, next) => {
    try {
      const p = principal(req);
      const settings = p.guest ? null : await prisma.userSettings.findUnique({ where: { userId: p.id } });
      const selectionMode = settings?.selectionMode ?? 'MANUAL';
      const selectionModelId = !p.guest && settings && selectionMode === 'MANUAL' ? accountModelId(settings) : null;
      const row = await prisma.conversation.create({ data: { userId: p.id, title: 'New chat', selectionMode, selectionModelId } });
      res.status(201).json({ conversation: row });
    }
    catch (e) { next(e); }
  });
  app.patch('/api/conversations/:id/model-selection', auth, async (req, res, next) => {
    try {
      const p = principal(req);
      if (p.guest) { res.status(403).json({ error: 'Guests may select a model per request only.', code: 'GUEST_CONVERSATION_SELECTION_UNAVAILABLE' }); return; }
      const parsed = conversationSelectionSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid conversation selection.', code: 'VALIDATION_ERROR' }); return; }
      if (parsed.data.selectionMode === 'AUTO' && parsed.data.selectionModelId) { res.status(400).json({ error: 'Auto selection cannot include a manual model ID.', code: 'SELECTION_CONFLICT' }); return; }
      const conversationId = String(req.params.id);
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: p.id } });
      if (!conversation) { res.status(404).json({ error: 'Conversation not found.', code: 'CONVERSATION_NOT_FOUND' }); return; }
      const lock = await prisma.conversationGenerationLock.findFirst({ where: { conversationId, expiresAt: { gt: new Date() } }, select: { conversationId: true } });
      if (lock) { res.status(409).json({ error: 'Selection cannot be changed while a response is being generated.', code: 'GENERATION_ACTIVE' }); return; }
      let selectionModelId: string | null = null;
      if (parsed.data.selectionMode === 'MANUAL' && parsed.data.selectionModelId) {
        let model;
        try { model = models.resolve(parsed.data.selectionModelId); }
        catch (error) { if (error instanceof ModelResolutionError) { res.status(error.httpStatus).json({ error: error.message, code: error.code }); return; } throw error; }
        const settings = await prisma.userSettings.findUnique({ where: { userId: p.id } });
        try { if (settings?.temperature !== null && settings) models.validateParameters(model, { temperature: settings.temperature }, 'SAVED_PARAMETER_UNSUPPORTED'); }
        catch (error) { if (error instanceof ModelResolutionError) { res.status(error.httpStatus).json({ error: error.message, code: error.code }); return; } throw error; }
        selectionModelId = model.id;
      }
      const updated = await prisma.conversation.update({ where: { id: conversationId }, data: { selectionMode: parsed.data.selectionMode, selectionModelId } });
      res.json({ conversation: updated });
    } catch (error) { next(error); }
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
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${message.conversationId}::uuid FOR UPDATE`;
        await noteTranscriptMutation(tx, message.conversationId, message.sequence);
        await tx.message.update({ where: { id: message.id }, data: { content } });
        if (later.length) await tx.message.deleteMany({ where: { id: { in: later } } });
        if (index === 0) await tx.conversation.update({ where: { id: message.conversationId }, data: { title: conversationTitle(content) } });
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get('/api/usage', auth, async (req, res, next) => {
    try {
      const parsed = parseUsageReportFilters(req.query);
      if (parsed.error) { res.status(400).json({ error: parsed.error, code: 'VALIDATION_ERROR', requestId: (req as any).id }); return; }
      const filters = parsed.filters!;
      const userId = principal(req).id;
      const recentWhere = usageRecordWhere(userId, filters);
      const pageWhere = usageRecordWhere(userId, filters, true);
      const reportWhere = periodWhere(userId, filters);
      const requestOperations = filters.operation === 'provider_attempt' ? [] : filters.operation ? [filters.operation] : ['chat', 'summary', 'memory_extraction'];
      const requestCountQuery = requestOperations.length
        ? prisma.usageRecord.count({ where: { ...reportWhere, operation: { in: requestOperations } } as any })
        : Promise.resolve(0);
      const select = { id: true, conversationId: true, messageId: true, provider: true, model: true, inputTokens: true, outputTokens: true, estimatedInputTokens: true, estimatedOutputTokens: true, usageStatus: true, estimatedCost: true, pricingCurrency: true, pricingVersion: true, pricingEffectiveAt: true, operation: true, attemptId: true, attemptNumber: true, errorCode: true, createdAt: true };
      const [pagePlusOne, totalCount, recentRows, totals, costGroups, providerGroups, modelGroups, operationGroups, requestCount, providerAttemptCount, failedProviderAttemptCount, unknownUsageCount, partialUsageCount, estimatedUsageCount, providerReportedUsageCount, legacyUsageCount] = await Promise.all([
        prisma.usageRecord.findMany({ where: pageWhere as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: filters.limit + 1, select }),
        prisma.usageRecord.count({ where: recentWhere as any }),
        prisma.usageRecord.findMany({ where: recentWhere as any, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, select: { estimatedCost: true, pricingCurrency: true } }),
        prisma.usageRecord.aggregate({ where: reportWhere as any, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, estimatedInputTokens: true, estimatedOutputTokens: true } }),
        prisma.usageRecord.groupBy({ by: ['pricingCurrency'], where: reportWhere as any, _sum: { estimatedCost: true }, _count: { _all: true, estimatedCost: true } }),
        prisma.usageRecord.groupBy({ by: ['provider', 'pricingCurrency'], where: reportWhere as any, _sum: { estimatedCost: true }, _count: { _all: true, estimatedCost: true } }),
        prisma.usageRecord.groupBy({ by: ['model', 'pricingCurrency'], where: reportWhere as any, _sum: { estimatedCost: true }, _count: { _all: true, estimatedCost: true } }),
        prisma.usageRecord.groupBy({ by: ['operation', 'pricingCurrency'], where: reportWhere as any, _sum: { estimatedCost: true }, _count: { _all: true, estimatedCost: true } }),
        requestCountQuery,
        prisma.usageRecord.count({ where: { ...reportWhere, operation: 'provider_attempt' } as any }),
        prisma.usageRecord.count({ where: { ...reportWhere, operation: 'provider_attempt', errorCode: { not: null } } as any }),
        prisma.usageRecord.count({ where: { ...reportWhere, usageStatus: 'unknown' } as any }),
        prisma.usageRecord.count({ where: { ...reportWhere, usageStatus: 'partial' } as any }),
        prisma.usageRecord.count({ where: { ...reportWhere, usageStatus: 'estimated' } as any }),
        prisma.usageRecord.count({ where: { ...reportWhere, usageStatus: 'provider_reported' } as any }),
        prisma.usageRecord.count({ where: { ...reportWhere, usageStatus: 'legacy' } as any }),
      ]);
      const hasMore = pagePlusOne.length > filters.limit;
      const usage = pagePlusOne.slice(0, filters.limit);
      const last = usage.at(-1);
      const recentCosts = new Map<string, number>();
      for (const row of recentRows) if (row.estimatedCost !== null) {
        const currency = row.pricingCurrency ?? 'USD';
        recentCosts.set(currency, (recentCosts.get(currency) ?? 0) + row.estimatedCost);
      }
      const recentEstimatedCostByCurrency = [...recentCosts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: roundEstimatedCost(amount) }));
      const totalEstimatedCost = recentEstimatedCostByCurrency.length > 1 ? null : recentEstimatedCostByCurrency[0]?.amount ?? 0;
      const costByCurrency = normalizeCurrencyCostGroups(costGroups as any);
      const knownCurrencyBuckets = costByCurrency.filter(item => item.currency !== 'UNKNOWN' && item.pricedRecordCount > 0);
      const periodHasUnknownCost = costByCurrency.some(item => item.unknownCostRecordCount > 0);
      const periodTotalEstimatedCost = knownCurrencyBuckets.length === 1 && !periodHasUnknownCost
        ? knownCurrencyBuckets[0]!.estimatedCost : totals._count._all === 0 ? 0 : null;
      res.json({
        usage, totalEstimatedCost, recentEstimatedCostByCurrency,
        totalCount,
        pagination: { limit: filters.limit, hasMore, nextCursor: hasMore && last ? encodeUsageCursor({ createdAt: last.createdAt, id: last.id }) : null },
        period: {
          from: filters.periodFrom.toISOString().slice(0, 10),
          to: new Date(filters.periodToExclusive.valueOf() - 86_400_000).toISOString().slice(0, 10),
          timezone: 'UTC', recordCount: totals._count._all, requestCount, providerAttemptCount, failedProviderAttemptCount,
          estimatedCostByCurrency: costByCurrency,
          totalEstimatedCost: periodTotalEstimatedCost,
          tokens: {
            providerReportedInput: totals._sum.inputTokens ?? 0, providerReportedOutput: totals._sum.outputTokens ?? 0,
            estimatedInput: totals._sum.estimatedInputTokens ?? 0, estimatedOutput: totals._sum.estimatedOutputTokens ?? 0,
          },
          usageStatusCounts: { provider_reported: providerReportedUsageCount, estimated: estimatedUsageCount, partial: partialUsageCount, unknown: unknownUsageCount, legacy: legacyUsageCount },
          providerBreakdown: buildUsageBreakdown(providerGroups as any, 'provider'),
          modelBreakdown: buildUsageBreakdown(modelGroups as any, 'model'),
          operationBreakdown: buildUsageBreakdown(operationGroups as any, 'operation'),
        },
      });
    }
    catch (e) { next(e); }
  });

  app.post('/api/chat/stream', auth, async (req, res, next) => {
    const p = principal(req); const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'INVALID_REQUEST' }); return; }
    const inputBody = parsed.data;
    if (inputBody.selectionMode === 'AUTO' && inputBody.modelId) { res.status(400).json({ error: 'Auto selection cannot include a manual model ID.', code: 'SELECTION_CONFLICT' }); return; }
    const settings = p.guest ? null : await prisma.userSettings.findUnique({ where: { userId: p.id } });
    let conversation = inputBody.conversationId ? await prisma.conversation.findFirst({ where: { id: inputBody.conversationId, userId: p.id } }) : null;
    if (inputBody.conversationId && !conversation) { res.status(404).json({ error: 'Conversation not found.', code: 'CONVERSATION_NOT_FOUND' }); return; }
    const inheritedMode = p.guest ? 'MANUAL' : settings?.selectionMode ?? 'MANUAL';
    const inheritedModelId = !p.guest && inheritedMode === 'MANUAL' && settings ? accountModelId(settings) : null;
    const effectiveMode = inputBody.selectionMode ?? (inputBody.modelId ? 'MANUAL' : conversation?.selectionMode ?? inheritedMode);
    const selectedModelId = inputBody.modelId ?? (conversation?.selectionMode === 'MANUAL' ? conversation.selectionModelId : null) ?? inheritedModelId ?? (settings ? accountModelId(settings) : undefined);
    const applySavedTemperature = Boolean(!inputBody.modelId && settings?.temperature !== null && settings && inputBody.parameters?.temperature === undefined);
    const requestedParameters: Record<string, unknown> = {
      ...(inputBody.parameters as Record<string, unknown> | undefined ?? {}),
      ...(applySavedTemperature && settings?.temperature !== null && settings ? { temperature: settings.temperature } : {}),
    };
    const routeText = inputBody.content ?? (conversation && inputBody.regenerate
      ? (await prisma.message.findFirst({ where: { conversationId: conversation.id, role: 'user' }, orderBy: { sequence: 'desc' }, select: { content: true } }))?.content ?? ''
      : '');
    const task = classifyTask(routeText, inputBody.taskType as PublicTaskType | undefined);
    const minimumInputTokens = Math.max(1, Math.ceil(routeText.length / 4));
    const resolveProvider = (providerId: string) => services.provider?.id === providerId ? services.provider : providers.resolve(providerId);
    let modelEntry: ReturnType<ModelRegistry['resolve']> | undefined;
    let routingCandidates: { model: ReturnType<ModelRegistry['resolve']>; reasonCode: string }[] = [];
    let policyVersion: string | null = null;
    try {
      if (effectiveMode === 'AUTO') {
        const plan = modelRouter.plan({ task, parameters: requestedParameters, estimatedInputTokens: minimumInputTokens,
          reservedOutputTokens: Number(inputBody.parameters?.maxOutputTokens ?? config.MAX_OUTPUT_TOKENS),
          parameterErrorCode: applySavedTemperature ? 'SAVED_PARAMETER_UNSUPPORTED' : 'UNSUPPORTED_PARAMETER',
          preferredModelId: settings ? accountModelId(settings) : null,
          providerAvailable: providerId => providerId === services.provider?.id || providers.has(providerId),
          allowMock: config.MOCK_PROVIDER_ENABLED && config.NODE_ENV !== 'production' });
        policyVersion = plan.policyVersion;
        if (plan.failureCode) {
          const status = plan.failureCode === 'TASK_CAPABILITY_UNAVAILABLE' ? 422 : plan.failureCode === 'CONTEXT_TOO_LARGE' ? 413 : 503;
          const message = plan.failureCode === 'TASK_CAPABILITY_UNAVAILABLE' ? `No configured model supports the required capability for task '${task.taskType}'.`
            : plan.failureCode === 'CONTEXT_TOO_LARGE' ? 'The current message and reserved response do not fit any eligible model context window.'
              : 'No configured model is eligible for automatic selection.';
          res.status(status).json({ error: message, code: plan.failureCode, requestId: (req as any).id }); return;
        }
        routingCandidates = plan.candidates;
      } else {
        const manualEntry = models.resolve(selectedModelId, (inputBody.parameters as Record<string, unknown> | undefined) ?? {});
        modelEntry = manualEntry;
        if (applySavedTemperature && settings?.temperature !== null && settings) models.validateParameters(manualEntry, { temperature: settings.temperature }, 'SAVED_PARAMETER_UNSUPPORTED');
        if (!task.requiredCapabilities.every(capability => manualEntry.capabilities[capability as keyof typeof manualEntry.capabilities] === true)) {
          res.status(422).json({ error: `The selected model does not support the required capability for task '${task.taskType}'.`, code: 'TASK_CAPABILITY_UNAVAILABLE', requestId: (req as any).id }); return;
        }
        const selectedProvider = resolveProvider(manualEntry.providerId);
        if (selectedProvider.id !== manualEntry.providerId) throw new ModelResolutionError('MODEL_UNAVAILABLE', `Provider '${manualEntry.providerId}' is unavailable in this server configuration.`, 503);
        routingCandidates = [{ model: manualEntry, reasonCode: inputBody.modelId ? 'explicit_model_selection' : conversation?.selectionMode === 'MANUAL' && conversation.selectionModelId ? 'conversation_selection' : settings ? 'account_default' : 'legacy_configured_default' }];
      }
    } catch (error) { if (error instanceof ModelResolutionError) { res.status(error.httpStatus).json({ error: error.message, code: error.code, requestId: (req as any).id }); return; } throw error; }
    const controller = new AbortController(); let disconnected = false; let abortSource: 'provider_timeout' | 'request_aborted' | 'response_closed' | 'persistence_failure' | undefined; let answer = ''; let lastProgressPersistAt = 0; let assistantId: string | undefined; let assistantFinalized = false; let releaseGeneration: (() => Promise<void>) | undefined;
    let cleanupActiveAttempt: (() => void) | undefined;
    let recordCurrentAttemptFailure: ((messageId: string, errorCode: string) => Promise<{ inputTokens: number | null; outputTokens: number | null; estimatedInputTokens: number | null; estimatedOutputTokens: number | null; usageStatus: 'provider_reported' | 'estimated' | 'partial' | 'unknown'; estimatedCost: number | null }>) | undefined;
    let currentAttemptFailureRecorded = false;
    req.on('aborted', () => { disconnected = true; abortSource ??= 'request_aborted'; controller.abort(); });
    res.on('close', () => { if (!res.writableEnded) { disconnected = true; abortSource ??= 'response_closed'; controller.abort(); } });
    try {
      if (!conversation && inputBody.content) conversation = await prisma.conversation.create({ data: { userId: p.id, title: conversationTitle(inputBody.content), selectionMode: inheritedMode, selectionModelId: inheritedModelId } });
      if (!conversation) { res.status(400).json({ error: 'Conversation not found.', code: 'CONVERSATION_NOT_FOUND' }); return; }
      const activeConversation = conversation;
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
      if (inputBody.regenerate) {
        const priorResponses = await prisma.message.findMany({ where: { conversationId: conversation.id, role: 'assistant', sequence: { gt: userMessage.sequence } }, select: { sequence: true } });
        if (priorResponses.length) {
          const activeSummary = await prisma.conversationSummary.findFirst({ where: { conversationId: conversation.id, status: 'active' }, select: { coveredThroughSequence: true } });
          const summaryJob = await prisma.conversationSummaryJob.findUnique({ where: { conversationId: conversation.id }, select: { status: true } });
          const hasSummaryJob = summaryJob?.status !== 'complete' && Boolean(summaryJob);
          const changedThrough = Math.min(...priorResponses.map(row => row.sequence));
          await prisma.$transaction(async tx => {
            await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${activeConversation.id}::uuid FOR UPDATE`;
            if (hasSummaryJob || (activeSummary && changedThrough <= activeSummary.coveredThroughSequence)) await noteTranscriptMutation(tx, activeConversation.id, changedThrough);
            await tx.message.deleteMany({ where: { conversationId: activeConversation.id, role: 'assistant', sequence: { gt: userMessage.sequence } } });
          });
        }
      }
      const history = await prisma.message.findMany({ where: { conversationId: conversation.id, sequence: { lte: userMessage.sequence } }, orderBy: { sequence: 'asc' }, select: { id: true, role: true, content: true, sequence: true } });
      const activeSummary = await prisma.conversationSummary.findFirst({ where: { conversationId: conversation.id, status: 'active', coveredThroughSequence: { lt: userMessage.sequence } }, orderBy: { version: 'desc' }, select: { summaryText: true, coveredThroughSequence: true } });
      let generationProvider: AIProvider | undefined;
      let generation: Awaited<ReturnType<AIProvider['stream']>> | undefined;
      let streamIterator: AsyncIterator<string> | undefined;
      let builtContext: Awaited<ReturnType<ContextBuilder['build']>> | undefined;
      let retrievedMemory: Awaited<ReturnType<typeof retrieveMemories>> | undefined;
      let generationParameters: GenerationParameters | undefined;
      let selectedAttemptId = '';
      let selectedAttemptNumber = 0;
      let selectedCandidateReason = '';
      let fallbackOccurred = false;
      let fallbackReasonCode = '';
      let selectedModel: ReturnType<ModelRegistry['resolve']> | undefined;
      let firstDelta = '';
      let attemptNumber = 0;
      let exhaustedProviderError: ProviderError | undefined;
      const recordProviderAttempt = async (model: ReturnType<ModelRegistry['resolve']>, attemptId: string, number: number, usage: import('./ai.js').StreamUsage, errorCode: string, messageId: string | null = null) => {
        const estimatedSource = usage.source === 'estimated';
        const reportedInput = estimatedSource ? null : usage.inputTokens ?? null;
        const reportedOutput = estimatedSource ? null : usage.outputTokens ?? null;
        const estimatedInput = estimatedSource ? usage.inputTokens ?? null : null;
        const estimatedOutput = estimatedSource ? usage.outputTokens ?? null : null;
        const hasReported = reportedInput !== null || reportedOutput !== null;
        const usageStatus = estimatedSource ? 'estimated' as const : reportedInput !== null && reportedOutput !== null ? 'provider_reported' as const : hasReported ? 'partial' as const : 'unknown' as const;
        const costTokensInput = reportedInput ?? estimatedInput;
        const costTokensOutput = reportedOutput ?? estimatedOutput;
        const estimatedCost = costTokensInput !== null && costTokensOutput !== null ? models.estimateCost(model.id, costTokensInput, costTokensOutput) : null;
        const event = { idempotencyKey: `provider-attempt:${attemptId}`, attemptId, attemptNumber: number, errorCode,
          operation: 'provider_attempt' as const, userId: p.id, conversationId: activeConversation.id, messageId,
          provider: model.providerId, model: model.providerModelId, inputTokens: reportedInput, outputTokens: reportedOutput,
          estimatedInputTokens: estimatedInput, estimatedOutputTokens: estimatedOutput, usageStatus, estimatedCost, ...models.getPricingSnapshot(model.id) };
        await prisma.$transaction(tx => enqueueUsageEvent(tx, event));
        await deliverUsage(event.idempotencyKey).catch(() => false);
        return { inputTokens: reportedInput, outputTokens: reportedOutput, estimatedInputTokens: estimatedInput, estimatedOutputTokens: estimatedOutput, usageStatus, estimatedCost };
      };
      let candidateIndex = 0;
      let fallbackCount = 0;
      while (candidateIndex < routingCandidates.length) {
        const candidate = routingCandidates[candidateIndex]!;
        const candidateModel = candidate.model;
        let candidateProvider: AIProvider;
        try { candidateProvider = resolveProvider(candidateModel.providerId); }
        catch {
          res.status(503).json({ error: `Provider '${candidateModel.providerId}' is unavailable in this server configuration.`, code: 'MODEL_UNAVAILABLE', requestId: (req as any).id }); return;
        }
        const candidateParameters: GenerationParameters = {
          ...(requestedParameters as GenerationParameters),
          maxOutputTokens: Number(requestedParameters.maxOutputTokens ?? Math.min(config.MAX_OUTPUT_TOKENS, candidateModel.maxOutputTokens)),
        };
        const candidateMemory = !p.guest && settings?.memoryEnabled
          ? await retrieveMemories(pool, { userId: p.id, query: userMessage.content, model: candidateModel })
          : { memories: [], diagnostics: { considered: 0, candidates: 0, omittedForRelevance: 0, omittedForBudget: 0, retrievalDurationMs: 0 } };
        let candidateContext;
        try {
          candidateContext = await contextBuilder.build({
            model: candidateModel, messages: history.map(m => ({ ...m, role: m.role as 'user' | 'assistant' })), currentUserMessageId: userMessage.id,
            conversationSummary: activeSummary ? { text: activeSummary.summaryText, coveredThroughSequence: activeSummary.coveredThroughSequence } : null,
            savedMemories: candidateMemory.memories, memoryRetrievalDiagnostics: candidateMemory.diagnostics,
            responsePreferences: settings?.responsePreferences ?? '', reservedOutputTokens: candidateParameters.maxOutputTokens!, signal: controller.signal,
            countInputTokens: candidateProvider.countInputTokens ? (input, systemInstructions, responsePreferences, signal) => candidateProvider.countInputTokens!({ input, providerModelId: candidateModel.providerModelId, signal, systemInstructions, responsePreferences }) : undefined,
          });
        } catch (error) {
          if (!(error instanceof ContextBudgetError)) throw error;
          if (effectiveMode === 'MANUAL') {
            const latest = await prisma.conversation.findUnique({ where: { id: activeConversation.id }, select: { lastMessageSequence: true } });
            if (history.length > config.SUMMARY_RECENT_TURNS * 2) void enqueueSummary(activeConversation.id, latest?.lastMessageSequence ?? userMessage.sequence)
              .catch(() => logger.warn({ requestId: (req as any).id, conversationId: activeConversation.id, errorCode: 'SUMMARY_ENQUEUE_FAILED' }, 'summary job enqueue failed'));
            res.status(413).json({ error: error.message, code: error.code, requestId: (req as any).id }); return;
          }
          fallbackOccurred = candidateIndex > 0 || routingCandidates.length > 1;
          fallbackReasonCode = 'context_fit_fallback';
          candidateIndex++;
          continue;
        }

        const attemptId = randomUUID();
        const currentAttemptNumber = ++attemptNumber;
        const attemptController = new AbortController();
        const abortFromRequest = () => attemptController.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', abortFromRequest, { once: true });
        const attemptTimeout = setTimeout(() => attemptController.abort(new Error('Provider timeout')), services.providerTimeoutMs ?? config.PROVIDER_TIMEOUT_MS);
        let selected = false;
        let candidateGeneration: Awaited<ReturnType<AIProvider['stream']>> | undefined;
        try {
          candidateGeneration = await candidateProvider.stream({ input: candidateContext.messages.map(m => ({ role: m.role, content: m.content })), modelId: candidateModel.id, providerModelId: candidateModel.providerModelId, parameters: candidateParameters, signal: attemptController.signal, systemInstructions: candidateContext.systemInstructions, responsePreferences: candidateContext.responsePreferences });
          const iterator = candidateGeneration.chunks[Symbol.asyncIterator]();
          let first: IteratorResult<string>;
          do {
            first = await iterator.next();
            if (first.done) throw new ProviderError('PROVIDER_INCOMPLETE', 'Provider completed without response text.');
          } while (!first.value);
          if (controller.signal.aborted || disconnected) throw new ProviderError('PROVIDER_CANCELLED', 'The request was cancelled.');
          generationProvider = candidateProvider; generation = candidateGeneration; streamIterator = iterator; builtContext = candidateContext; retrievedMemory = candidateMemory;
          generationParameters = candidateParameters; selectedModel = candidateModel; modelEntry = candidateModel;
          selectedAttemptId = attemptId; selectedAttemptNumber = currentAttemptNumber;
          selectedCandidateReason = candidate.reasonCode; firstDelta = first.value;
          if (candidateIndex > 0 && !fallbackReasonCode) fallbackReasonCode = 'eligible_model_fallback';
          cleanupActiveAttempt = () => { clearTimeout(attemptTimeout); controller.signal.removeEventListener('abort', abortFromRequest); };
          recordCurrentAttemptFailure = async (messageId, errorCode) => {
            if (currentAttemptFailureRecorded) return { inputTokens: null, outputTokens: null, estimatedInputTokens: null, estimatedOutputTokens: null, usageStatus: 'unknown', estimatedCost: null };
            currentAttemptFailureRecorded = true;
            await streamIterator?.return?.().catch(() => {});
            const failedUsage = await candidateGeneration!.usage.catch(() => ({}));
            return recordProviderAttempt(candidateModel, attemptId, currentAttemptNumber, failedUsage, errorCode, messageId);
          };
          selected = true;
          break;
        } catch (caught) {
          let usage: import('./ai.js').StreamUsage = {};
          if (candidateGeneration) usage = await candidateGeneration.usage.catch(() => ({}));
          const error = controller.signal.aborted ? new ProviderError('PROVIDER_CANCELLED', 'The request was cancelled.')
            : attemptController.signal.aborted ? new ProviderError('PROVIDER_TIMEOUT', 'The AI provider request timed out.', true, 504)
              : caught instanceof ProviderError ? caught : new ProviderError('PROVIDER_FAILURE', 'The AI provider request failed.');
          exhaustedProviderError = error;
          await recordProviderAttempt(candidateModel, attemptId, currentAttemptNumber, usage, error.code).catch(recordError => { throw recordError; });
          const nextProviderIndex = routingCandidates.findIndex((entry, index) => index > candidateIndex && entry.model.providerId !== candidateModel.providerId && entry.model.providerId !== 'mock');
          const mayFallback = effectiveMode === 'AUTO' && error.retryable && candidateModel.providerId !== 'mock' && !controller.signal.aborted && !disconnected
            && fallbackCount < config.AUTO_MAX_FALLBACK_ATTEMPTS && nextProviderIndex >= 0;
          if (mayFallback) { fallbackCount++; fallbackOccurred = true; fallbackReasonCode = 'retryable_provider_failure'; candidateIndex = nextProviderIndex; continue; }
          if (error.code === 'PROVIDER_TIMEOUT') abortSource = 'provider_timeout';
          throw error;
        } finally {
          if (!selected) { clearTimeout(attemptTimeout); controller.signal.removeEventListener('abort', abortFromRequest); }
        }
      }
      if (!generation || !generationProvider || !selectedModel || !builtContext || !streamIterator || !selectedAttemptId) {
        if (exhaustedProviderError) throw exhaustedProviderError;
        const message = 'No eligible model could fit the conversation context. Choose a model with a larger context window or reduce the earlier conversation.';
        res.status(413).json({ error: message, code: 'CONTEXT_TOO_LARGE', requestId: (req as any).id }); return;
      }
      modelEntry = selectedModel;
      answer = firstDelta;
      if (retrievedMemory?.memories.length) await prisma.userMemory.updateMany({ where: { userId: p.id, id: { in: retrievedMemory.memories.map(memory => memory.id) } }, data: { lastRetrievedAt: new Date(), retrievalCount: { increment: 1 } } });
      logger.info({ requestId: (req as any).id, conversationId: conversation.id, model: modelEntry.id, taskType: task.taskType, ...builtContext.diagnostics }, 'chat context constructed');
      const routingReasonCode = fallbackReasonCode || selectedCandidateReason;
      const assistant = await createOrderedMessage({ conversationId: conversation.id, role: 'assistant', content: answer, status: 'streaming', provider: generationProvider.id, model: modelEntry.providerModelId, requestedSelectionMode: effectiveMode, requestedModelId: effectiveMode === 'MANUAL' ? modelEntry.id : null, taskType: task.taskType, routingPolicyVersion: effectiveMode === 'AUTO' ? policyVersion : null, routingReasonCode });
      assistantId = assistant.id;
      await prisma.conversation.update({ where: { id: conversation.id }, data: { provider: generationProvider.id, model: modelEntry.providerModelId } });
      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      sse(res, 'meta', { conversationId: conversation.id, userMessageId: userMessage.id, assistantMessageId: assistant.id, provider: generationProvider.id, model: modelEntry.providerModelId, mock: generationProvider.id === 'mock', requestedSelectionMode: effectiveMode, taskType: task.taskType, routingPolicyVersion: policyVersion, routingReasonCode, fallbackOccurred });
      sse(res, 'delta', { text: firstDelta });
      while (true) {
        const item = await streamIterator.next();
        if (item.done) break;
        const chunk = item.value;
        if (controller.signal.aborted || disconnected) break;
        answer += chunk;
        const now = Date.now();
        if (!lastProgressPersistAt || now - lastProgressPersistAt >= 250) {
          try { await persistAssistantMessage(assistant.id, { content: answer }); }
          catch (error) { abortSource = 'persistence_failure'; controller.abort(new Error('Assistant response persistence failed')); throw error; }
          lastProgressPersistAt = now;
        }
        sse(res, 'delta', { text: chunk });
      }
      const usage = await generation.usage;
      const usageIsEstimated = usage.source === 'estimated';
      const inputTokens = usageIsEstimated ? null : usage.inputTokens ?? null;
      const outputTokens = usageIsEstimated ? null : usage.outputTokens ?? null;
      const estimatedInputTokens = inputTokens === null ? usage.inputTokens ?? builtContext.diagnostics.estimatedInputTokens : null;
      const estimatedOutputTokens = outputTokens === null ? usage.outputTokens ?? Math.max(1, Math.ceil(answer.length / 4)) : null;
      const usageStatus = inputTokens !== null && outputTokens !== null ? 'provider_reported' as const : inputTokens !== null || outputTokens !== null ? 'partial' as const : 'estimated' as const;
      const costInput = inputTokens ?? estimatedInputTokens;
      const costOutput = outputTokens ?? estimatedOutputTokens;
      const cost = costInput !== null && costOutput !== null ? models.estimateCost(modelEntry.id, costInput, costOutput) : null;
      const pricing = models.getPricingSnapshot(modelEntry.id);
      const status = disconnected || controller.signal.aborted ? (answer ? 'partial' : 'cancelled') : 'complete';
      const usageEvent = { idempotencyKey: `chat:${assistant.id}`, attemptId: selectedAttemptId, attemptNumber: selectedAttemptNumber, operation: 'chat' as const, userId: p.id, conversationId: conversation.id, messageId: assistant.id, provider: generationProvider.id, model: modelEntry.providerModelId, inputTokens, outputTokens, estimatedInputTokens, estimatedOutputTokens, usageStatus, estimatedCost: cost, ...pricing };
      const shouldQueueSummary = status === 'complete' && builtContext.diagnostics.estimatedInputTokens / builtContext.diagnostics.effectiveContextBudget >= config.SUMMARY_TRIGGER_RATIO;
      await prisma.$transaction(async tx => {
        await persistAssistantMessage(assistant.id, { content: answer, status, inputTokens, outputTokens, estimatedInputTokens, estimatedOutputTokens, usageStatus, estimatedCost: cost, pricingCurrency: pricing.pricingCurrency }, tx);
        await enqueueUsageEvent(tx, usageEvent);
        if (status === 'complete') {
          const job = await tx.conversationSummaryJob.findUnique({ where: { conversationId: activeConversation.id }, select: { status: true } });
          if (shouldQueueSummary || (job && job.status !== 'complete')) await enqueueSummaryJobTx(tx, activeConversation.id, assistant.sequence);
        }
      });
      assistantFinalized = true;
      try {
        if (services.createUsageRecord) await services.createUsageRecord(usageEvent);
        else await deliverUsage(usageEvent.idempotencyKey);
      } catch (usageError) {
        logger.warn({ requestId: (req as any).id, conversationId: conversation.id, operation: 'chat', errorCode: 'USAGE_DELIVERY_DEFERRED' }, 'usage event queued for retry');
      }
      if (!disconnected) { sse(res, 'done', { status, inputTokens, outputTokens, estimatedInputTokens, estimatedOutputTokens, usageStatus, estimatedCost: cost, pricingCurrency: pricing.pricingCurrency }); res.end(); }
      logger.info({ requestId: (req as any).id, conversationId: conversation.id, provider: generationProvider.id, model: modelEntry.providerModelId, taskType: task.taskType, routingPolicyVersion: policyVersion, routingReasonCode, fallbackOccurred, attemptId: selectedAttemptId, status, terminationCause: abortSource ?? null, providerReportedInputTokens: inputTokens, contextEstimatedInputTokens: builtContext.diagnostics.estimatedInputTokens, estimatedInputTokens, providerReportedOutputTokens: outputTokens, estimatedOutputTokens, estimatedCost: cost }, 'chat generation finished');
    } catch (error: any) {
      const providerFailure = error instanceof ProviderError;
      const code = abortSource === 'persistence_failure' ? 'PERSISTENCE_FAILURE' : providerFailure ? error.code : error?.code && typeof error.code === 'string' ? error.code : controller.signal.aborted ? 'PROVIDER_CANCELLED' : 'PROVIDER_FAILURE';
      if (assistantId && !assistantFinalized) {
        const partialUsage = await recordCurrentAttemptFailure?.(assistantId, code).catch(() => undefined);
        await persistAssistantMessage(assistantId, { content: answer, status: answer ? 'partial' : 'error', ...(partialUsage ?? {}), error: abortSource === 'persistence_failure' ? 'Response persistence failed.' : controller.signal.aborted ? 'Generation cancelled or timed out.' : 'Provider request failed.' }).catch(() => {});
      }
      const message = abortSource === 'persistence_failure' ? 'The response could not be saved. Generation stopped; retry the request.' : code === 'PROVIDER_TIMEOUT' || controller.signal.aborted ? 'Generation timed out or was interrupted. Retry to continue.' : 'Generation failed. Retry the response.';
      if (!disconnected && res.headersSent) { sse(res, 'error', { error: message, code, partial: Boolean(answer) }); res.end(); }
      else if (!res.headersSent) {
        if (!disconnected && providerFailure) res.status(error.httpStatus).json({ error: message, code, requestId: (req as any).id });
        else if (!disconnected) next(error);
      }
    } finally {
      cleanupActiveAttempt?.();
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
