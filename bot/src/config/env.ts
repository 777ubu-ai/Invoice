import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  TELEGRAM_BOT_TOKEN: z.string().min(20, 'TELEGRAM_BOT_TOKEN is required'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(20),

  TNVED_API_URL: z.string().url().default('http://localhost:3001'),
  TNVED_API_KEY: z.string().default('dev-secret'),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  ANTHROPIC_API_KEY: z.string().optional(),

  CALLBACK_HMAC_SECRET: z.string().min(16).default('dev-only-callback-secret-change-me'),

  INITIAL_OWNER_TG_USER_ID: z.coerce.number().int().positive().optional(),
  INITIAL_OWNER_USERNAME: z.string().optional(),
  INITIAL_OWNER_NAME: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

function loadAndValidate(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment variables:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env: Env = loadAndValidate();
