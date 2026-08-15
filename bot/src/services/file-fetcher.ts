import { readFile } from 'node:fs/promises';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

interface GetFileResponse {
  ok: boolean;
  result?: { file_path?: string; file_size?: number };
  description?: string;
}

export async function fetchTelegramFile(fileId: string): Promise<Buffer> {
  const token = env.TELEGRAM_BOT_TOKEN;
  // If a local Bot API server is configured (TELEGRAM_API_ROOT set), all
  // requests — including getFile — go through it. Otherwise fall back to
  // the official api.telegram.org (20MB download limit).
  const apiBase = env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';

  const metaUrl = `${apiBase}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const metaRes = await fetch(metaUrl);
  const rawBody = await metaRes.text();
  let meta: GetFileResponse = {} as GetFileResponse;
  try {
    meta = JSON.parse(rawBody) as GetFileResponse;
  } catch {
    /* leave meta empty */
  }
  if (!metaRes.ok || !meta.ok) {
    const desc = meta.description ?? rawBody.slice(0, 200);
    logger.warn({ fileId, status: metaRes.status, desc }, 'telegram getFile failed');
    if (/file is too big/i.test(desc)) {
      throw new Error(
        'Файл больше 20 МБ — это лимит Telegram Bot API. Сохрани xlsx без картинок/служебных листов или разбей на 2 файла.',
      );
    }
    if (/wrong file_id|file_id_invalid|expired/i.test(desc)) {
      throw new Error(
        'Ссылка на файл устарела или повреждена. Пришли packing list ещё раз через /new.',
      );
    }
    throw new Error(`Telegram getFile отказал: ${desc}`);
  }
  if (!meta.result?.file_path) {
    throw new Error('Telegram вернул ответ без file_path. Попробуй заново /new.');
  }

  const rawPath = meta.result.file_path;

  // Local Bot API server (--local) returns absolute filesystem paths like
  // /var/lib/telegram-bot-api/<TOKEN>/documents/file_0.xlsx. When the bot is
  // in the same container (Dockerfile combines both processes), read directly
  // from disk — this is how the local Bot API server is designed to be used.
  if (rawPath.startsWith('/var/lib/telegram-bot-api/')) {
    try {
      const buf = await readFile(rawPath);
      logger.info({ fileId, bytes: buf.length, path: rawPath }, 'file read from local disk');
      return buf;
    } catch (err) {
      logger.warn({ err, rawPath }, 'local disk read failed, falling back to HTTP');
      // fall through to HTTP attempts below
    }
  }

  // HTTP path — used for cloud API (api.telegram.org) or as fallback.
  const botId = token.split(':')[0]!;
  const dataDir = '/var/lib/telegram-bot-api';
  const candidates = Array.from(
    new Set([
      `${apiBase}/file/bot${token}/${stripPrefix(rawPath, [
        `${dataDir}/${token}/`,
        `${dataDir}/${botId}/`,
        `${dataDir}/`,
      ])}`,
      `${apiBase}/file/bot${token}/${rawPath.replace(/^\/+/, '')}`,
      `${apiBase}/file/bot${token}${rawPath.startsWith('/') ? rawPath : '/' + rawPath}`,
    ]),
  );

  logger.info({ fileId, rawPath, apiBase, candidates }, 'attempting telegram file download (HTTP)');

  let lastError: { url: string; status: number; body: string } | null = null;
  for (const url of candidates) {
    const dlRes = await fetch(url);
    if (dlRes.ok) {
      const buf = Buffer.from(await dlRes.arrayBuffer());
      logger.info(
        { fileId, bytes: buf.length, urlUsed: url, rawPath },
        'telegram file downloaded via HTTP',
      );
      return buf;
    }
    const body = (await dlRes.text()).slice(0, 200);
    lastError = { url, status: dlRes.status, body };
    logger.warn({ url, status: dlRes.status, body }, 'download attempt failed, trying next URL');
  }
  throw new Error(
    `Telegram file download failed (${candidates.length} URLs tried). ` +
      `Last: HTTP ${lastError?.status} from ${lastError?.url} — ${lastError?.body}`,
  );
}

function stripPrefix(path: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (path.startsWith(p)) return path.slice(p.length);
  }
  return path.replace(/^\/+/, '');
}
