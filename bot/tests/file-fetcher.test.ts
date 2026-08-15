import { describe, expect, it } from 'vitest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  TELEGRAM_BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyz',
  SUPABASE_URL: 'http://postgrest:3000',
  SUPABASE_SERVICE_KEY: 'service-key-with-enough-length',
});

describe('telegram file logging safety', () => {
  it('redacts bot tokens from Telegram file URLs', async () => {
    const { redactTelegramFileUrl } = await import('../src/services/file-fetcher.js');
    const token = '1234567890:abcdefghijklmnopqrstuvwxyz';
    const url = `https://api.telegram.org/file/bot${token}/documents/file_0.xlsx`;

    const redacted = redactTelegramFileUrl(url);

    expect(redacted).not.toContain(token);
    expect(redacted).toBe('https://api.telegram.org/file/bot<redacted>/documents/file_0.xlsx');
  });

  it('redacts bot tokens from local Bot API paths', async () => {
    const { redactTelegramLocalPath } = await import('../src/services/file-fetcher.js');
    const token = '1234567890:abcdefghijklmnopqrstuvwxyz';
    const path = `/var/lib/telegram-bot-api/${token}/documents/file_0.xlsx`;

    const redacted = redactTelegramLocalPath(path, token);

    expect(redacted).not.toContain(token);
    expect(redacted).toBe('/var/lib/telegram-bot-api/<redacted>/documents/file_0.xlsx');
  });
});
