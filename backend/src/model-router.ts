import { config } from './config.js';
import { ModelRegistry, ModelResolutionError, type ModelDefinition } from './model-registry.js';
import type { TaskClassification } from './task-classifier.js';

export type RouteCandidate = { model: ModelDefinition; reasonCode: string };
export type RoutePlan = { candidates: RouteCandidate[]; policyVersion: string; failureCode?: 'TASK_CAPABILITY_UNAVAILABLE' | 'CONTEXT_TOO_LARGE' | 'NO_ELIGIBLE_MODEL' };

export type RouteInput = {
  task: TaskClassification;
  parameters: Record<string, unknown>;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  preferredModelId?: string | null;
  parameterErrorCode?: 'UNSUPPORTED_PARAMETER' | 'SAVED_PARAMETER_UNSUPPORTED';
  providerAvailable: (providerId: string) => boolean;
  allowMock: boolean;
};

/** Provider-independent selection over registry metadata. Quality/suitability evidence is optional and never synthesized. */
export class ModelRouter {
  readonly policyVersion = config.AUTO_ROUTING_POLICY_VERSION;
  private readonly preference: string[];
  constructor(private readonly registry: ModelRegistry, preference = config.AUTO_MODEL_PREFERENCE) {
    this.preference = preference.split(',').map(item => item.trim()).filter(Boolean);
  }

  plan(input: RouteInput): RoutePlan {
    const allModels = this.registry.all();
    let candidates = allModels.filter(model => model.enabled && model.configured && model.capabilities.text && model.capabilities.streaming
      && input.providerAvailable(model.providerId) && (input.allowMock || model.providerId !== 'mock'));
    if (!candidates.length) return { candidates: [], policyVersion: this.policyVersion, failureCode: 'NO_ELIGIBLE_MODEL' };

    const hasRequiredCapability = candidates.some(model => input.task.requiredCapabilities.every(capability => model.capabilities[capability as keyof ModelDefinition['capabilities']] === true));
    if (!hasRequiredCapability) return { candidates: [], policyVersion: this.policyVersion, failureCode: 'TASK_CAPABILITY_UNAVAILABLE' };
    candidates = candidates.filter(model => input.task.requiredCapabilities.every(capability => model.capabilities[capability as keyof ModelDefinition['capabilities']] === true));

    let rejectedParameters = 0;
    candidates = candidates.filter(model => {
      try { this.registry.validateParameters(model, input.parameters); }
      catch { rejectedParameters++; return false; }
      const reservedOutput = input.parameters.maxOutputTokens === undefined
        ? Math.min(input.reservedOutputTokens, model.maxOutputTokens)
        : input.reservedOutputTokens;
      return model.contextWindow >= input.estimatedInputTokens + reservedOutput;
    });
    if (!candidates.length && rejectedParameters) {
      const code = input.parameterErrorCode ?? 'UNSUPPORTED_PARAMETER';
      throw new ModelResolutionError(code, 'The requested or saved generation parameters are unsupported by eligible models.', code === 'SAVED_PARAMETER_UNSUPPORTED' ? 409 : 400);
    }
    if (!candidates.length) return { candidates: [], policyVersion: this.policyVersion, failureCode: 'CONTEXT_TOO_LARGE' };

    const prefIndex = (modelId: string) => {
      if (input.preferredModelId === modelId) return -1;
      const index = this.preference.indexOf(modelId);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const taskEvidence = (model: ModelDefinition) => model.taskSuitability?.[input.task.taskType];
    const evidenceReason = (model: ModelDefinition) => taskEvidence(model) ? 'task_suitability_evidence'
      : model.qualityEvidence ? 'quality_evidence'
        : input.preferredModelId === model.id ? 'account_model_preference'
          : this.preference.includes(model.id) ? 'configured_model_preference' : 'eligible_model_fallback';
    candidates.sort((a, b) => {
      const aTask = taskEvidence(a); const bTask = taskEvidence(b);
      if (Boolean(aTask) !== Boolean(bTask)) return aTask ? -1 : 1;
      if (aTask && bTask && aTask.score !== bTask.score) return bTask.score - aTask.score;
      const aQuality = a.qualityEvidence; const bQuality = b.qualityEvidence;
      if (Boolean(aQuality) !== Boolean(bQuality)) return aQuality ? -1 : 1;
      if (aQuality && bQuality && aQuality.score !== bQuality.score) return bQuality.score - aQuality.score;
      return prefIndex(a.id) - prefIndex(b.id) || a.id.localeCompare(b.id);
    });
    return { candidates: candidates.map(model => ({ model, reasonCode: evidenceReason(model) })), policyVersion: this.policyVersion };
  }
}
