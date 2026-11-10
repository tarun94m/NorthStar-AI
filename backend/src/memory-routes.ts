import express from 'express';
import rateLimit from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import { z } from 'zod';
import type { PrismaClient } from './generated/prisma/client.js';
import type { Pool } from 'pg';
import type { AIProvider, ProviderRegistry } from './ai.js';
import type { ModelRegistry } from './model-registry.js';
import { config } from './config.js';
import { enqueueUsageEvent } from './usage-outbox.js';
import { memoryCategorySchema, memoryContentSchema, memoryTagsSchema, normalizedMemoryKey, containsSensitiveContent, extractMemoryCandidates } from './memory-service.js';

type Principal = { id: string; guest: boolean };
type Dependencies = { prisma: PrismaClient; pool: Pool; providers: ProviderRegistry; models: ModelRegistry; extractionStore: Store; defaultProvider?: AIProvider; deliverUsage: (key: string) => Promise<boolean> };
const createSchema = z.object({ content: memoryContentSchema, category: memoryCategorySchema, tags: memoryTagsSchema.optional() }).strict();
const patchSchema = z.object({ content: memoryContentSchema.optional(), category: memoryCategorySchema.optional(), tags: memoryTagsSchema.optional() }).strict().refine(value => Object.keys(value).length > 0, 'At least one field is required.');
const settingsSchema = z.object({ memoryEnabled: z.boolean() }).strict();
const generateSchema = z.object({ conversationId: z.string().uuid() }).strict();
const decisionSchema = z.object({ content: memoryContentSchema.optional(), category: memoryCategorySchema.optional(), tags: memoryTagsSchema.optional() }).strict();
const currentPrincipal = (req: express.Request) => (req as any).principal as Principal;
const setError = (res: express.Response, status: number, code: string, error: string) => res.status(status).json({ error, code });
const transaction = async <T>(prisma: PrismaClient, fn: (tx: any) => Promise<T>): Promise<T> => prisma.$transaction(fn, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 }) as Promise<T>;
const uuidParam = z.string().uuid();
const publicMemory = (row: any) => row && ({ id: row.id, content: row.content, category: row.category, tags: row.tags, createdAt: row.createdAt, updatedAt: row.updatedAt, lastRetrievedAt: row.lastRetrievedAt, retrievalCount: row.retrievalCount });
const publicSuggestion = (row: any) => row && ({ id: row.id, proposedContent: row.proposedContent, proposedCategory: row.proposedCategory, proposedTags: row.proposedTags, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: row.expiresAt, decidedAt: row.decidedAt, createdMemoryId: row.createdMemoryId });

