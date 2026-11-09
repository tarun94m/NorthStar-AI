import OpenAI from 'openai';
import { config } from './config.js';

export type ChatInput = { role: 'user' | 'assistant'; content: string }[];
export type GenerationParameters = { temperature?: number; topP?: number; maxOutputTokens?: number };
export type GenerationRequest = { input: ChatInput; modelId: string; providerModelId: string; parameters: GenerationParameters; signal: AbortSignal; systemInstructions?: string; responsePreferences?: string };
export type Usage = { inputTokens: number; outputTokens: number };
export type Generation = { chunks: AsyncIterable<string>; usage: Promise<Usage> };
export type Completion = { text: string; usage: Usage };

export class ProviderError extends Error {
  constructor(readonly code: 'PROVIDER_CONFIGURATION' | 'PROVIDER_TIMEOUT' | 'PROVIDER_CANCELLED' | 'PROVIDER_FAILURE' | 'PROVIDER_INCOMPLETE', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ProviderError';
  }
}

export interface AIProvider {
  readonly id: string;
  stream(request: GenerationRequest): Promise<Generation>;
  generate(request: GenerationRequest): Promise<Completion>;
  countInputTokens?(request: Pick<GenerationRequest, 'input' | 'providerModelId' | 'signal' | 'systemInstructions' | 'responsePreferences'>): Promise<number>;
}
export function composeSystemInstruction(instructions = '', preferences = '') {
  return [instructions.trim(), preferences.trim() ? `Response preferences:\n${preferences.trim()}` : ''].filter(Boolean).join('\n\n');
}

const approximateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
const tokenUsage = (input: ChatInput, output: string): Usage => ({
  inputTokens: input.reduce((n, m) => n + approximateTokens(m.content), 0),
  outputTokens: approximateTokens(output),
});
function normalizeProviderError(error: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.reason instanceof Error && /timeout/i.test(signal.reason.message)) return new ProviderError('PROVIDER_TIMEOUT', 'The AI provider request timed out.');
  if (signal?.aborted) return new ProviderError('PROVIDER_CANCELLED', 'The AI provider request was cancelled.');
  if (error instanceof ProviderError) return error;
  return new ProviderError('PROVIDER_FAILURE', 'The AI provider request failed.');
}

export class MockProvider implements AIProvider {
  readonly id = 'mock';
  async stream(request: GenerationRequest): Promise<Generation> {
    const last = [...request.input].reverse().find(m => m.role === 'user')?.content ?? '';
    const text = `This is a local mock response because no AI provider API key is configured. You said: “${last.slice(0, 700)}”`;
    const usage = Promise.resolve(tokenUsage(request.input, text));
    const chunks = (async function* () {
      for (let i = 0; i < text.length; i += 18) {
        if (request.signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, config.MOCK_STREAM_DELAY_MS));
        if (request.signal.aborted) return;
        yield text.slice(i, i + 18);
      }
    })();
    return { chunks, usage };
  }
  async generate(request: GenerationRequest): Promise<Completion> {
    let text = ''; for await (const part of (await this.stream(request)).chunks) text += part;
    return { text, usage: tokenUsage(request.input, text) };
  }
}

