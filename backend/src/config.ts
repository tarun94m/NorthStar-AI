import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  OPENAI_API_KEY: z.string().optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  PORT: z.coerce.number().default(3001),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  GUEST_DAILY_MESSAGE_LIMIT: z.coerce.number().int().positive().default(12),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1200),
  MOCK_STREAM_DELAY_MS: z.coerce.number().nonnegative().default(18),
  PROVIDER_TIMEOUT_MS: z.coerce.number().positive().default(60000),
  AUTO_ROUTING_POLICY_VERSION: z.string().min(1).max(40).default('auto-v1'),
  AUTO_MODEL_PREFERENCE: z.string().default('openai:gpt-4.1-mini,openai:gpt-4.1,gemini:gemini-3.8-flash'),
  AUTO_MAX_FALLBACK_ATTEMPTS: z.coerce.number().int().min(0).max(4).default(2),
  SUMMARY_MODEL_ID: z.string().min(1).default('openai:gpt-4.1-mini'),
  SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(4096).default(1200),
  SUMMARY_TRIGGER_RATIO: z.coerce.number().min(0.3).max(0.95).default(0.72),
  SUMMARY_RECENT_TURNS: z.coerce.number().int().positive().max(20).default(4),
  SUMMARY_JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(90),
  SUMMARY_WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  USAGE_OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),
  MEMORY_SUGGESTION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  MEMORY_SUGGESTION_MIN_USEFULNESS: z.coerce.number().min(0).max(1).default(0.7),
  MEMORY_SUGGESTION_MAX_PER_HOUR: z.coerce.number().int().positive().max(20).default(3),
  MEMORY_SUGGESTION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(168),
  MEMORY_RETRIEVAL_TOP_K: z.coerce.number().int().positive().max(10).default(5),
  MEMORY_RETRIEVAL_MAX_TOKENS: z.coerce.number().int().positive().max(2000).default(500),
  MEMORY_MAX_PER_MEMORY_TOKENS: z.coerce.number().int().positive().max(512).default(128),
  MEMORY_RETRIEVAL_MIN_RANK: z.coerce.number().min(0).max(1).default(0.04),
  MOCK_PROVIDER_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  MEMORY_EXPIRY_POLL_MS: z.coerce.number().int().positive().default(60_000),
  // Set PRICING_EFFECTIVE_AT when deploying a known pricing schedule. If omitted,
  // the process records when this configured snapshot was loaded.
  PRICING_EFFECTIVE_AT: z.string().datetime({ offset: true }).optional(),
  OPENAI_PRICING_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  OPENAI_PRICING_VERSION: z.string().trim().min(1).max(48).default('openai-config-v1'),
  OPENAI_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional(),
  OPENAI_OUTPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional(),
  OPENAI_GPT_41_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional(),
  OPENAI_GPT_41_OUTPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional(),
  GEMINI_PRICING_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  GEMINI_PRICING_VERSION: z.string().trim().min(1).max(48).default('gemini-config-v1'),
  GEMINI_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional(),
  GEMINI_OUTPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().optional(),
  OPENAI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0.4),
  OPENAI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(1.6),
  OPENAI_INPUT_USD_PER_MILLION_GPT_41: z.coerce.number().nonnegative().default(2),
  OPENAI_OUTPUT_USD_PER_MILLION_GPT_41: z.coerce.number().nonnegative().default(8),
  GEMINI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0.75),
  GEMINI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(3.75),
  NODE_ENV: z.string().default('development'),
});

const parsed = envSchema.parse(process.env);
if (parsed.OPENAI_PRICING_CURRENCY !== 'USD' && [parsed.OPENAI_INPUT_PRICE_PER_MILLION, parsed.OPENAI_OUTPUT_PRICE_PER_MILLION, parsed.OPENAI_GPT_41_INPUT_PRICE_PER_MILLION, parsed.OPENAI_GPT_41_OUTPUT_PRICE_PER_MILLION].some(value => value === undefined)) {
  throw new Error('Non-USD OpenAI pricing requires all four OPENAI_*_PRICE_PER_MILLION values.');
}
if (parsed.GEMINI_PRICING_CURRENCY !== 'USD' && [parsed.GEMINI_INPUT_PRICE_PER_MILLION, parsed.GEMINI_OUTPUT_PRICE_PER_MILLION].some(value => value === undefined)) {
  throw new Error('Non-USD Gemini pricing requires GEMINI_INPUT_PRICE_PER_MILLION and GEMINI_OUTPUT_PRICE_PER_MILLION.');
}
if (parsed.MOCK_PROVIDER_ENABLED && !['development', 'test'].includes(parsed.NODE_ENV)) {
  throw new Error('MOCK_PROVIDER_ENABLED may only be true in development or test environments.');
}
export const config = { ...parsed, PRICING_EFFECTIVE_AT: parsed.PRICING_EFFECTIVE_AT ?? new Date().toISOString() };
