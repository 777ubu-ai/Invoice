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
  if (!metaRes.ok) {
    throw new Error(`Telegram getFile HTTP ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as GetFileResponse;
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${meta.description ?? 'no file_path'}`);
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
