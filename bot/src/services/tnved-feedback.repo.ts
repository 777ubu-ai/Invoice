import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';

// Накопительная база отзывов на коды ТН ВЭД. Заполняется кнопками в боте:
//   ✅ Подтвердить код  → verdict='good'
//   🚩 Сообщить ошибку  → verdict='bad' (опционально с правильной альтернативой)
// Маке использует её для блэклиста: если код помечен 'bad' >=2 раза с разными
// инвойсами — не предлагать его повторно, флагать с предупреждением.

export interface FeedbackInput {
  code: string;
  verdict: 'good' | 'bad';
  context?: string;
  invoiceId?: string;
  itemIndex?: number;
  reportedById?: string;
  suggestedCode?: string;
}

export async function recordFeedback(input: FeedbackInput): Promise<void> {
  const { error } = await supabase.from('tnved_feedback').insert({
    code: input.code,
    verdict: input.verdict,
    context: input.context ?? null,
    invoice_id: input.invoiceId ?? null,
    item_index: input.itemIndex ?? null,
    reported_by: input.reportedById ?? null,
    suggested_code: input.suggestedCode ?? null,
  });
  if (error) {
    logger.error({ err: error, input }, 'failed to record tnved feedback');
    throw error;
  }
}

export interface CodeStats {
  good: number;
  bad: number;
  suggested_alternatives: string[];
}

// Aggregated counts per code — used by Маке to decide if a code should be
// flagged as suspect, blocked, or whitelisted.
export async function loadFeedbackStats(): Promise<Map<string, CodeStats>> {
  const { data, error } = await supabase
    .from('tnved_feedback')
    .select('code, verdict, suggested_code');
  if (error) {
    logger.error({ err: error }, 'failed to load tnved feedback');
    return new Map();
  }
  const map = new Map<string, CodeStats>();
  for (const row of data ?? []) {
    const entry = map.get(row.code) ?? { good: 0, bad: 0, suggested_alternatives: [] };
    if (row.verdict === 'good') entry.good += 1;
    if (row.verdict === 'bad') entry.bad += 1;
    if (row.suggested_code && !entry.suggested_alternatives.includes(row.suggested_code)) {
      entry.suggested_alternatives.push(row.suggested_code);
    }
    map.set(row.code, entry);
  }
  return map;
}

export function isLikelyBad(stats: CodeStats | undefined): boolean {
  if (!stats) return false;
  // Считаем «плохим» если жалоб >=2 и подтверждений нет / меньше жалоб.
  return stats.bad >= 2 && stats.bad > stats.good;
}

export function isConfirmedGood(stats: CodeStats | undefined): boolean {
  if (!stats) return false;
  return stats.good >= 1 && stats.good >= stats.bad;
}
