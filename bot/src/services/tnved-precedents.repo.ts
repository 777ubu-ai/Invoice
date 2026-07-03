import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// Precedent-based learning: whitelist of (client, product_name → tnved_code)
// pairs approved by the broker. Two write channels feed this:
//   1. Auto — every "Одобрить" click saves the invoice's items here.
//   2. Manual — the "📚 Образцы" flow bulk-uploads a known-good xlsx.
//
// The classifier reads from here before every LLM call: for each new item it
// runs a pg_trgm fuzzy search within the client scope and, on a match, feeds
// the LLM a "this product was previously classified as X" hint. In the final
// xlsx we colour-code the code cell:
//   • green  — high-confidence match (repeat product, verified ≥N times)
//   • yellow — similar product (fuzzy match, same product family)
//   • white  — brand-new product, no precedent
// =============================================================================

export interface PrecedentRow {
  id: string;
  client_name: string;
  product_name: string;
  product_name_normalized: string;
  tnved_code: string;
  tnved_description: string | null;
  duty_rate: number | null;
  usage_count: number;
  first_seen_invoice_id: string | null;
  last_used_invoice_id: string | null;
  approved_by: string | null;
  source: 'auto' | 'manual';
  first_seen_at: string;
  last_used_at: string;
}

export interface PrecedentMatch {
  code: string;
  description: string | null;
  duty_rate: number | null;
  similarity: number;
  usage_count: number;
  matched_product_name: string;
  last_used_at: string;
}

// Normalizes a product name for fuzzy comparison: lowercased, punctuation and
// extra whitespace stripped. Two products that differ only in punctuation or
// case must hash to the same normalized form so exact-match precedents fire.
export function normalizeProductName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[«»"'`()[\]{}]/g, ' ')
    .replace(/[.,;:!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface UpsertPrecedentInput {
  client_name: string;
  product_name: string;
  tnved_code: string;
  tnved_description?: string | null;
  duty_rate?: number | null;
  invoice_id?: string | null;
  approved_by?: string | null;
  source?: 'auto' | 'manual';
}

// Upsert one precedent. On conflict (same client + normalized name + code)
// bumps usage_count and updates last_used_* — otherwise inserts new row.
export async function upsertPrecedent(input: UpsertPrecedentInput): Promise<void> {
  const normalized = normalizeProductName(input.product_name);
  if (!normalized || !input.tnved_code) return;

  // Upsert via RPC-style: use INSERT ... ON CONFLICT. Supabase-js doesn't
  // expose ON CONFLICT UPDATE with expressions, so we do read-then-write.
  const { data: existing, error: selErr } = await supabase
    .from('tnved_precedents')
    .select('id, usage_count')
    .eq('client_name', input.client_name)
    .eq('product_name_normalized', normalized)
    .eq('tnved_code', input.tnved_code)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const { error } = await supabase
      .from('tnved_precedents')
      .update({
        usage_count: existing.usage_count + 1,
        last_used_at: new Date().toISOString(),
        last_used_invoice_id: input.invoice_id ?? null,
      })
      .eq('id', existing.id);
    if (error) throw error;
    return;
  }

  const { error: insErr } = await supabase.from('tnved_precedents').insert({
    client_name: input.client_name,
    product_name: input.product_name,
    product_name_normalized: normalized,
    tnved_code: input.tnved_code,
    tnved_description: input.tnved_description ?? null,
    duty_rate: input.duty_rate ?? null,
    first_seen_invoice_id: input.invoice_id ?? null,
    last_used_invoice_id: input.invoice_id ?? null,
    approved_by: input.approved_by ?? null,
    source: input.source ?? 'auto',
    usage_count: 1,
  });
  if (insErr) throw insErr;
}

// Batch upsert — used both by the approve handler and the bulk uploader.
// Errors on individual rows are logged but don't abort the batch: an unparseable
// row must not stop the rest.
export async function upsertPrecedentsBatch(rows: UpsertPrecedentInput[]): Promise<{
  saved: number;
  failed: number;
}> {
  let saved = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await upsertPrecedent(row);
      saved += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, product: row.product_name, code: row.tnved_code }, 'precedent upsert failed');
    }
  }
  return { saved, failed };
}