export function createMemoryRouter(deps: Dependencies) {
  const router = express.Router();
  const { prisma } = deps;
  const requireRegistered = (req: express.Request, res: express.Response) => {
    if (currentPrincipal(req).guest) {
      setError(res, 403, 'MEMORY_REGISTERED_ACCOUNT_REQUIRED', 'Long-term memory requires a registered account.');
      return false;
    }
    return true;
  };
  async function getSetting(userId: string) {
    return prisma.userSettings.upsert({ where: { userId }, create: { userId }, update: {}, select: { memoryEnabled: true } });
  }
  async function expireSuggestions(userId?: string) {
    await prisma.memorySuggestion.updateMany({ where: { ...(userId ? { userId } : {}), status: 'PENDING', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED', decidedAt: new Date() } });
  }

  router.get('/settings', async (req, res, next) => {
    try { if (!requireRegistered(req, res)) return; res.json(await getSetting(currentPrincipal(req).id)); }
    catch (error) { next(error); }
  });
  router.patch('/settings', async (req, res, next) => {
    try {
      if (!requireRegistered(req, res)) return;
      const body = settingsSchema.safeParse(req.body);
      if (!body.success) { setError(res, 400, 'VALIDATION_ERROR', 'memoryEnabled must be a boolean.'); return; }
      const settings = await prisma.userSettings.upsert({ where: { userId: currentPrincipal(req).id }, create: { userId: currentPrincipal(req).id, memoryEnabled: body.data.memoryEnabled }, update: { memoryEnabled: body.data.memoryEnabled }, select: { memoryEnabled: true } });
      res.json(settings);
    } catch (error) { next(error); }
  });

  router.get('/suggestions', async (req, res, next) => {
    try {
      if (!requireRegistered(req, res)) return;
      const userId = currentPrincipal(req).id;
      await expireSuggestions(userId);
      const suggestions = await prisma.memorySuggestion.findMany({ where: { userId, status: 'PENDING', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, proposedContent: true, proposedCategory: true, proposedTags: true, createdAt: true, expiresAt: true, sourceConversation: { select: { title: true } } } });
      res.json({ suggestions: suggestions.map(({ sourceConversation, ...row }) => ({ ...row, sourceConversationTitle: sourceConversation?.title ?? null })) });
    } catch (error) { next(error); }
  });

  const extractionLimiter = rateLimit({
    windowMs: 60 * 60_000, limit: config.MEMORY_SUGGESTION_MAX_PER_HOUR,
    standardHeaders: 'draft-8', legacyHeaders: false, store: deps.extractionStore,
    keyGenerator: req => currentPrincipal(req).id,
    handler: (_req, res) => { setError(res, 429, 'MEMORY_SUGGESTION_RATE_LIMITED', 'Memory suggestion generation is temporarily rate limited. Try again later.'); },
  });
  const extractionEligible: express.RequestHandler = async (req, res, next) => {
    if (!requireRegistered(req, res)) return;
    const body = generateSchema.safeParse(req.body);
    if (!body.success) { setError(res, 400, 'VALIDATION_ERROR', 'A valid conversationId is required.'); return; }
    try {
      const setting = await getSetting(currentPrincipal(req).id);
      if (!setting.memoryEnabled) { setError(res, 409, 'MEMORY_DISABLED', 'Enable long-term memory before generating suggestions.'); return; }
      next();
    } catch (error) { next(error); }
  };
  router.post('/suggestions/generate', extractionEligible, extractionLimiter, async (req, res, next) => {
    try {
      if (!requireRegistered(req, res)) return;
      const p = currentPrincipal(req);
      const body = generateSchema.safeParse(req.body);
      if (!body.success) { setError(res, 400, 'VALIDATION_ERROR', 'A valid conversationId is required.'); return; }
      const setting = await getSetting(p.id);
      if (!setting.memoryEnabled) { setError(res, 409, 'MEMORY_DISABLED', 'Enable long-term memory before generating suggestions.'); return; }
      const conversation = await prisma.conversation.findFirst({ where: { id: body.data.conversationId, userId: p.id }, include: { messages: { where: { status: 'complete' }, orderBy: { sequence: 'desc' }, take: 24, select: { role: true, content: true, sequence: true } } } });
      if (!conversation) { setError(res, 404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.'); return; }
      const activeGeneration = await prisma.conversationGenerationLock.findFirst({ where: { conversationId: conversation.id, expiresAt: { gt: new Date() } }, select: { conversationId: true } });
      if (activeGeneration) { setError(res, 409, 'GENERATION_ACTIVE', 'Wait for the current response to finish before generating memory suggestions.'); return; }
      if (conversation.messages.length < 2) { res.json({ suggestions: [], considered: 0 }); return; }
      let remainingCharacters = 18000;
      const messages = [...conversation.messages].reverse().filter(row => row.role === 'user' || row.role === 'assistant').map(row => {
        const content = row.content.slice(-remainingCharacters); remainingCharacters = Math.max(0, remainingCharacters - content.length);
        return { role: row.role as 'user' | 'assistant', content };
      }).filter(row => row.content.length > 0);
      const model = deps.models.all().find(item => item.providerId === conversation.provider && item.providerModelId === conversation.model);
      if (!model || !model.enabled || !model.configured) { setError(res, 503, 'MODEL_UNAVAILABLE', 'The conversation model is not configured for memory suggestion extraction.'); return; }
      let generationProvider: AIProvider;
      try { generationProvider = deps.providers.resolve(conversation.provider); }
      catch { if (deps.defaultProvider?.id === conversation.provider) generationProvider = deps.defaultProvider; else { setError(res, 503, 'PROVIDER_UNAVAILABLE', 'The conversation provider is unavailable.'); return; } }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Memory provider timeout.')), config.PROVIDER_TIMEOUT_MS);
      timeout.unref();
      const onDisconnect = () => controller.abort(new Error('Memory suggestion request was cancelled.'));
      req.once('aborted', onDisconnect);
      res.once('close', onDisconnect);
      let extraction;
      try { extraction = await extractMemoryCandidates({ provider: generationProvider, model, providerModelId: conversation.model, transcript: messages, signal: controller.signal, parameters: { maxOutputTokens: 900 } }); }
      catch (error) {
        const code = (error as any)?.code;
        if (code === 'MEMORY_EXTRACTION_INVALID') { setError(res, 502, code, 'The configured provider did not return valid memory suggestions.'); return; }
        if (controller.signal.aborted && /timeout/i.test(String(controller.signal.reason?.message))) { setError(res, 504, 'MEMORY_EXTRACTION_TIMEOUT', 'Memory suggestions timed out. Try again later.'); return; }
        if (controller.signal.aborted && (res.destroyed || !res.writable)) return;
        if (code === 'PROVIDER_CONFIGURATION') { setError(res, 503, 'MEMORY_EXTRACTION_UNAVAILABLE', 'The selected provider is unavailable for memory suggestions.'); return; }
        setError(res, 502, 'MEMORY_EXTRACTION_FAILED', 'Memory suggestions could not be generated. Try again later.'); return;
      } finally {
        clearTimeout(timeout);
        req.off('aborted', onDisconnect);
        res.off('close', onDisconnect);
      }
      const userMemories = await prisma.userMemory.findMany({ where: { userId: p.id }, select: { content: true } });
      const known = new Set(userMemories.map(item => normalizedMemoryKey(p.id, item.content)));
      const candidates = extraction.suggestions.filter(item => !known.has(normalizedMemoryKey(p.id, item.content)));
      const dedupeKeys = candidates.map(item => normalizedMemoryKey(p.id, item.content));
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + config.MEMORY_SUGGESTION_TTL_HOURS * 60 * 60_000);
      const sourceHighWaterSequence = conversation.messages[0]?.sequence ?? 0;
      const newRows = candidates.map(item => ({ userId: p.id, sourceConversationId: conversation.id, sourceHighWaterSequence,
        proposedContent: item.content, proposedCategory: item.category, proposedTags: item.tags,
        status: 'PENDING' as const, dedupeKey: normalizedMemoryKey(p.id, item.content), expiresAt }));
      const usageKey = `memory_extract:${(req as any).id}`;
      const usageEstimated = extraction.usage.source === 'estimated';
      const pricing = deps.models.getPricingSnapshot(model.id);
      await transaction(prisma, async tx => {
        if (newRows.length) await tx.memorySuggestion.createMany({ data: newRows, skipDuplicates: true });
        await enqueueUsageEvent(tx, { idempotencyKey: usageKey, operation: 'memory_extraction', userId: p.id, conversationId: conversation.id,
          provider: generationProvider.id, model: conversation.model,
          inputTokens: usageEstimated ? null : extraction.usage.inputTokens, outputTokens: usageEstimated ? null : extraction.usage.outputTokens,
          estimatedInputTokens: usageEstimated ? extraction.usage.inputTokens : null, estimatedOutputTokens: usageEstimated ? extraction.usage.outputTokens : null,
          usageStatus: usageEstimated ? 'estimated' : 'provider_reported',
          estimatedCost: deps.models.estimateCost(model.id, extraction.usage.inputTokens, extraction.usage.outputTokens), ...pricing });
      });
      const suggestions = dedupeKeys.length ? await prisma.memorySuggestion.findMany({ where: { userId: p.id, dedupeKey: { in: dedupeKeys }, status: 'PENDING', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }) : [];
      void deps.deliverUsage(usageKey).catch(() => {});
      res.status(201).json({ suggestions: suggestions.map(publicSuggestion), considered: messages.length });
    } catch (error) { next(error); }
  });

  router.post('/suggestions/:id/approve', async (req, res, next) => {
    try {
      if (!requireRegistered(req, res)) return;
      const p = currentPrincipal(req); const id = uuidParam.safeParse(req.params.id);
      if (!id.success) { setError(res, 400, 'VALIDATION_ERROR', 'Suggestion ID must be a UUID.'); return; }
      const suggestionId = id.data;
      const body = decisionSchema.safeParse(req.body ?? {});
      if (!body.success) { setError(res, 400, 'VALIDATION_ERROR', 'The approved memory fields are invalid.'); return; }
      const existing = await prisma.memorySuggestion.findFirst({ where: { id: suggestionId, userId: p.id }, include: { createdMemory: true } });
      if (!existing) { setError(res, 404, 'MEMORY_SUGGESTION_NOT_FOUND', 'Memory suggestion not found.'); return; }
      if (existing.status === 'ACCEPTED' && existing.createdMemory) { res.json({ suggestion: publicSuggestion(existing), memory: publicMemory(existing.createdMemory) }); return; }
      if (existing.status === 'REJECTED') { setError(res, 409, 'MEMORY_SUGGESTION_DECIDED', 'This suggestion was rejected.'); return; }
      if (existing.status === 'EXPIRED' || existing.expiresAt <= new Date()) {
        await prisma.memorySuggestion.updateMany({ where: { id: suggestionId, userId: p.id, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: new Date() } });
        setError(res, 410, 'MEMORY_SUGGESTION_EXPIRED', 'This suggestion has expired.'); return;
      }
      const content = body.data.content ?? existing.proposedContent;
      const category = body.data.category ?? existing.proposedCategory;
      const tags = body.data.tags ?? existing.proposedTags;
      if (containsSensitiveContent(content)) { setError(res, 400, 'MEMORY_SENSITIVE_CONTENT', 'This content appears to contain a secret or sensitive information and cannot be saved.'); return; }
      let result: any;
      try {
        result = await transaction(prisma, async tx => {
          const claimed = await tx.memorySuggestion.updateMany({ where: { id: suggestionId, userId: p.id, status: 'PENDING', expiresAt: { gt: new Date() } }, data: { status: 'ACCEPTED', proposedContent: content, proposedCategory: category, proposedTags: tags, decidedAt: new Date() } });
          if (!claimed.count) {
            const current = await tx.memorySuggestion.findFirst({ where: { id: suggestionId, userId: p.id }, include: { createdMemory: true } });
            if (current?.status === 'ACCEPTED' && current.createdMemory) return { suggestion: current, memory: current.createdMemory };
            throw Object.assign(new Error('Suggestion is no longer pending.'), { code: current?.status === 'EXPIRED' ? 'MEMORY_SUGGESTION_EXPIRED' : 'MEMORY_SUGGESTION_DECIDED' });
          }
          const dedupeKey = normalizedMemoryKey(p.id, content);
          let memory = await tx.userMemory.findUnique({ where: { dedupeKey } });
          if (!memory) memory = await tx.userMemory.create({ data: { userId: p.id, content, category, tags, dedupeKey } });
          const suggestion = await tx.memorySuggestion.update({ where: { id: suggestionId }, data: { createdMemoryId: memory.id }, include: { createdMemory: true } });
          return { suggestion, memory };
        });
      } catch (error) {
        if ((error as any)?.code === 'MEMORY_SUGGESTION_EXPIRED') { setError(res, 410, 'MEMORY_SUGGESTION_EXPIRED', 'This suggestion has expired.'); return; }
        if ((error as any)?.code === 'MEMORY_SUGGESTION_DECIDED') { setError(res, 409, 'MEMORY_SUGGESTION_DECIDED', 'This suggestion was already decided.'); return; }
        if ((error as any)?.code === 'P2034') {
          const latest = await prisma.memorySuggestion.findFirst({ where: { id: suggestionId, userId: p.id }, include: { createdMemory: true } });
          if (latest?.status === 'ACCEPTED' && latest.createdMemory) { res.json({ suggestion: publicSuggestion(latest), memory: publicMemory(latest.createdMemory) }); return; }
        }
        throw error;
      }
      res.json({ suggestion: publicSuggestion(result.suggestion), memory: publicMemory(result.memory) });
    } catch (error) { next(error); }
  });
  router.post('/suggestions/:id/reject', async (req, res, next) => {
    try {
      if (!requireRegistered(req, res)) return;
      const p = currentPrincipal(req); const id = uuidParam.safeParse(req.params.id);
      if (!id.success) { setError(res, 400, 'VALIDATION_ERROR', 'Suggestion ID must be a UUID.'); return; }
      const suggestionId = id.data;
      if (req.body && Object.keys(req.body).length) { setError(res, 400, 'VALIDATION_ERROR', 'Reject does not accept a request body.'); return; }
      await expireSuggestions(p.id);
      const existing = await prisma.memorySuggestion.findFirst({ where: { id: suggestionId, userId: p.id } });
      if (!existing) { setError(res, 404, 'MEMORY_SUGGESTION_NOT_FOUND', 'Memory suggestion not found.'); return; }
      if (existing.status === 'REJECTED') { res.json({ suggestion: publicSuggestion(existing) }); return; }
      if (existing.status !== 'PENDING') { setError(res, existing.status === 'EXPIRED' ? 410 : 409, existing.status === 'EXPIRED' ? 'MEMORY_SUGGESTION_EXPIRED' : 'MEMORY_SUGGESTION_DECIDED', 'This suggestion is no longer pending.'); return; }
      const claimed = await prisma.memorySuggestion.updateMany({ where: { id: suggestionId, userId: p.id, status: 'PENDING', expiresAt: { gt: new Date() } }, data: { status: 'REJECTED', decidedAt: new Date() } });
      if (!claimed.count) { setError(res, 409, 'MEMORY_SUGGESTION_DECIDED', 'This suggestion was already decided.'); return; }
      const suggestion = await prisma.memorySuggestion.findFirst({ where: { id: suggestionId, userId: p.id } });
      res.json({ suggestion: publicSuggestion(suggestion) });
    } catch (error) { next(error); }
  });

  return router;
}
export function createMemoriesRouter(deps: Dependencies) {
  const router = express.Router();
  const registeredOnly = (req: express.Request, res: express.Response) => {
    if (currentPrincipal(req).guest) { setError(res, 403, 'MEMORY_REGISTERED_ACCOUNT_REQUIRED', 'Long-term memory requires a registered account.'); return false; }
    return true;
  };
  router.get('/', async (req, res, next) => {
    try {
      if (!registeredOnly(req, res)) return;
      const memories = await deps.prisma.userMemory.findMany({ where: { userId: currentPrincipal(req).id }, orderBy: { updatedAt: 'desc' }, take: 500 });
      res.json({ memories: memories.map(publicMemory) });
    } catch (error) { next(error); }
  });
  router.post('/', async (req, res, next) => {
    try {
      if (!registeredOnly(req, res)) return;
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) { setError(res, 400, 'VALIDATION_ERROR', 'Memory content, category, or tags are invalid.'); return; }
      if (containsSensitiveContent(parsed.data.content)) { setError(res, 400, 'MEMORY_SENSITIVE_CONTENT', 'This content appears to contain a secret or sensitive information and cannot be saved.'); return; }
      const userId = currentPrincipal(req).id;
      try {
        const memory = await deps.prisma.userMemory.create({ data: { ...parsed.data, tags: parsed.data.tags ?? [], userId, dedupeKey: normalizedMemoryKey(userId, parsed.data.content) } });
        res.status(201).json({ memory: publicMemory(memory) });
      } catch (error) {
        if ((error as any)?.code === 'P2002') { setError(res, 409, 'MEMORY_DUPLICATE', 'An equivalent memory already exists.'); return; }
        throw error;
      }
    } catch (error) { next(error); }
  });
  router.patch('/:id', async (req, res, next) => {
    try {
      if (!registeredOnly(req, res)) return;
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) { setError(res, 400, 'VALIDATION_ERROR', 'At least one valid memory field is required.'); return; }
      if (parsed.data.content && containsSensitiveContent(parsed.data.content)) { setError(res, 400, 'MEMORY_SENSITIVE_CONTENT', 'This content appears to contain a secret or sensitive information and cannot be saved.'); return; }
      const id = uuidParam.safeParse(req.params.id);
      if (!id.success) { setError(res, 400, 'VALIDATION_ERROR', 'Memory ID must be a UUID.'); return; }
      const userId = currentPrincipal(req).id;
      const data = { ...parsed.data, ...(parsed.data.content ? { dedupeKey: normalizedMemoryKey(userId, parsed.data.content) } : {}) };
      try {
        const result = await deps.prisma.userMemory.updateMany({ where: { id: id.data, userId }, data });
        if (!result.count) { setError(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found.'); return; }
        const memory = await deps.prisma.userMemory.findFirst({ where: { id: id.data, userId } });
        res.json({ memory: publicMemory(memory) });
      } catch (error) {
        if ((error as any)?.code === 'P2002') { setError(res, 409, 'MEMORY_DUPLICATE', 'An equivalent memory already exists.'); return; }
        throw error;
      }
    } catch (error) { next(error); }
  });
  router.delete('/:id', async (req, res, next) => {
    try {
      if (!registeredOnly(req, res)) return;
      const id = uuidParam.safeParse(req.params.id);
      if (!id.success) { setError(res, 400, 'VALIDATION_ERROR', 'Memory ID must be a UUID.'); return; }
      const result = await deps.prisma.userMemory.deleteMany({ where: { id: id.data, userId: currentPrincipal(req).id } });
      if (!result.count) { setError(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found.'); return; }
      res.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}
