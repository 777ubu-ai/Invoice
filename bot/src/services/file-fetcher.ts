import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

interface GetFileResponse {
  ok: boolean;
  result?: { file_path?: string; file_size?: number };
  description?: string;
}

export async function fetchTelegramFile(fileId: string): Promise<Buffer> {
  const token = env.TELEGRAM_BOT_TOKEN;

  const metaUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
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

  const dlUrl = `https://api.telegram.org/file/bot${token}/${meta.result.file_path}`;
  const dlRes = await fetch(dlUrl);
  if (!dlRes.ok) {
    throw new Error(`Telegram file download HTTP ${dlRes.status}`);
  }
  const buf = Buffer.from(await dlRes.arrayBuffer());
  logger.info(
    { fileId, bytes: buf.length, path: meta.result.file_path },
    'telegram file downloaded',
  );
  return buf;
}
