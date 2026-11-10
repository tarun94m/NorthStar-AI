import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, type ModelDefinition } from './model-registry.js';
import { ModelRouter } from './model-router.js';
import { classifyTask } from './task-classifier.js';

const makeModel = (id: string, options: Partial<ModelDefinition> = {}): ModelDefinition => ({
  id, providerId: id.split(':')[0]!, providerModelId: id.split(':')[1]!, displayName: id, description: id,
  enabled: true, configured: true,
  capabilities: { streaming: true, nonStreaming: true, text: true, imageInput: false, webSearch: false, documentInput: false, structuredOutput: false, toolCalling: false },
  contextWindow: 20_000, maxOutputTokens: 2_000, tokenizer: 'conservative_utf8_approximation',
  parameters: { temperature: { type: 'number', min: 0, max: 2 } }, ...options,
});

test('task classifier uses deterministic public profiles and only defaults to general when uncertain', () => {
  assert.equal(classifyTask('Please debug this TypeScript function').taskType, 'coding');
  assert.equal(classifyTask('Write a short welcome email').taskType, 'writing');
  assert.equal(classifyTask('What is a database index?').taskType, 'general_conversation');
  assert.equal(classifyTask('do not truncate this current request').taskType, 'general_conversation');
  assert.deepEqual(classifyTask('What are the current model prices?').requiredCapabilities, ['webSearch']);
  assert.deepEqual(classifyTask('Look at this screenshot').requiredCapabilities, ['imageInput']);
  assert.deepEqual(classifyTask('Find current sources online', 'research'), { taskType: 'research', requiredCapabilities: ['webSearch'], reasonCode: 'explicit_task_type', classificationSource: 'explicit' });
});

test('router filters unavailable capability/context/parameter candidates and does not invent quality', () => {
  const preferred = makeModel('alpha:general');
  const restricted = makeModel('beta:small', { contextWindow: 100 });
  const disabled = makeModel('gamma:off', { enabled: false });
  const router = new ModelRouter(new ModelRegistry([preferred, restricted, disabled]), 'beta:small,alpha:general');
  const input = { task: classifyTask('Explain this'), parameters: {}, estimatedInputTokens: 200, reservedOutputTokens: 50, providerAvailable: () => true, allowMock: false };
  const plan = router.plan(input);
  assert.deepEqual(plan.candidates.map(candidate => candidate.model.id), ['alpha:general']);
  assert.equal(plan.candidates[0]?.reasonCode, 'configured_model_preference');
  assert.equal(plan.candidates[0]?.model.qualityEvidence, undefined);
  assert.equal(plan.failureCode, undefined);
  assert.equal(router.plan({ ...input, task: classifyTask('describe a photo') }).failureCode, 'TASK_CAPABILITY_UNAVAILABLE');
  assert.equal(router.plan({ ...input, estimatedInputTokens: 30_000 }).failureCode, 'CONTEXT_TOO_LARGE');
});

test('router ranks recorded task and quality evidence ahead of cost-neutral configured preferences', () => {
  const noEvidence = makeModel('alpha:cheap');
  const taskEvidence = makeModel('beta:task', { taskSuitability: { coding: { score: 0.8, sampleSize: 40, benchmark: 'internal-coding-v1', evaluatedAt: '2026-10-01' } } });
  const qualityEvidence = makeModel('gamma:quality', { qualityEvidence: { score: 0.99, sampleSize: 500, benchmark: 'internal-general-v1', evaluatedAt: '2026-10-01' } });
  const router = new ModelRouter(new ModelRegistry([noEvidence, qualityEvidence, taskEvidence]), 'alpha:cheap,gamma:quality,beta:task');
  const plan = router.plan({ task: classifyTask('fix this bug'), parameters: {}, estimatedInputTokens: 100, reservedOutputTokens: 100, providerAvailable: () => true, allowMock: false });
  assert.deepEqual(plan.candidates.map(candidate => candidate.model.id), ['beta:task', 'gamma:quality', 'alpha:cheap']);
  assert.equal(plan.candidates[0]?.reasonCode, 'task_suitability_evidence');
  assert.equal(plan.candidates[1]?.reasonCode, 'quality_evidence');
});

test('configured preference cannot route production traffic to mock and strict capability requests are rejected', () => {
  const mock = makeModel('mock:echo', { providerId: 'mock' });
  const router = new ModelRouter(new ModelRegistry([mock]), 'mock:echo');
  const base = { task: classifyTask('hello'), parameters: {}, estimatedInputTokens: 1, reservedOutputTokens: 1, providerAvailable: () => true };
  assert.equal(router.plan({ ...base, allowMock: false }).failureCode, 'NO_ELIGIBLE_MODEL');
  assert.equal(router.plan({ ...base, allowMock: true }).candidates[0]?.model.providerId, 'mock');
  assert.equal(router.plan({ ...base, task: classifyTask('extract to JSON') , allowMock: true }).failureCode, 'TASK_CAPABILITY_UNAVAILABLE');
});
