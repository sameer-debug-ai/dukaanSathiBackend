import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1).default('memory'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().default('claude-haiku-5-5'),
  // Speech-to-text fallback (Whisper-compatible API). "none" turns it off.
  STT_PROVIDER: z.enum(['none', 'openai', 'groq', 'whisper']).default('none'),
  STT_API_KEY: z.string().optional().default(''),
  STT_BASE_URL: z.string().optional().default(''),
  STT_MODEL: z.string().optional().default(''),
  // Daily "Aaj ke reminders" job (cron syntax, Asia/Kolkata). Empty turns it off.
  REMINDER_CRON: z.string().default('0 9 * * *'),
  CLIENT_URL: z.string().default('http://localhost:4200'),
  AUTO_SEED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  clientOrigins: parsed.data.CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean),
};

export type Env = typeof env;
