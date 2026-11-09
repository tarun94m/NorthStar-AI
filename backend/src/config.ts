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
  OPENAI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0.4),
  OPENAI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(1.6),
  OPENAI_INPUT_USD_PER_MILLION_GPT_41: z.coerce.number().nonnegative().default(2),
  OPENAI_OUTPUT_USD_PER_MILLION_GPT_41: z.coerce.number().nonnegative().default(8),
  GEMINI_INPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(0.75),
  GEMINI_OUTPUT_USD_PER_MILLION: z.coerce.number().nonnegative().default(3.75),
  NODE_ENV: z.string().default('development'),
});

export const config = envSchema.parse(process.env);
