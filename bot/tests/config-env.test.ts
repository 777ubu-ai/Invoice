import { describe, expect, it } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  TELEGRAM_BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyz',
  SUPABASE_URL: 'http://postgrest:3000',
  SUPABASE_SERVICE_KEY: 'service-key-with-enough-length',
};

Object.assign(process.env, baseEnv);

describe('environment contract', () => {
  it('uses SUPABASE_SERVICE_KEY as the canonical service credential', async () => {
    const { loadAndValidate } = await import('../src/config/env.js');

    const env = loadAndValidate(baseEnv);

    expect(env.SUPABASE_SERVICE_KEY).toBe('service-key-with-enough-length');
  });

  it('keeps a backward-compatible fallback for old service-role env names', async () => {
    const { loadAndValidate } = await import('../src/config/env.js');

    const env = loadAndValidate({
      ...baseEnv,
      SUPABASE_SERVICE_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-with-enough-length',
    });

    expect(env.SUPABASE_SERVICE_KEY).toBe('legacy-service-role-key-with-enough-length');
  });

  it('uses INITIAL_OWNER_TG_USER_ID as the canonical owner bootstrap field', async () => {
    const { loadAndValidate } = await import('../src/config/env.js');

    const env = loadAndValidate({
      ...baseEnv,
      INITIAL_OWNER_TG_USER_ID: '123456789',
      OWNER_TELEGRAM_ID: '987654321',
    });

    expect(env.INITIAL_OWNER_TG_USER_ID).toBe(123456789);
  });

  it('keeps a backward-compatible owner fallback for old self-host env files', async () => {
    const { loadAndValidate } = await import('../src/config/env.js');

    const env = loadAndValidate({
      ...baseEnv,
      OWNER_TELEGRAM_ID: '987654321',
    });

    expect(env.INITIAL_OWNER_TG_USER_ID).toBe(987654321);
  });

  it('defaults to a bounded 100 MB Telegram file policy', async () => {
    const { loadAndValidate } = await import('../src/config/env.js');

    const env = loadAndValidate(baseEnv);

    expect(env.MAX_TELEGRAM_FILE_BYTES).toBe(100 * 1024 * 1024);
  });
});