// Fuzzy-search precedents for one product name within a client. Uses pg_trgm
// similarity() over product_name_normalized. Returns up to `limit` matches
// sorted by (similarity DESC, usage_count DESC).
//
// Threshold guide:
//   0.85+  practically the same product (typos, whitespace, minor SKU diff)
//   0.60+  same product family (Холодильник BCD-620 vs Холодильник BC-105)
//   <0.60  probably unrelated
export async function findSimilarPrecedents(
  clientName: string,
  productName: string,
  opts: { limit?: number; minSimilarity?: number } = {},
): Promise<PrecedentMatch[]> {
  const normalized = normalizeProductName(productName);
  if (!normalized) return [];
  const limit = opts.limit ?? 5;
  const minSimilarity = opts.minSimilarity ?? 0.35;

  // pg_trgm similarity via raw SQL through supabase rpc? supabase-js doesn't
  // support that cleanly — but we can filter with .textSearch or use a lax
  // client-side match. Cleanest: use `.rpc()` with a small SQL function.
  // For now: pull recent precedents for the client, score in-process.
  // At <10 000 rows per client this is fine; if it ever grows, switch to RPC.
  const { data, error } = await supabase
    .from('tnved_precedents')
    .select(
      'tnved_code, tnved_description, duty_rate, usage_count, product_name, product_name_normalized, last_used_at',
    )
    .eq('client_name', clientName)
    .order('last_used_at', { ascending: false })
    .limit(2000);
  if (error) throw error;

  const scored = (data ?? [])
    .map((row) => ({
      code: row.tnved_code as string,
      description: (row.tnved_description as string | null) ?? null,
      duty_rate: row.duty_rate == null ? null : Number(row.duty_rate),
      similarity: trigramSimilarity(normalized, row.product_name_normalized as string),
      usage_count: row.usage_count as number,
      matched_product_name: row.product_name as string,
      last_used_at: row.last_used_at as string,
    }))
    .filter((m) => m.similarity >= minSimilarity)
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return b.usage_count - a.usage_count;
    })
    .slice(0, limit);

  return scored;
}

// Lightweight in-process trigram similarity — matches pg_trgm's algorithm
// closely enough for the ranking we need here (Jaccard on trigram sets with
// padded space at both ends of each token).
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const padded = `  ${s}  `;
  for (let i = 0; i <= padded.length - 3; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}
function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect += 1;
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// Aggregate stats for the "Образцы" menu.
export async function getPrecedentStats(clientName: string | null): Promise<{
  total: number;
  distinct_codes: number;
  top_codes: Array<{ code: string; description: string | null; usage_count: number }>;
}> {
  let q = supabase.from('tnved_precedents').select('tnved_code, tnved_description, usage_count');
  if (clientName) q = q.eq('client_name', clientName);
  const { data, error } = await q;
  if (error) throw error;

  const total = data?.length ?? 0;
  const codeAgg = new Map<string, { desc: string | null; count: number }>();
  for (const r of data ?? []) {
    const code = r.tnved_code as string;
    const usage = r.usage_count as number;
    const desc = (r.tnved_description as string | null) ?? null;
    const cur = codeAgg.get(code);
    if (cur) cur.count += usage;
    else codeAgg.set(code, { desc, count: usage });
  }
  const top_codes = Array.from(codeAgg.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([code, v]) => ({ code, description: v.desc, usage_count: v.count }));

  return { total, distinct_codes: codeAgg.size, top_codes };
}

export async function deletePrecedentsByCode(clientName: string, code: string): Promise<number> {
  const { error, count } = await supabase
    .from('tnved_precedents')
    .delete({ count: 'exact' })
    .eq('client_name', clientName)
    .eq('tnved_code', code);
  if (error) throw error;
  return count ?? 0;
}
