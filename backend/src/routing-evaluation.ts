import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { estimateCost, type ModelRegistry } from './model-registry.js';
import { ModelRouter } from './model-router.js';
import { classifyTask, type PublicTaskType } from './task-classifier.js';

export type RoutingEvalCase = { id: string; prompt: string; expectedTask: PublicTaskType; qualityCriteria: string[]; outputTokens: number };

export const ROUTING_EVALUATION_DATASET: readonly RoutingEvalCase[] = [
  { id: 'general-explain', prompt: 'Explain how a database index helps a query.', expectedTask: 'general_conversation', qualityCriteria: ['Correct explanation', 'Clear for a general reader'], outputTokens: 120 },
  { id: 'reasoning-tradeoff', prompt: 'Reason through the trade-offs between consistency and availability step by step.', expectedTask: 'complex_reasoning', qualityCriteria: ['Covers material trade-offs', 'Reasoning is internally consistent'], outputTokens: 240 },
  { id: 'coding-debug', prompt: 'Debug this TypeScript function and explain the smallest safe fix.', expectedTask: 'coding', qualityCriteria: ['Fix addresses the defect', 'No unrelated changes'], outputTokens: 200 },
  { id: 'writing-edit', prompt: 'Rewrite this announcement in a warm, concise tone.', expectedTask: 'writing', qualityCriteria: ['Preserves meaning', 'Matches requested tone'], outputTokens: 140 },
  { id: 'document-review', prompt: 'Analyze this contract and list the obligations stated in the text.', expectedTask: 'document_analysis', qualityCriteria: ['Uses only supplied text', 'Findings are complete'], outputTokens: 220 },
  { id: 'research-current', prompt: 'Research current information online and cite the sources you used.', expectedTask: 'research', qualityCriteria: ['Uses current sources', 'Citations support claims'], outputTokens: 220 },
  { id: 'vision-screenshot', prompt: 'Look at this screenshot and identify the visible error.', expectedTask: 'vision', qualityCriteria: ['Accurately reads the image', 'Does not infer unseen details'], outputTokens: 120 },
  { id: 'structured-json', prompt: 'Extract the named fields and return valid JSON matching the schema.', expectedTask: 'structured_extraction', qualityCriteria: ['Valid schema-conforming JSON', 'No extra fields'], outputTokens: 160 },
  { id: 'tool-operation', prompt: 'Call the external API and execute the requested operation.', expectedTask: 'tool_intensive', qualityCriteria: ['Uses the authorized tool', 'Reports execution result accurately'], outputTokens: 180 },
];

export type DeterministicRoutingEvaluation = {
  datasetSize: number;
  taskClassification: { correct: number; accuracy: number };
  capabilityCompliance: { checked: number; compliant: number };
  contextFit: { checked: number; compliant: number };
  modelSelectionDistribution: Record<string, number>;
  routingLatencyMs: { total: number; average: number };
  selectedModelEstimatedCostUsd: number | null;
  fallbackFrequency: { status: 'not_simulated'; attempts: 0 };
  responseQuality: { status: 'not_evaluated'; reason: string };
};

