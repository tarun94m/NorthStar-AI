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
