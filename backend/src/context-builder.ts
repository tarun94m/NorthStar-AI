import { get_encoding } from '@dqbd/tiktoken';
import type { ModelDefinition } from './model-registry.js';
import type { ChatInput } from './ai.js';
import { composeSystemInstruction } from './ai.js';

export type ContextMessage = { id: string; role: 'user' | 'assistant'; content: string; sequence: number };
export type ContextDiagnostics = {
  modelId: string; providerId: string; estimatedInputTokens: number; tokenEstimateMethod: string; tokenEstimateApproximate: boolean;
  reservedOutputTokens: number; safetyReserveTokens: number; effectiveContextBudget: number;
  selectedMessageCount: number; omittedMessageCount: number; truncated: boolean;
  truncationReason: string | null; constructionDurationMs: number;
};
export type BuiltContext = { systemInstructions: string; responsePreferences: string; conversationSummary: null; savedMemories: never[]; messages: ContextMessage[]; diagnostics: ContextDiagnostics };
export class ContextBudgetError extends Error {
  readonly code = 'CONTEXT_TOO_LARGE'; readonly httpStatus = 413;
  constructor() { super('This message is too large for the selected model after reserving room for its response. Shorten the message or choose a model with a larger context window.'); this.name = 'ContextBudgetError'; }
}

const DEFAULT_INSTRUCTIONS = 'You are a helpful AI assistant. Be accurate, clear, and concise. Ask clarifying questions when needed.';
let encoding: ReturnType<typeof get_encoding> | undefined;
function openAITokenCount(text: string) {
  encoding ??= get_encoding('o200k_base');
  return encoding.encode(text).length;
}
function approximate(messages: ContextMessage[], systemInstructions: string, responsePreferences: string) {
  const textTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
  return messages.reduce((sum, message) => sum + textTokens(message.content) + 4, 0) + textTokens(composeSystemInstruction(systemInstructions, responsePreferences)) + 8;
}
function exactLocal(messages: ContextMessage[], systemInstructions: string, responsePreferences: string) {
  return messages.reduce((sum, message) => sum + openAITokenCount(message.content) + 4, 0) + openAITokenCount(composeSystemInstruction(systemInstructions, responsePreferences)) + 8;
}
function turnsOf(messages: ContextMessage[]) {
  const turns: ContextMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push([message]);
    else if (turns.length) turns[turns.length - 1]!.push(message);
  }
  return turns;
}

export class ContextBuilder {
  constructor(private readonly safetyRatio = 0.02, private readonly minSafety = 128, private readonly maxSafety = 8192) {}
  async build(options: {
    model: ModelDefinition; messages: ContextMessage[]; currentUserMessageId: string; responsePreferences?: string;
    reservedOutputTokens: number; countInputTokens?: (input: ChatInput, systemInstructions: string, responsePreferences: string, signal: AbortSignal) => Promise<number>;
    signal: AbortSignal;
  }): Promise<BuiltContext> {
    const started = Date.now();
    const chronological = [...options.messages].sort((a, b) => a.sequence - b.sequence);
    const currentIndex = chronological.findIndex(message => message.id === options.currentUserMessageId && message.role === 'user');
    if (currentIndex < 0) throw new Error('Current user message was not found in context history.');
    const messages = chronological.slice(0, currentIndex + 1);
    const systemInstructions = DEFAULT_INSTRUCTIONS;
    const responsePreferences = options.responsePreferences?.trim() ?? '';
    const outputReserve = Math.min(options.model.maxOutputTokens, Math.max(1, options.reservedOutputTokens));
    const safetyReserve = Math.max(this.minSafety, Math.min(this.maxSafety, Math.ceil(options.model.contextWindow * this.safetyRatio)));
    const budget = options.model.contextWindow - outputReserve - safetyReserve;
    const turns = turnsOf(messages);
    const currentTurnIndex = turns.findIndex(turn => turn.some(message => message.id === options.currentUserMessageId));
    if (currentTurnIndex < 0) throw new Error('Current user message could not be grouped into a conversation turn.');
    const currentTurn = turns[currentTurnIndex]!;
    const allRows = [...currentTurn];
    const localCount = (rows: ContextMessage[]) => options.model.tokenizer === 'openai_o200k_base'
      ? exactLocal(rows, systemInstructions, responsePreferences)
      : approximate(rows, systemInstructions, responsePreferences);
    const getCount = async (rows: ContextMessage[]) => {
      if (options.countInputTokens && !options.signal.aborted) {
        try { return { value: await options.countInputTokens(rows.map(({ role, content }) => ({ role, content })), systemInstructions, responsePreferences, options.signal), method: 'provider_count_tokens', approximate: false }; }
        catch (error) { if (options.signal.aborted) throw error; }
      }
      return { value: localCount(rows), method: options.model.tokenizer === 'openai_o200k_base' ? 'o200k_base_plus_framing_estimate' : 'conservative_utf8_approximation', approximate: true };
    };
    let counted = await getCount(allRows);
    if (counted.value > budget) throw new ContextBudgetError();
    let omitted = messages.length - allRows.length;
    for (let i = currentTurnIndex - 1; i >= 0; i--) {
      const candidate = [...turns[i]!, ...allRows];
      const next = await getCount(candidate);
      if (next.value > budget) break;
      allRows.splice(0, allRows.length, ...candidate);
      counted = next;
      omitted = messages.length - allRows.length;
    }
    const diagnostics: ContextDiagnostics = {
      modelId: options.model.id, providerId: options.model.providerId,
      estimatedInputTokens: counted.value, tokenEstimateMethod: counted.method, tokenEstimateApproximate: counted.approximate,
      reservedOutputTokens: outputReserve, safetyReserveTokens: safetyReserve, effectiveContextBudget: budget,
      selectedMessageCount: allRows.length, omittedMessageCount: omitted, truncated: omitted > 0,
      truncationReason: omitted > 0 ? 'input_token_budget' : null, constructionDurationMs: Date.now() - started,
    };
    return { systemInstructions, responsePreferences, conversationSummary: null, savedMemories: [], messages: allRows, diagnostics };
  }
}
