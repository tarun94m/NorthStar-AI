import type { Pool } from 'pg';
import type { ModelDefinition } from './model-registry.js';
import { config } from './config.js';
import { estimateMemoryTokens } from './memory-service.js';

export type RetrievedMemory = { id: string; content: string; category: string; tags: string[]; relevance: number };
export type MemoryRetrievalDiagnostics = { considered: number; candidates: number; omittedForRelevance: number; omittedForBudget: number; retrievalDurationMs: number };
const lexicalStopWords = new Set(('a an and are as at be been but by for from has have how i in is it me my of on or our should the their them there these this to was we what when where which who will with would you your el la los las un una unos unas de del en es y para por que con mi mis su sus al como esto esta estos estas le les des du un une et est je me ma mes pour avec que qui ce cette ces mon').split(' '));

export async function retrieveMemories(pool: Pool, options: { userId: string; query: string; model: ModelDefinition; topK?: number; maxTokens?: number }) {
  const started = Date.now();
  const rawQuery = options.query.trim().slice(0, 4000);
  const terms = [...new Set((rawQuery.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(term => !lexicalStopWords.has(term) && term.length > 1))].slice(0, 16);
  if (!terms.length) return { memories: [] as RetrievedMemory[], diagnostics: { considered: 0, candidates: 0, omittedForRelevance: 0, omittedForBudget: 0, retrievalDurationMs: Date.now() - started } satisfies MemoryRetrievalDiagnostics };
  const query = terms.join(' | ');
  const topK = Math.min(10, Math.max(1, options.topK ?? config.MEMORY_RETRIEVAL_TOP_K));
  const maxTokens = Math.min(2000, Math.max(1, options.maxTokens ?? config.MEMORY_RETRIEVAL_MAX_TOKENS));
  const result = await pool.query(`
    WITH query AS (SELECT to_tsquery('simple'::regconfig, $2) AS tsq), ranked AS (
      SELECT m."id", m."content", m."category", m."tags",
        ts_rank_cd(m."searchVector", query.tsq) AS lexical_rank,
        COALESCE(m."lastRetrievedAt", m."updatedAt") AS recency_at
      FROM "UserMemory" m CROSS JOIN query
      WHERE m."userId" = $1::uuid
        AND m."searchVector" @@ query.tsq
    )
    SELECT *, lexical_rank * (1.0 + 0.12 * exp(-GREATEST(EXTRACT(EPOCH FROM (now() - recency_at)) / 86400.0, 0) / 180.0)) AS relevance
    FROM ranked ORDER BY relevance DESC, recency_at DESC, id ASC LIMIT 50`, [options.userId, query]);
  const matched = result.rows as { id: string; content: string; category: string; tags: string[]; lexical_rank: number; relevance: number }[];
  const relevant = matched.filter(row => Number(row.lexical_rank) >= config.MEMORY_RETRIEVAL_MIN_RANK);
  const memories: RetrievedMemory[] = [];
  let tokenTotal = 0;
  let omittedForBudget = 0;
  for (const row of relevant.slice(0, topK)) {
    const memory = { id: row.id, content: row.content, category: row.category, tags: row.tags, relevance: Number(row.relevance) };
    const tokens = estimateMemoryTokens(memory.content + ' ' + memory.tags.join(' '), options.model.tokenizer);
    if (tokens > config.MEMORY_MAX_PER_MEMORY_TOKENS || tokenTotal + tokens > maxTokens) { omittedForBudget++; continue; }
    memories.push(memory);
    tokenTotal += tokens;
  }
  return {
    memories,
    diagnostics: {
      considered: matched.length, candidates: memories.length,
      omittedForRelevance: matched.length - Math.min(relevant.length, topK),
      omittedForBudget,
      retrievalDurationMs: Date.now() - started,
    } satisfies MemoryRetrievalDiagnostics,
  };
}
