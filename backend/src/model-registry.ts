import { config } from './config.js';

export type ParameterDefinition = { type: 'number'; min: number; max: number; default?: number };
export type ModelDefinition = {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  capabilities: { streaming: boolean; nonStreaming: boolean; text: boolean };
  contextWindow: number;
  maxOutputTokens: number;
  tokenizer: 'openai_o200k_base' | 'provider_count_tokens' | 'conservative_utf8_approximation';
  parameters: Record<string, ParameterDefinition>;
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number };
};

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
    capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 1_047_576,
    maxOutputTokens: 32_768, tokenizer: 'openai_o200k_base', parameters: commonParameters,
    pricing: { inputUsdPerMillion: config.OPENAI_INPUT_USD_PER_MILLION, outputUsdPerMillion: config.OPENAI_OUTPUT_USD_PER_MILLION },
  },
  {
    id: 'openai:gpt-4.1', providerId: 'openai', providerModelId: 'gpt-4.1',
    displayName: 'GPT-4.1', description: 'Strong general-purpose model for complex work.',
    enabled: true, configured: Boolean(config.OPENAI_API_KEY),
    capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 1_047_576,
    maxOutputTokens: 32_768, tokenizer: 'openai_o200k_base', parameters: commonParameters,
    pricing: { inputUsdPerMillion: config.OPENAI_INPUT_USD_PER_MILLION_GPT_41, outputUsdPerMillion: config.OPENAI_OUTPUT_USD_PER_MILLION_GPT_41 },
  },
  {
    id: 'gemini:gemini-3.8-flash', providerId: 'gemini', providerModelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash', description: 'Fast model for long-context chat and complex tasks.',
    enabled: true, configured: Boolean(config.GEMINI_API_KEY),
    capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 1_048_576,
    maxOutputTokens: 65_536, tokenizer: 'provider_count_tokens',
    parameters: { ...commonParameters, maxOutputTokens: { ...commonParameters.maxOutputTokens, max: 65_536, default: Math.min(config.MAX_OUTPUT_TOKENS, 65_536) } },
    pricing: { inputUsdPerMillion: config.GEMINI_INPUT_USD_PER_MILLION, outputUsdPerMillion: config.GEMINI_OUTPUT_USD_PER_MILLION },
  },
  {
    id: 'mock:echo', providerId: 'mock', providerModelId: 'echo',
    displayName: 'Local mock', description: 'Local development response; no external AI provider is called.',
    enabled: true, configured: true,
    capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 60_000,
    maxOutputTokens: config.MAX_OUTPUT_TOKENS, tokenizer: 'conservative_utf8_approximation', parameters: {},
  },
];

export class ModelResolutionError extends Error {
  constructor(readonly code: 'MODEL_NOT_FOUND' | 'MODEL_UNAVAILABLE' | 'UNSUPPORTED_PARAMETER', message: string, readonly httpStatus: number) {
    super(message); this.name = 'ModelResolutionError';
  }
}

export class ModelRegistry {
  constructor(private readonly models: readonly ModelDefinition[] = definitions) {}
  all() { return this.models.map(model => ({ ...model, capabilities: { ...model.capabilities }, parameters: { ...model.parameters } })); }
  listForCatalog() {
    const anyRealProviderConfigured = this.models.some(m => m.providerId !== 'mock' && m.configured && m.enabled);
    return this.all().filter(m => m.providerId === 'mock' ? !anyRealProviderConfigured : (m.providerId !== 'gemini' || m.configured));
  }
  resolve(id?: string, parameters: Record<string, unknown> = {}) {
    const selectedId = id ?? this.listForCatalog().find(m => m.configured && m.enabled)?.id ?? 'mock:echo';
    const model = this.models.find(m => m.id === selectedId);
    if (!model) throw new ModelResolutionError('MODEL_NOT_FOUND', 'Unknown model ID. Choose a model returned by GET /api/models.', 400);
    if (!model.enabled || !model.configured) throw new ModelResolutionError('MODEL_UNAVAILABLE', `${model.displayName} is unavailable because its provider is disabled or not configured.`, 503);
    for (const [name, value] of Object.entries(parameters)) {
      const rule = model.parameters[name];
      if (!rule || typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) {
        throw new ModelResolutionError('UNSUPPORTED_PARAMETER', `Parameter '${name}' is unsupported or outside its allowed range for ${model.displayName}.`, 400);
      }
    }
    return model;
  }
}

export const modelRegistry = new ModelRegistry();
export const availableModels = modelRegistry.listForCatalog();

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = modelRegistry.all().find(item => item.id === modelId || item.providerModelId === modelId);
  if (!model?.pricing) return 0;
  return inputTokens * model.pricing.inputUsdPerMillion / 1_000_000 + outputTokens * model.pricing.outputUsdPerMillion / 1_000_000;
}
