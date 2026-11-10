import { config } from './config.js';
import { createHash } from 'node:crypto';

export type ParameterDefinition = { type: 'number'; min: number; max: number; default?: number };
export type ModelTaskType = 'general_conversation' | 'complex_reasoning' | 'coding' | 'writing' | 'document_analysis' | 'research' | 'vision' | 'structured_extraction' | 'conversation_summarization' | 'memory_extraction' | 'tool_intensive';
export type Evidence = { score: number; sampleSize: number; benchmark: string; evaluatedAt: string };
export type ModelDefinition = {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  capabilities: { streaming: boolean; nonStreaming: boolean; text: boolean; imageInput?: boolean; webSearch?: boolean; documentInput?: boolean; structuredOutput?: boolean; toolCalling?: boolean };
  taskSuitability?: Partial<Record<ModelTaskType, Evidence>>;
  qualityEvidence?: Evidence;
  contextWindow: number;
  maxOutputTokens: number;
  tokenizer: 'openai_o200k_base' | 'provider_count_tokens' | 'conservative_utf8_approximation';
  parameters: Record<string, ParameterDefinition>;
  pricing?: { inputPerMillion: number; outputPerMillion: number; currency: string; version: string; effectiveAt: string };
};
export type PricingSnapshot = { pricingCurrency: string; pricingVersion: string; pricingEffectiveAt: Date } | { pricingCurrency: null; pricingVersion: null; pricingEffectiveAt: null };

function pricingSnapshot(providerId: 'openai' | 'gemini' | 'mock', inputPerMillion: number, outputPerMillion: number) {
  const currency = providerId === 'openai' ? config.OPENAI_PRICING_CURRENCY : providerId === 'gemini' ? config.GEMINI_PRICING_CURRENCY : 'USD';
  const configuredVersion = providerId === 'openai' ? config.OPENAI_PRICING_VERSION : providerId === 'gemini' ? config.GEMINI_PRICING_VERSION : 'mock-zero-v1';
  const effectiveAt = config.PRICING_EFFECTIVE_AT;
  const digest = createHash('sha256').update(JSON.stringify({ providerId, currency, inputPerMillion, outputPerMillion })).digest('hex').slice(0, 12);
  return { inputPerMillion, outputPerMillion, currency, version: `${configuredVersion}-${digest}`, effectiveAt };
}

const openAiMiniInput = config.OPENAI_INPUT_PRICE_PER_MILLION ?? config.OPENAI_INPUT_USD_PER_MILLION;
const openAiMiniOutput = config.OPENAI_OUTPUT_PRICE_PER_MILLION ?? config.OPENAI_OUTPUT_USD_PER_MILLION;
const openAi41Input = config.OPENAI_GPT_41_INPUT_PRICE_PER_MILLION ?? config.OPENAI_INPUT_USD_PER_MILLION_GPT_41;
const openAi41Output = config.OPENAI_GPT_41_OUTPUT_PRICE_PER_MILLION ?? config.OPENAI_OUTPUT_USD_PER_MILLION_GPT_41;
const geminiInput = config.GEMINI_INPUT_PRICE_PER_MILLION ?? config.GEMINI_INPUT_USD_PER_MILLION;
const geminiOutput = config.GEMINI_OUTPUT_PRICE_PER_MILLION ?? config.GEMINI_OUTPUT_USD_PER_MILLION;

const commonParameters = {
  temperature: { type: 'number' as const, min: 0, max: 2, default: 0.7 },
  topP: { type: 'number' as const, min: 0, max: 1, default: 1 },
  maxOutputTokens: { type: 'number' as const, min: 1, max: 32768, default: Math.min(config.MAX_OUTPUT_TOKENS, 32768) },
};