type OpenAIClient = Pick<OpenAI, 'responses'>;
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  private client: OpenAIClient;
  constructor(client?: OpenAIClient) {
    if (!client && !config.OPENAI_API_KEY) throw new ProviderError('PROVIDER_CONFIGURATION', 'OpenAI is not configured.');
    this.client = client ?? new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: config.PROVIDER_TIMEOUT_MS, maxRetries: 1 });
  }
  async stream(request: GenerationRequest): Promise<Generation> {
    const body = {
      model: request.providerModelId,
      input: request.input.map(item => ({ role: item.role, content: item.content })),
      ...(composeSystemInstruction(request.systemInstructions, request.responsePreferences) ? { instructions: composeSystemInstruction(request.systemInstructions, request.responsePreferences) } : {}),
      max_output_tokens: request.parameters.maxOutputTokens ?? config.MAX_OUTPUT_TOKENS,
      ...(request.parameters.temperature === undefined ? {} : { temperature: request.parameters.temperature }),
      ...(request.parameters.topP === undefined ? {} : { top_p: request.parameters.topP }),
      stream: true as const,
    };
    let stream: AsyncIterable<any>;
    try { stream = await this.client.responses.create(body, { signal: request.signal }) as AsyncIterable<any>; }
    catch (error) { throw normalizeProviderError(error, request.signal); }
    let usageResolve!: (usage: Usage) => void;
    const usage = new Promise<Usage>(resolve => { usageResolve = resolve; });
    const chunks = (async function* () {
      let observedUsage: Usage = { inputTokens: 0, outputTokens: 0 }, completed = false;
      try {
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') yield event.delta;
          if (event.type === 'response.completed') {
            observedUsage = { inputTokens: event.response?.usage?.input_tokens ?? 0, outputTokens: event.response?.usage?.output_tokens ?? 0 };
            completed = true;
          }
          if (event.type === 'error' || event.type === 'response.failed') throw new ProviderError('PROVIDER_FAILURE', 'OpenAI reported a failed response.');
          if (event.type === 'response.incomplete') throw new ProviderError('PROVIDER_INCOMPLETE', 'OpenAI returned an incomplete response.');
        }
        if (!completed) throw new ProviderError('PROVIDER_INCOMPLETE', 'OpenAI stream ended without a completion event.');
      } catch (error) { throw normalizeProviderError(error, request.signal); }
      finally { usageResolve(observedUsage); }
    })();
    return { chunks, usage };
  }
  async generate(request: GenerationRequest): Promise<Completion> {
    try {
      const response = await this.client.responses.create({
        model: request.providerModelId,
        input: request.input.map(item => ({ role: item.role, content: item.content })),
        ...(composeSystemInstruction(request.systemInstructions, request.responsePreferences) ? { instructions: composeSystemInstruction(request.systemInstructions, request.responsePreferences) } : {}),
        max_output_tokens: request.parameters.maxOutputTokens ?? config.MAX_OUTPUT_TOKENS,
        ...(request.parameters.temperature === undefined ? {} : { temperature: request.parameters.temperature }),
        ...(request.parameters.topP === undefined ? {} : { top_p: request.parameters.topP }),
      }, { signal: request.signal });
      if (!response.output_text) throw new ProviderError('PROVIDER_INCOMPLETE', 'OpenAI returned no text response.');
      return { text: response.output_text, usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 } };
    } catch (error) { throw normalizeProviderError(error, request.signal); }
  }
}

