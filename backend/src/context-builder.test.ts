import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'phase-one-test-secret-with-at-least-32-characters';
const [{ ContextBuilder, ContextBudgetError }, { modelRegistry }] = await Promise.all([import('./context-builder.js'), import('./model-registry.js')]);

const msg = (id: string, role: 'user' | 'assistant', content: string, sequence: number) => ({ id, role, content, sequence });
const model = { ...modelRegistry.all()[0]!, contextWindow: 100, maxOutputTokens: 20 };
const build = (messages: ReturnType<typeof msg>[], id: string, responsePreferences = '', countInputTokens?: any) => new ContextBuilder(0, 0, 0).build({ model, messages, currentUserMessageId: id, responsePreferences, reservedOutputTokens: 20, signal: new AbortController().signal, countInputTokens });

test('context builder retains current turn, complete recent pairs, and chronological ordering', async () => {
  const rows = [msg('u1','user','old',1),msg('a1','assistant','old response',2),msg('u2','user','middle',3),msg('a2','assistant','middle response',4),msg('u3','user','current',5)];
  const result = await build([...rows].reverse(), 'u3');
  assert.deepEqual(result.messages.map(m => m.id), ['u1','a1','u2','a2','u3']);
  assert.equal(result.diagnostics.omittedMessageCount, 0);
  assert.equal(result.diagnostics.tokenEstimateMethod, 'o200k_base_plus_framing_estimate');
});

test('context builder selects recent complete turns deterministically and reports diagnostics without content', async () => {
  const rows = [msg('u1','user','x'.repeat(150),1),msg('a1','assistant','y'.repeat(150),2),msg('u2','user','now',3)];
  const result = await build(rows, 'u2', 'bullet points');
  assert.deepEqual(result.messages.map(m => m.id), ['u2']);
  assert.equal(result.responsePreferences, 'bullet points');
  const withoutPreferences = await build(rows, 'u2');
  assert.ok(result.diagnostics.estimatedInputTokens > withoutPreferences.diagnostics.estimatedInputTokens, 'token estimate includes composed preference instructions');
  assert.equal(result.diagnostics.omittedMessageCount, 2);
  assert.equal(result.diagnostics.truncationReason, 'input_token_budget');
  assert.equal(JSON.stringify(result.diagnostics).includes('bullet'), false);
});

test('context builder preserves system instructions and preferences in provider-specific count', async () => {
  let counted: any;
  const result = await build([msg('u','user','question',1)], 'u', 'Use bullets', async (input: any, system: string, prefs: string) => { counted = { input, system, prefs }; return 22; });
  assert.equal(result.diagnostics.tokenEstimateMethod, 'provider_count_tokens');
  assert.equal(result.diagnostics.tokenEstimateApproximate, false);
  assert.equal(counted.input[0].content, 'question');
  assert.match(counted.system, /helpful AI assistant/);
  assert.equal(counted.prefs, 'Use bullets');
});

test('context builder rejects a current request that exceeds the available context budget', async () => {
  const tiny = { ...model, contextWindow: 30 };
  await assert.rejects(() => new ContextBuilder(0,0,0).build({ model: tiny, messages: [msg('u','user','x'.repeat(400),1)], currentUserMessageId: 'u', reservedOutputTokens: 20, signal: new AbortController().signal }), ContextBudgetError);
});

test('provider token count failures use a documented approximation unless cancelled', async () => {
  const result = await build([msg('u','user','hello',1)], 'u', '', async () => { throw new Error('unavailable'); });
  assert.equal(result.diagnostics.tokenEstimateApproximate, true);
  assert.equal(result.diagnostics.tokenEstimateMethod, 'o200k_base_plus_framing_estimate');
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(() => new ContextBuilder().build({ model, messages: [msg('u','user','hello',1)], currentUserMessageId: 'u', reservedOutputTokens: 20, signal: controller.signal, countInputTokens: async () => { throw new Error('aborted'); } }));
});

test('active summary is a separate untrusted provider context block and is included in token counting', async () => {
  const rows = [msg('u1','user','previous question',1),msg('a1','assistant','previous answer',2),msg('u2','user','current question',3)];
  let countedInput: any;
  const result = await new ContextBuilder(0,0,0).build({
    model: { ...model, contextWindow: 1000 }, messages: rows, currentUserMessageId: 'u2', conversationSummary: { text: 'Only-in-summary fact', coveredThroughSequence: 2 },
    reservedOutputTokens: 20, signal: new AbortController().signal,
    countInputTokens: async (input, system) => { countedInput = { input, system }; return 120; },
  });
  assert.equal(result.diagnostics.summaryIncluded, true);
  assert.equal(result.conversationSummary?.coveredThroughSequence, 2);
  assert.match(countedInput.input[0].content, /untrusted conversation summary/i);
  assert.match(countedInput.input[0].content, /Only-in-summary fact/);
  assert.doesNotMatch(countedInput.system, /Only-in-summary fact/);
  assert.equal(result.diagnostics.estimatedInputTokens, 120);
});