const definitions: ModelDefinition[] = [
  {
    id: 'openai:gpt-4.1-mini', providerId: 'openai', providerModelId: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini', description: 'Fast, capable model for everyday conversations.',
    enabled: true, configured: Boolean(config.OPENAI_API_KEY),
    capabilities: { streaming: true, nonStreaming: true, text: true, imageInput: false, webSearch: false, documentInput: false, structuredOutput: false, toolCalling: false }, contextWindow: 1_047_576,
    maxOutputTokens: 32_768, tokenizer: 'openai_o200k_base', parameters: commonParameters,
    pricing: pricingSnapshot('openai', openAiMiniInput, openAiMiniOutput),
  },
  {
    id: 'openai:gpt-4.1', providerId: 'openai', providerModelId: 'gpt-4.1',
    displayName: 'GPT-4.1', description: 'Strong general-purpose model for complex work.',
    enabled: true, configured: Boolean(config.OPENAI_API_KEY),
    capabilities: { streaming: true, nonStreaming: true, text: true, imageInput: false, webSearch: false, documentInput: false, structuredOutput: false, toolCalling: false }, contextWindow: 1_047_576,
    maxOutputTokens: 32_768, tokenizer: 'openai_o200k_base', parameters: commonParameters,
    pricing: pricingSnapshot('openai', openAi41Input, openAi41Output),
  },
  {
    id: 'gemini:gemini-3.8-flash', providerId: 'gemini', providerModelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash', description: 'Fast model for long-context chat and complex tasks.',
    enabled: true, configured: Boolean(config.GEMINI_API_KEY),
    capabilities: { streaming: true, nonStreaming: true, text: true, imageInput: false, webSearch: false, documentInput: false, structuredOutput: false, toolCalling: false }, contextWindow: 1_048_576,
    maxOutputTokens: 65_536, tokenizer: 'provider_count_tokens',
    // Gemini 3.8 Flash no longer accepts temperature/topP generation settings.
    parameters: { maxOutputTokens: { ...commonParameters.maxOutputTokens, max: 65_536, default: Math.min(config.MAX_OUTPUT_TOKENS, 65_536) } },
    pricing: pricingSnapshot('gemini', geminiInput, geminiOutput),
  },
  {
    id: 'mock:echo', providerId: 'mock', providerModelId: 'echo',
    displayName: 'Local mock', description: 'Local development response; no external AI provider is called.',
    enabled: config.MOCK_PROVIDER_ENABLED, configured: config.MOCK_PROVIDER_ENABLED,
    capabilities: { streaming: true, nonStreaming: true, text: true, imageInput: false, webSearch: false, documentInput: false, structuredOutput: false, toolCalling: false }, contextWindow: 60_000,
    maxOutputTokens: config.MAX_OUTPUT_TOKENS, tokenizer: 'conservative_utf8_approximation', parameters: {}, pricing: pricingSnapshot('mock', 0, 0),
  },
];

export class ModelResolutionError extends Error {
  constructor(readonly code: 'MODEL_NOT_FOUND' | 'MODEL_UNAVAILABLE' | 'UNSUPPORTED_PARAMETER' | 'SAVED_PARAMETER_UNSUPPORTED', message: string, readonly httpStatus: number) {
    super(message); this.name = 'ModelResolutionError';
  }
}

export class ModelRegistry {
  constructor(private readonly models: readonly ModelDefinition[] = definitions) {}
  all() { return this.models.map(model => ({ ...model, capabilities: { ...model.capabilities }, parameters: { ...model.parameters }, pricing: model.pricing ? { ...model.pricing } : undefined, taskSuitability: model.taskSuitability ? { ...model.taskSuitability } : undefined, qualityEvidence: model.qualityEvidence ? { ...model.qualityEvidence } : undefined })); }
  find(id: string) { return this.models.find(model => model.id === id); }
  listForCatalog() {
    return this.all().filter(m => m.providerId !== 'mock' || (m.configured && m.enabled))
      .filter(m => m.providerId !== 'gemini' || m.configured);
  }
  resolve(id?: string, parameters: Record<string, unknown> = {}) {
    const selectedId = id ?? this.listForCatalog().find(m => m.configured && m.enabled)?.id;
    if (!selectedId) throw new ModelResolutionError('MODEL_UNAVAILABLE', 'No AI model is configured. Configure a provider or explicitly enable the development mock.', 503);
    const model = this.models.find(m => m.id === selectedId);
    if (!model) throw new ModelResolutionError('MODEL_NOT_FOUND', 'Unknown model ID. Choose a model returned by GET /api/models.', 400);
    if (!model.enabled || !model.configured) throw new ModelResolutionError('MODEL_UNAVAILABLE', `${model.displayName} is unavailable because its provider is disabled or not configured.`, 503);
    this.validateParameters(model, parameters);
    return model;
  }
  getPricingSnapshot(modelId: string): PricingSnapshot {
    const model = this.models.find(item => item.id === modelId || item.providerModelId === modelId);
    if (!model?.pricing) return { pricingCurrency: null, pricingVersion: null, pricingEffectiveAt: null };
    return { pricingCurrency: model.pricing.currency, pricingVersion: model.pricing.version, pricingEffectiveAt: new Date(model.pricing.effectiveAt) };
  }
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number | null {
    const model = this.models.find(item => item.id === modelId || item.providerModelId === modelId);
    if (!model?.pricing) return null;
    return inputTokens * model.pricing.inputPerMillion / 1_000_000 + outputTokens * model.pricing.outputPerMillion / 1_000_000;
  }
  validateParameters(model: ModelDefinition, parameters: Record<string, unknown>, code: 'UNSUPPORTED_PARAMETER' | 'SAVED_PARAMETER_UNSUPPORTED' = 'UNSUPPORTED_PARAMETER') {
    for (const [name, value] of Object.entries(parameters)) {
      const rule = model.parameters[name];
      if (!rule || typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) {
        throw new ModelResolutionError(code, `Parameter '${name}' is unsupported or outside its allowed range for ${model.displayName}.`, code === 'SAVED_PARAMETER_UNSUPPORTED' ? 409 : 400);
      }
    }
  }
}

export const modelRegistry = new ModelRegistry();
export const availableModels = modelRegistry.listForCatalog();

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number | null {
  return modelRegistry.estimateCost(modelId, inputTokens, outputTokens);
}
