import { prisma, pool } from './db.js';
import { processOneSummaryJob } from './summary-worker.js';
import { SummaryService } from './summary-service.js';
import type { AIProvider } from './ai.js';
import type { ModelDefinition } from './model-registry.js';

const conversationId = process.env.SUMMARY_CRASH_CONVERSATION_ID;
if (!conversationId) throw new Error('Missing test conversation ID.');
const model: ModelDefinition = { id: 'test:summary', providerId: 'test', providerModelId: 'test-summary', displayName: 'Test summary', description: '', enabled: true, configured: true, capabilities: { streaming: true, nonStreaming: true, text: true }, contextWindow: 20_000, maxOutputTokens: 800, tokenizer: 'conservative_utf8_approximation', parameters: {} };
const provider: AIProvider = {
  id: 'test', async stream() { throw new Error('stream not used'); },
  async countInputTokens(request) { return Math.ceil(request.input[0]!.content.length / 4) + 20; },
  async generate() { process.stdout.write('SUMMARY_PROVIDER_BLOCKED\n'); return new Promise(() => {}); },
};
const service = new SummaryService(model, provider, 800);
await processOneSummaryJob({ prisma, pool, leaseSeconds: 0.25, timeoutMs: 120_000, serviceFactory: () => ({ model, provider, service }) });