test('summary is omitted before the current message can be truncated or rejected', async () => {
  const result = await new ContextBuilder(0,0,0).build({
    model: { ...model, contextWindow: 100 }, messages: [msg('u','user','must remain intact',1)], currentUserMessageId: 'u',
    conversationSummary: { text: 'old context '.repeat(1000), coveredThroughSequence: 8 }, reservedOutputTokens: 20, signal: new AbortController().signal,
  });
  assert.equal(result.diagnostics.summaryIncluded, false);
  assert.equal(result.diagnostics.summaryCoveredThroughSequence, null);
  assert.equal(result.messages.some(message => message.id === 'u'), true);
});

test('memories are untrusted, model-counted context after recent turns and summary, and never displace the current message', async () => {
  const rows = [msg('u1','user','recent question',1), msg('a1','assistant','recent answer',2), msg('u2','user','current user request',3)];
  const memory = { id: 'memory-1', content: 'User prefers Rust.', category: 'technical skills', tags: ['rust'], relevance: 0.8 };
  let finalCountInput: any[] = [];
  const result = await new ContextBuilder(0,0,0).build({
    model: { ...model, contextWindow: 2000 }, messages: rows, currentUserMessageId: 'u2',
    conversationSummary: { text: 'Older project context.', coveredThroughSequence: 0 }, savedMemories: [memory],
    memoryRetrievalDiagnostics: { considered: 4, candidates: 1, omittedForRelevance: 2, omittedForBudget: 1, retrievalDurationMs: 3 },
    reservedOutputTokens: 20, responsePreferences: 'Use concise language.', signal: new AbortController().signal,
    countInputTokens: async input => { finalCountInput = input; return input.reduce((sum, item) => sum + item.content.length, 0); },
  });
  assert.equal(result.messages.find(item => item.id === 'u2')?.content, 'current user request');
  assert.ok(result.messages.findIndex(item => item.id === 'memory:memory-1') < result.messages.findIndex(item => item.id === 'u2'));
  assert.ok(result.messages.some(item => item.id.startsWith('summary:')));
  assert.match(result.messages.find(item => item.id === 'memory:memory-1')?.content ?? '', /untrusted saved memory/i);
  assert.match(result.systemInstructions, /saved memory.*untrusted reference/i);
  assert.equal(finalCountInput.some(item => item.content.includes('User prefers Rust.')), true);
  assert.equal(result.savedMemories.length, 1);
  assert.equal(result.diagnostics.memoriesConsidered, 4);
  assert.equal(result.diagnostics.memoriesSelected, 1);
  assert.equal(result.diagnostics.memoriesOmittedForRelevance, 2);
  assert.equal(result.diagnostics.memoriesOmittedForBudget, 1);
  assert.equal(result.diagnostics.memoryRetrievalDurationMs, 3);
  assert.equal(result.diagnostics.estimatedInputTokens, finalCountInput.reduce((sum, item) => sum + item.content.length, 0));
  assert.equal(JSON.stringify(result.diagnostics).includes('User prefers Rust'), false);
});

test('memory candidates are omitted before consuming the budget required by the current user turn and recent raw messages', async () => {
  const tiny = { ...model, contextWindow: 150, maxOutputTokens: 20 };
  const rows = [msg('u1','user','recent question',1), msg('a1','assistant','recent answer',2), msg('u2','user','current request',3)];
  const memory = { id: 'too-large', content: 'x'.repeat(1000), category: 'other', tags: [], relevance: 1 };
  const result = await new ContextBuilder(0,0,0).build({ model: tiny, messages: rows, currentUserMessageId: 'u2', savedMemories: [memory], reservedOutputTokens: 20, signal: new AbortController().signal });
  assert.deepEqual(result.messages.map(item => item.id), ['u1','a1','u2']);
  assert.equal(result.savedMemories.length, 0);
  assert.equal(result.diagnostics.memoriesOmittedForBudget, 1);
  assert.equal(result.diagnostics.selectedMessageCount, 3);
});

test('a conversation summary cannot displace a recent raw turn', async () => {
  const rows = [msg('u1','user','12345678901234567890',1), msg('a1','assistant','abcdefghijklmnopqrst',2), msg('u2','user','current request text',3)];
  const result = await new ContextBuilder(0,0,0).build({
    model: { ...model, contextWindow: 100 }, messages: rows, currentUserMessageId: 'u2',
    conversationSummary: { text: 'A summary that uses extra budget.', coveredThroughSequence: 0 }, reservedOutputTokens: 20,
    signal: new AbortController().signal,
    countInputTokens: async input => input.reduce((sum, item) => sum + item.content.length, 0),
  });
  assert.deepEqual(result.messages.map(item => item.id), ['u1','a1','u2']);
  assert.equal(result.diagnostics.summaryIncluded, false);
});