type GeminiClient = { generateContentStream(parameters: any): Promise<AsyncIterable<any>>; generateContent(parameters: any): Promise<any>; countTokens?(parameters: any): Promise<{ totalTokens?: number }> };
export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  private client?: GeminiClient;
  private clientPromise?: Promise<GeminiClient>;
  constructor(client?: GeminiClient) {
    if (!client && !config.GEMINI_API_KEY) throw new ProviderError('PROVIDER_CONFIGURATION', 'Gemini is not configured.');
    this.client = client;
  }
  private async getClient(): Promise<GeminiClient> {
    if (this.client) return this.client;
    this.clientPromise ??= (async () => {
      const moduleName = '@google/genai';
      const sdk = await import(moduleName) as { GoogleGenAI: new (options: unknown) => { models: GeminiClient } };
      return new sdk.GoogleGenAI({ apiKey: config.GEMINI_API_KEY, httpOptions: { timeout: config.PROVIDER_TIMEOUT_MS } }).models;
    })();
    return this.clientPromise;
  }
  private contents(input: ChatInput) {
    return input.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] }));
  }
  async countInputTokens(request: Pick<GenerationRequest, 'input' | 'providerModelId' | 'signal' | 'systemInstructions' | 'responsePreferences'>) {
    const client = await this.getClient();
    if (!client.countTokens) throw new Error('Provider token counting unavailable');
    const result = await client.countTokens({ model: request.providerModelId, contents: this.contents(request.input), config: { systemInstruction: composeSystemInstruction(request.systemInstructions, request.responsePreferences), abortSignal: request.signal } });
    if (typeof result.totalTokens !== 'number') throw new Error('Provider token count unavailable');
    return result.totalTokens;
  }
  async stream(request: GenerationRequest): Promise<Generation> {
    try {
      const stream = await (await this.getClient()).generateContentStream({
        model: request.providerModelId,
        contents: this.contents(request.input),
        config: {
          maxOutputTokens: request.parameters.maxOutputTokens ?? config.MAX_OUTPUT_TOKENS,
          ...(composeSystemInstruction(request.systemInstructions, request.responsePreferences) ? { systemInstruction: composeSystemInstruction(request.systemInstructions, request.responsePreferences) } : {}),
          ...(request.parameters.temperature === undefined ? {} : { temperature: request.parameters.temperature }),
          ...(request.parameters.topP === undefined ? {} : { topP: request.parameters.topP }),
          abortSignal: request.signal,
        },
      });
      let usageResolve!: (usage: Usage) => void;
      const usage = new Promise<Usage>(resolve => { usageResolve = resolve; });
      const chunks = (async function* () {
        let observedUsage: Usage = { inputTokens: 0, outputTokens: 0 }, finishReason: string | undefined;
        try {
          for await (const chunk of stream) {
            if (typeof chunk.text === 'string' && chunk.text) yield chunk.text;
            if (chunk.usageMetadata) observedUsage = {
              inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
              outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            };
            const reason = chunk.candidates?.[0]?.finishReason;
            if (reason) finishReason = String(reason);
          }
          if (!finishReason) throw new ProviderError('PROVIDER_INCOMPLETE', 'Gemini stream ended without a finish reason.');
          if (!['STOP', 'MAX_TOKENS'].includes(finishReason)) throw new ProviderError('PROVIDER_FAILURE', `Gemini ended the response with ${finishReason}.`);
        } catch (error) { throw normalizeProviderError(error, request.signal); }
        finally { usageResolve(observedUsage); }
      })();
      return { chunks, usage };
    } catch (error) { throw normalizeProviderError(error, request.signal); }
  }
  async generate(request: GenerationRequest): Promise<Completion> {
    try {
      const response = await (await this.getClient()).generateContent({
        model: request.providerModelId, contents: this.contents(request.input),
        config: {
          maxOutputTokens: request.parameters.maxOutputTokens ?? config.MAX_OUTPUT_TOKENS,
          ...(composeSystemInstruction(request.systemInstructions, request.responsePreferences) ? { systemInstruction: composeSystemInstruction(request.systemInstructions, request.responsePreferences) } : {}),
          ...(request.parameters.temperature === undefined ? {} : { temperature: request.parameters.temperature }),
          ...(request.parameters.topP === undefined ? {} : { topP: request.parameters.topP }),
          abortSignal: request.signal,
        },
      });
      const finishReason = response.candidates?.[0]?.finishReason;
      if (!response.text || !finishReason || !['STOP', 'MAX_TOKENS'].includes(String(finishReason))) throw new ProviderError('PROVIDER_INCOMPLETE', 'Gemini returned an incomplete response.');
      return { text: response.text, usage: { inputTokens: response.usageMetadata?.promptTokenCount ?? 0, outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0 } };
    } catch (error) { throw normalizeProviderError(error, request.signal); }
  }
}

export class ProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<string, AIProvider>) {}
  resolve(id: string) {
    const provider = this.providers.get(id);
    if (!provider) throw new ProviderError('PROVIDER_CONFIGURATION', `Provider '${id}' is not configured.`);
    return provider;
  }
}

const providers = new Map<string, AIProvider>();
if (config.OPENAI_API_KEY) providers.set('openai', new OpenAIProvider());
if (config.GEMINI_API_KEY) providers.set('gemini', new GeminiProvider());
if (!providers.size) providers.set('mock', new MockProvider());
export const providerRegistry = new ProviderRegistry(providers);
export const provider: AIProvider = providers.values().next().value as AIProvider;
export const activeProvider = provider;
