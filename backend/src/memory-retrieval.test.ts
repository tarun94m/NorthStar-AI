import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, pool } from './db.js';
import { modelRegistry } from './model-registry.js';
import { retrieveMemories } from './memory-retrieval.js';
import { normalizedMemoryKey } from './memory-service.js';

after(async () => { await prisma.$disconnect(); await pool.end(); });

test('deterministic multilingual lexical retrieval evaluation uses owned ranked memories and bounded results', async t => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@memory-eval.test` } });
  const other = await prisma.user.create({ data: { email: `${randomUUID()}@memory-eval.test` } });
  const records = [
    { content: 'The user prefers TypeScript for frontend development.', category: 'technical_skills', tags: ['typescript', 'frontend'] },
    { content: 'La persona prefiere respuestas breves en español.', category: 'communication_preferences', tags: ['respuestas', 'español'] },
    { content: 'Cette personne préfère des réponses brèves en français.', category: 'communication_preferences', tags: ['réponses', 'français'] },
    { content: 'The user is planning a garden renovation this summer.', category: 'work_projects', tags: ['garden', 'renovation'] },
    { content: 'The user enjoys React Native tutorials but uses JavaScript at work.', category: 'technical_skills', tags: ['react', 'javascript'] },
  ];
  const owned = await prisma.userMemory.createManyAndReturn({ data: records.map(row => ({ ...row, userId: user.id, dedupeKey: normalizedMemoryKey(user.id, row.content) })) });
  await prisma.userMemory.create({ data: { userId: other.id, content: 'Private note: TypeScript is preferred for frontend development.', category: 'preferences', tags: ['typescript', 'frontend'], dedupeKey: normalizedMemoryKey(other.id, 'Private note: TypeScript is preferred for frontend development.') } });
  const model = modelRegistry.all().find(item => item.id === 'openai:gpt-4.1-mini')!;
  const evalCases = [
    { query: 'TypeScript frontend', relevant: new Set([owned[0]!.id]) },
    { query: 'respuestas breves español', relevant: new Set([owned[1]!.id]) },
    { query: 'réponses brèves français', relevant: new Set([owned[2]!.id]) },
  ];
  try {
    const scores = [];
    for (const item of evalCases) {
      const result = await retrieveMemories(pool, { userId: user.id, query: item.query, model, topK: 5, maxTokens: 500 });
      const ids = result.memories.map(memory => memory.id);
      const relevantRetrieved = ids.filter(id => item.relevant.has(id)).length;
      scores.push({ precisionAt5: relevantRetrieved / 5, relevantCoverage: relevantRetrieved / item.relevant.size, irrelevantInjection: ids.filter(id => !item.relevant.has(id)).length });
      assert.ok(ids.length <= 5, 'top K is enforced');
      assert.ok(result.memories.every(memory => !records[3]?.content.includes(memory.content)), 'unrelated garden memory is not injected');
      assert.equal(result.memories.some(memory => memory.content.startsWith('Private note:')), false, 'another user’s lexical match is excluded');
      assert.ok(result.diagnostics.retrievalDurationMs >= 0);
    }
    const unrelated = await retrieveMemories(pool, { userId: user.id, query: 'mortgage brokerage credentials', model });
    assert.equal(unrelated.memories.length, 0, 'no lexical match means no context injection');
    assert.ok(scores.every(score => score.relevantCoverage === 1), `evaluation coverage: ${JSON.stringify(scores)}`);
    assert.ok(scores.every(score => score.irrelevantInjection === 0), `irrelevant injection: ${JSON.stringify(scores)}`);
    const bounded = await retrieveMemories(pool, { userId: user.id, query: 'TypeScript frontend', model, topK: 1, maxTokens: 1 });
    assert.equal(bounded.memories.length, 0, 'token budget omits a matching memory that cannot fit');
    assert.ok(bounded.diagnostics.omittedForBudget >= 1);
    t.diagnostic(`evaluation: precision@5=${scores.reduce((sum, score) => sum + score.precisionAt5, 0) / scores.length}; relevant coverage=${scores.reduce((sum, score) => sum + score.relevantCoverage, 0) / scores.length}; irrelevant injection=${scores.reduce((sum, score) => sum + score.irrelevantInjection, 0)}`);
  } finally { await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } }); }
});
