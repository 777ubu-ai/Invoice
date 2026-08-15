import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const DEFAULT_MAX_TELEGRAM_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ALLOWED_TELEGRAM_FILE_BYTES = 512 * 1024 * 1024;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  TELEGRAM_BOT_TOKEN: z.string().min(20, 'TELEGRAM_BOT_TOKEN is required'),

  // Опциональный URL локального Bot API сервера (telegram-bot-api / aiogram image).
  // Если задан — лимит на скачивание/загрузку файла становится 2 ГБ (вместо 20 МБ
  // у официального api.telegram.org). Пример: http://tg-bot-api.railway.internal:8081
  TELEGRAM_API_ROOT: z.string().url().optional(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(20),

  MAX_TELEGRAM_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_ALLOWED_TELEGRAM_FILE_BYTES)
    .default(DEFAULT_MAX_TELEGRAM_FILE_BYTES),

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

export function normalizeEnv(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...raw,
    // Backward compatibility for older Railway/self-host variables. New deploys
    // must set the canonical names used by the runtime and docs.
    SUPABASE_SERVICE_KEY: raw.SUPABASE_SERVICE_KEY ?? raw.SUPABASE_SERVICE_ROLE_KEY,
    INITIAL_OWNER_TG_USER_ID: raw.INITIAL_OWNER_TG_USER_ID ?? raw.OWNER_TELEGRAM_ID,
  };
}

export function loadAndValidate(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(normalizeEnv(raw));
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment variables:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env: Env = loadAndValidate();
