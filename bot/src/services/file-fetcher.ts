import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

interface GetFileResponse {
  ok: boolean;
  result?: { file_path?: string; file_size?: number };
  description?: string;
}

export async function fetchTelegramFile(fileId: string): Promise<Buffer> {
  const token = env.TELEGRAM_BOT_TOKEN;
  // Если поднят локальный Bot API сервер — все запросы идут на него и лимит
  // 20 МБ снимается. Иначе fallback на официальный api.telegram.org.
  const apiBase = env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';

  const metaUrl = `${apiBase}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const metaRes = await fetch(metaUrl);
  // Telegram returns 4xx with a JSON body that explains the real reason
  // ("file is too big", "wrong file_id", "file expired"). Surface it so the
  // operator sees the actual problem, not just "HTTP 400".
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

  // Path normalization for Local Bot API: --local mode returns an ABSOLUTE
  // filesystem path like "/var/lib/telegram-bot-api/<bot_id>/documents/file.xlsx",
  // but different aiogram image versions / configs expose different HTTP URL
  // shapes. Cloud API returns a relative path. To survive both, try several
  // candidate URLs and pick the first one that works.
  const rawPath = meta.result.file_path;
  const botId = token.split(':')[0]!;
  const candidates = Array.from(
    new Set([
      // Strip data-dir + bot-id prefix → leaves "documents/file.xlsx"
      `${apiBase}/file/bot${token}/${stripPrefix(rawPath, [`/var/lib/telegram-bot-api/${botId}/`, `/var/lib/telegram-bot-api/`])}`,
      // Strip only leading slashes
      `${apiBase}/file/bot${token}/${rawPath.replace(/^\/+/, '')}`,
      // Keep leading slash → "//var/lib/..."
      `${apiBase}/file/bot${token}${rawPath.startsWith('/') ? rawPath : '/' + rawPath}`,
    ]),
  );

  logger.info({ fileId, rawPath, apiBase, candidates }, 'attempting telegram file download');

  let lastError: { url: string; status: number; body: string } | null = null;
  for (const url of candidates) {
    const dlRes = await fetch(url);
    if (dlRes.ok) {
      const buf = Buffer.from(await dlRes.arrayBuffer());
      logger.info(
        { fileId, bytes: buf.length, urlUsed: url, rawPath },
        'telegram file downloaded',
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