export function evaluateDeterministicRouting(registry: ModelRegistry, router: ModelRouter, providerAvailable: (providerId: string) => boolean, allowMock: boolean): DeterministicRoutingEvaluation {
  let correct = 0; let capabilityChecked = 0; let capabilityCompliant = 0; let contextChecked = 0; let contextCompliant = 0; let elapsed = 0; let estimatedCost = 0; let hasCost = false;
  const distribution: Record<string, number> = {};
  for (const sample of ROUTING_EVALUATION_DATASET) {
    const task = classifyTask(sample.prompt);
    if (task.taskType === sample.expectedTask) correct++;
    const estimatedInputTokens = Math.max(1, Math.ceil(sample.prompt.length / 4));
    const start = performance.now();
    const plan = router.plan({ task, parameters: {}, estimatedInputTokens, reservedOutputTokens: sample.outputTokens, providerAvailable, allowMock });
    elapsed += performance.now() - start;
    if (task.requiredCapabilities.length) {
      capabilityChecked++;
      if ((plan.failureCode === 'TASK_CAPABILITY_UNAVAILABLE' && registry.all().filter(model => model.enabled && model.configured && providerAvailable(model.providerId)).every(model => !task.requiredCapabilities.some(cap => model.capabilities[cap as keyof typeof model.capabilities] === true)))
        || (plan.candidates.length > 0 && plan.candidates.every(candidate => task.requiredCapabilities.every(cap => candidate.model.capabilities[cap as keyof typeof candidate.model.capabilities] === true)))) capabilityCompliant++;
    }
    if (plan.candidates.length) {
      contextChecked++;
      if (plan.candidates.every(candidate => candidate.model.contextWindow >= estimatedInputTokens + Math.min(sample.outputTokens, candidate.model.maxOutputTokens))) contextCompliant++;
      const selected = plan.candidates[0]!.model;
      distribution[selected.id] = (distribution[selected.id] ?? 0) + 1;
      const value = estimateCost(selected.id, estimatedInputTokens, sample.outputTokens);
      if (value !== null) { estimatedCost += value; hasCost = true; }
    }
  }
  return {
    datasetSize: ROUTING_EVALUATION_DATASET.length,
    taskClassification: { correct, accuracy: correct / ROUTING_EVALUATION_DATASET.length },
    capabilityCompliance: { checked: capabilityChecked, compliant: capabilityCompliant },
    contextFit: { checked: contextChecked, compliant: contextCompliant },
    modelSelectionDistribution: distribution,
    routingLatencyMs: { total: elapsed, average: elapsed / ROUTING_EVALUATION_DATASET.length },
    selectedModelEstimatedCostUsd: hasCost ? estimatedCost : null,
    fallbackFrequency: { status: 'not_simulated', attempts: 0 },
    responseQuality: { status: 'not_evaluated', reason: 'No live blinded provider outputs or independent evaluator are configured.' },
  };
}

export type BlindCandidate = { label: string; text: string };
export type BlindQualityEvaluation = { caseId: string; ratings: Record<string, number>; rationale?: string; modelIdsByLabel: Record<string, string>; metricsByLabel: Record<string, { latencyMs: number; estimatedCostUsd: number | null }> };

/** Runs a future live comparison while hiding model identifiers from the evaluator callback. */
export async function runBlindedQualityEvaluation(
  cases: readonly RoutingEvalCase[],
  modelIds: readonly string[],
  generate: (modelId: string, prompt: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>,
  evaluate: (input: { prompt: string; criteria: readonly string[]; candidates: readonly BlindCandidate[] }) => Promise<{ ratings: Record<string, number>; rationale?: string }>,
) {
  const results: BlindQualityEvaluation[] = [];
  for (const sample of cases) {
    const outputs = await Promise.all(modelIds.map(async modelId => {
      const start = performance.now(); const generated = await generate(modelId, sample.prompt);
      return { modelId, ...generated, latencyMs: performance.now() - start, estimatedCostUsd: estimateCost(modelId, generated.inputTokens, generated.outputTokens) };
    }));
    const labels = outputs.map(() => `candidate-${randomUUID()}`);
    const blindCandidates = outputs.map((output, index) => ({ label: labels[index]!, text: output.text }));
    const judged = await evaluate({ prompt: sample.prompt, criteria: sample.qualityCriteria, candidates: blindCandidates });
    const ratings: Record<string, number> = {};
    const modelIdsByLabel: Record<string, string> = {};
    const metricsByLabel: BlindQualityEvaluation['metricsByLabel'] = {};
    outputs.forEach((output, index) => { const label = labels[index]!; ratings[label] = judged.ratings[label] ?? 0; modelIdsByLabel[label] = output.modelId; metricsByLabel[label] = { latencyMs: output.latencyMs, estimatedCostUsd: output.estimatedCostUsd }; });
    results.push({ caseId: sample.id, ratings, ...(judged.rationale ? { rationale: judged.rationale } : {}), modelIdsByLabel, metricsByLabel });
  }
  return results;
}
