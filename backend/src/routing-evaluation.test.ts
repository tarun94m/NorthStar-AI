import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, type ModelDefinition } from './model-registry.js';
import { ModelRouter } from './model-router.js';
import { evaluateDeterministicRouting, ROUTING_EVALUATION_DATASET, runBlindedQualityEvaluation } from './routing-evaluation.js';

const textOnlyModel: ModelDefinition = {
  id: 'test:text', providerId: 'test', providerModelId: 'text', displayName: 'Test', description: 'Text-only evaluation model', enabled: true, configured: true,
  capabilities: { streaming: true, nonStreaming: true, text: true, imageInput: false, webSearch: false, documentInput: false, structuredOutput: false, toolCalling: false },
  contextWindow: 100_000, maxOutputTokens: 2_000, tokenizer: 'conservative_utf8_approximation', parameters: {},
};

test('routing evaluation reports deterministic fit/classification and marks quality/fallback as unverified', () => {
  const registry = new ModelRegistry([textOnlyModel]); const router = new ModelRouter(registry, 'test:text');
  const report = evaluateDeterministicRouting(registry, router, () => true, false);
  assert.equal(report.datasetSize, ROUTING_EVALUATION_DATASET.length);
  assert.equal(report.taskClassification.correct, report.datasetSize);
  assert.equal(report.capabilityCompliance.checked, 4);
  assert.equal(report.capabilityCompliance.compliant, 4);
  assert.equal(report.contextFit.checked, 5);
  assert.equal(report.contextFit.compliant, 5);
  assert.deepEqual(report.modelSelectionDistribution, { 'test:text': 5 });
  assert.equal(report.fallbackFrequency.status, 'not_simulated');
  assert.equal(report.responseQuality.status, 'not_evaluated');
});

test('blinded comparison evaluator receives candidate labels and outputs without model IDs', async () => {
  let evaluatorInput: any;
  const result = await runBlindedQualityEvaluation(ROUTING_EVALUATION_DATASET.slice(0, 1), ['provider:model-a', 'provider:model-b'], async () => ({ text: 'candidate response', inputTokens: 10, outputTokens: 5 }), async input => {
    evaluatorInput = input;
    return { ratings: Object.fromEntries(input.candidates.map((candidate, index) => [candidate.label, index + 1])), rationale: 'Applied the supplied criteria.' };
  });
  assert.equal(evaluatorInput.candidates.length, 2);
  assert.equal('modelId' in evaluatorInput, false);
  assert.equal(JSON.stringify(evaluatorInput).includes('provider:model-a'), false);
  assert.equal(result[0]?.ratings[Object.keys(result[0]!.ratings)[0]!], 1);
  assert.deepEqual(new Set(Object.values(result[0]!.modelIdsByLabel)), new Set(['provider:model-a', 'provider:model-b']));
  assert.ok(Object.values(result[0]!.metricsByLabel).every(value => value.latencyMs >= 0));
});
