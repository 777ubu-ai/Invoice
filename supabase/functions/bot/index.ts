// TNVED.ai Telegram bot — Supabase Edge Function (webhook mode).
//
// Webhook URL pattern:
//   https://<project>.supabase.co/functions/v1/bot/<TELEGRAM_BOT_TOKEN>

import { Bot, Context, InlineKeyboard, webhookCallback } from 'grammy';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Role = 'OWNER' | 'MANAGER' | 'OPERATOR';
type PriceMode = 'TARGET_PAYMENTS' | 'PRICE_PER_KG' | 'CLIENT_PRICELIST' | 'KGD_INDICATIVE';

interface TgUser {
  id: string;
  telegram_user_id: number | null;
  telegram_username: string | null;
  full_name: string;
  role: Role;
  team_name: string | null;
  manager_id: string | null;
  client_access: string[];
  is_active: boolean;
  invoices_total: number;
  invoices_this_month: number;
  avg_confidence: number | null;
}

interface BotCtx extends Context {
  dbUser?: TgUser;
}

interface SessionState {
  state: string;
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// User repo
// ---------------------------------------------------------------------------

async function findUser(tgId: number): Promise<TgUser | null> {
  const { data } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('telegram_user_id', tgId)
    .eq('is_active', true)
    .maybeSingle();
  return (data as TgUser | null) ?? null;
}

async function findUserByUsername(username: string): Promise<TgUser | null> {
  const n = username.replace(/^@/, '').toLowerCase();
  const { data } = await supabase
    .from('telegram_users')
    .select('*')
    .ilike('telegram_username', n)
    .maybeSingle();
  return (data as TgUser | null) ?? null;
}

async function listOperators(managerId: string): Promise<TgUser[]> {
  const { data } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('manager_id', managerId)
    .eq('is_active', true)
    .order('full_name');
  return (data ?? []) as TgUser[];
}

async function listAllUsers(): Promise<TgUser[]> {
  const { data } = await supabase
    .from('telegram_users')
    .select('*')
    .order('role')
    .order('full_name');
  return (data ?? []) as TgUser[];
}

async function bindTelegramId(userId: string, tgId: number) {
  await supabase
    .from('telegram_users')
    .update({ telegram_user_id: tgId, last_active: new Date().toISOString() })
    .eq('id', userId);
}

async function touchUser(userId: string) {
  await supabase
    .from('telegram_users')
    .update({ last_active: new Date().toISOString() })
    .eq('id', userId);
}

interface CreateUserInput {
  telegram_username: string;
  full_name: string;
  role: Role;
  team_name?: string | null;
  manager_id?: string | null;
  client_access?: string[];
  added_by?: string | null;
}

async function createUser(input: CreateUserInput): Promise<TgUser> {
  const { data, error } = await supabase
    .from('telegram_users')
    .insert({
      telegram_username: input.telegram_username.replace(/^@/, '').toLowerCase(),
      full_name: input.full_name,
      role: input.role,
      team_name: input.team_name ?? null,
      manager_id: input.manager_id ?? null,
      client_access: input.client_access ?? [],
      added_by: input.added_by ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as TgUser;
}

async function deactivateUser(userId: string) {
  await supabase.from('telegram_users').update({ is_active: false }).eq('id', userId);
}

interface AuditInput {
  actor_user_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  payload?: Record<string, unknown> | null;
}

async function audit(e: AuditInput) {
  await supabase.from('audit_log').insert({
    actor_user_id: e.actor_user_id ?? null,
    action: e.action,
    target_type: e.target_type ?? null,
    target_id: e.target_id ?? null,
    payload: e.payload ?? null,
  });
}

// ---------------------------------------------------------------------------
// Session repo (FSM state across stateless invocations)
// ---------------------------------------------------------------------------

async function getSession(tgId: number): Promise<SessionState> {
  const { data } = await supabase
    .from('bot_session')
    .select('state, context')
    .eq('telegram_user_id', tgId)
    .maybeSingle();
  return data ?? { state: 'idle', context: {} };
}

async function setSession(
  tgId: number,
  state: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  await supabase.from('bot_session').upsert({
    telegram_user_id: tgId,
    state,
    context,
    updated_at: new Date().toISOString(),
  });
}

async function clearSession(tgId: number): Promise<void> {
  await supabase.from('bot_session').delete().eq('telegram_user_id', tgId);
}

// ---------------------------------------------------------------------------
// Invoice + canned classification (Sprint 2 mock)
// ---------------------------------------------------------------------------

interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  client_name: string;
  status: string;
  assigned_to: string | null;
  updated_at: string;
  summary?: InvoiceSummary | null;
  items?: InvoiceItem[] | null;
  price_mode?: PriceMode | null;
  price_value?: number | null;
}

interface InvoiceItem {
  index: number;
  article: string;
  text_original: string;
  text_translated: string;
  quantity: number;
  gross_kg: number;
  net_kg: number;
  tnved_code: string;
  tnved_description: string;
  duty_rate: number;
  confidence: number;
  needs_review: boolean;
  review_reason?: string;
  alternatives?: { code: string; description: string }[];
}

interface InvoiceSummary {
  items_count: number;
  codes_count: number;
  gross_kg: number;
  net_kg: number;
  units_total: number;
  cost_usd: number;
  duty_usd: number;
  vat_usd: number;
  fee_usd: number;
  total_payments_usd: number;
  target_usd?: number;
}

const CLIENTS = ['LINEA TRANSIT', 'ТОО Альфа'];

function cannedItems(): InvoiceItem[] {
  const base: Omit<InvoiceItem, 'index'>[] = [
    {
      article: 'WC-101',
      text_original: '陶瓷座便器 WC-101',
      text_translated: 'Унитаз фарфоровый',
      quantity: 120,
      gross_kg: 7200,
      net_kg: 6840,
      tnved_code: '6910100000',
      tnved_description: 'Сантехника фарфоровая',
      duty_rate: 12,
      confidence: 96,
      needs_review: false,
    },
    {
      article: 'SH-205',
      text_original: '不锈钢淋浴头 SH-205',
      text_translated: 'Лейка душевая из нержавеющей стали',
      quantity: 3400,
      gross_kg: 4080,
      net_kg: 3876,
      tnved_code: '7324900000',
      tnved_description: 'Сантехника из чёрных металлов',
      duty_rate: 10,
      confidence: 92,
      needs_review: false,
    },
    {
      article: 'PP-3-32',
      text_original: 'PP管件 32mm',
      text_translated: 'Фитинги PP 32мм',
      quantity: 85000,
      gross_kg: 8500,
      net_kg: 8075,
      tnved_code: '3917400000',
      tnved_description: 'Фитинги пластиковые',
      duty_rate: 6.5,
      confidence: 94,
      needs_review: false,
    },
    {
      article: 'BV-1/2',
      text_original: '黄铜球阀 1/2',
      text_translated: 'Шаровой кран латунный 1/2"',
      quantity: 2200,
      gross_kg: 1980,
      net_kg: 1881,
      tnved_code: '8481808199',
      tnved_description: 'Краны латунные',
      duty_rate: 5,
      confidence: 89,
      needs_review: false,
    },
    {
      article: 'EL-90',
      text_original: '钢制弯头 90度',
      text_translated: 'Отвод стальной 90°',
      quantity: 8500,
      gross_kg: 7650,
      net_kg: 7267,
      tnved_code: '7307990000',
      tnved_description: 'Прочие фитинги из чёрных металлов',
      duty_rate: 5,
      confidence: 91,
      needs_review: false,
    },
    {
      article: 'K48-12',
      text_original: '金属配件 K48',
      text_translated: 'Металлические фитинги K48',
      quantity: 1920,
      gross_kg: 384,
      net_kg: 365,
      tnved_code: '7412200000',
      tnved_description: 'Фитинги для труб из медных сплавов',
      duty_rate: 3,
      confidence: 65,
      needs_review: true,
      review_reason: 'Низкая уверенность модели',
      alternatives: [
        { code: '7412200000', description: 'Фитинги из медных сплавов' },
        { code: '7415310000', description: 'Гайки, шурупы из меди' },
        { code: '8481808199', description: 'Краны латунные' },
      ],
    },
    {
      article: 'M58-XX',
      text_original: '配件 M58',
      text_translated: 'Фитинг M58',
      quantity: 1230,
      gross_kg: 1386,
      net_kg: 1317,
      tnved_code: '7307990000',
      tnved_description: 'Прочие фитинги из чёрных металлов',
      duty_rate: 5,
      confidence: 72,
      needs_review: true,
      review_reason: 'Фото нечёткое',
      alternatives: [
        { code: '7307990000', description: 'Прочие фитинги из чёрных металлов' },
        { code: '7412200000', description: 'Фитинги из медных сплавов' },
      ],
    },
  ];
  return base.map((it, idx) => ({ ...it, index: idx + 1 }));
}

const TNVED_LOOKUP: Record<string, { description: string; duty_rate: number }> = {
  '7412200000': { description: 'Фитинги для труб из медных сплавов', duty_rate: 3 },
  '7415310000': { description: 'Гайки, шурупы из меди', duty_rate: 5 },
  '8481808199': { description: 'Краны латунные', duty_rate: 5 },
  '3917400000': { description: 'Фитинги пластиковые', duty_rate: 6.5 },
  '7307990000': { description: 'Прочие фитинги из чёрных металлов', duty_rate: 5 },
  '6910100000': { description: 'Сантехника фарфоровая', duty_rate: 12 },
  '7324900000': { description: 'Сантехника из чёрных металлов', duty_rate: 10 },
};

function computeSummary(items: InvoiceItem[], mode: PriceMode, value?: number): InvoiceSummary {
  const gross = items.reduce((s, i) => s + i.gross_kg, 0);
  const net = items.reduce((s, i) => s + i.net_kg, 0);
  let cost: number;
  if (mode === 'TARGET_PAYMENTS' && value) {
    const avgDuty = 0.066;
    const vatRate = 0.16;
    const fee = 46;
    const denom = avgDuty + vatRate * (1 + avgDuty);
    cost = Math.round((value - fee) / denom);
  } else if (mode === 'PRICE_PER_KG' && value) {
    cost = Math.round(net * value);
  } else {
    cost = 20875;
  }
  const duty = Math.round(
    items.reduce((s, i) => s + ((cost * i.gross_kg) / gross) * (i.duty_rate / 100), 0),
  );
  const vat = Math.round((cost + duty) * 0.16);
  const fee = 46;
  const total = duty + vat + fee;
  return {
    items_count: 67,
    codes_count: new Set(items.map((i) => i.tnved_code)).size,
    gross_kg: 31176,
    net_kg: 29618,
    units_total: 213670,
    cost_usd: cost,
    duty_usd: duty,
    vat_usd: vat,
    fee_usd: fee,
    total_payments_usd: total,
    target_usd: mode === 'TARGET_PAYMENTS' ? value : undefined,
  };
}

async function generateInvoiceNumber(): Promise<string> {
  const { count } = await supabase.from('invoices').select('id', { count: 'exact', head: true });
  const seq = String((count ?? 0) + 1).padStart(4, '0');
  return `2026-C351-${seq}`;
}

async function loadInvoice(invoiceId: string): Promise<InvoiceRow | null> {
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_number, client_name, status, assigned_to, updated_at, summary, items, price_mode, price_value')
    .eq('id', invoiceId)
    .maybeSingle();
  return (data as InvoiceRow | null) ?? null;
}

async function listActiveAssigned(userId: string): Promise<InvoiceRow[]> {
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_number, client_name, status, assigned_to, updated_at')
    .eq('assigned_to', userId)
    .in('status', ['UPLOADED', 'PROCESSING', 'REVIEW', 'FAILED'])
    .order('created_at', { ascending: false })
    .limit(20);
  return (data ?? []) as InvoiceRow[];
}

async function listHistoryAssigned(userId: string): Promise<InvoiceRow[]> {
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_number, client_name, status, assigned_to, updated_at')
    .eq('assigned_to', userId)
    .in('status', ['APPROVED', 'CANCELED'])
    .order('updated_at', { ascending: false })
    .limit(20);
  return (data ?? []) as InvoiceRow[];
}

async function listTeamInvoices(managerId: string): Promise<InvoiceRow[]> {
  const team = await listOperators(managerId);
  if (team.length === 0) return [];
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_number, client_name, status, assigned_to, updated_at')
    .in('assigned_to', team.map((t) => t.id))
    .in('status', ['UPLOADED', 'PROCESSING', 'REVIEW', 'FAILED'])
    .order('created_at', { ascending: false })
    .limit(50);
  return (data ?? []) as InvoiceRow[];
}

async function listAllInvoices(): Promise<InvoiceRow[]> {
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_number, client_name, status, assigned_to, updated_at')
    .order('created_at', { ascending: false })
    .limit(30);
  return (data ?? []) as InvoiceRow[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const ROLE_TITLE: Record<Role, string> = {
  OWNER: '👑 OWNER',
  MANAGER: '🎯 MANAGER',
  OPERATOR: '👤 OPERATOR',
};

const STATUS_RU: Record<string, string> = {
  CREATED: '🆕 создан',
  UPLOADED: '📥 загружен',
  PROCESSING: '⏳ классификация',
  REVIEW: '🔍 на ревью',
  APPROVED: '✅ одобрен',
  FAILED: '❌ ошибка',
  CANCELED: '🚫 отменён',
};

const RU_NF = new Intl.NumberFormat('ru-RU');
const fmt = (n: number | null | undefined) => (n == null ? '—' : RU_NF.format(Math.round(n)));

function invoiceShort(inv: InvoiceRow): string {
  const num = inv.invoice_number ?? inv.id.slice(0, 8);
  return `• #${num} ${inv.client_name} — ${STATUS_RU[inv.status] ?? inv.status}`;
}

function summaryText(inv: InvoiceRow): string {
  const s = inv.summary;
  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`📊 Инвойс #${inv.invoice_number ?? inv.id.slice(0, 8)}`);
  lines.push(`Клиент: ${inv.client_name}`);
  if (s) {
    lines.push(`Позиций: ${s.items_count} → ${s.codes_count} кодов ТН ВЭД`);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Брутто: ${fmt(s.gross_kg)} кг → Нетто: ${fmt(s.net_kg)} кг`);
    lines.push(`Стоимость: $${fmt(s.cost_usd)}`);
    lines.push(`Пошлина: $${fmt(s.duty_usd)}`);
    lines.push(`НДС 16%: $${fmt(s.vat_usd)}`);
    lines.push(`Сбор: $${fmt(s.fee_usd)}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    const target = s.target_usd
      ? `ВСЕГО ПЛАТЕЖЕЙ: $${fmt(s.total_payments_usd)} (цель $${fmt(s.target_usd)}) ✓`
      : `ВСЕГО ПЛАТЕЖЕЙ: $${fmt(s.total_payments_usd)}`;
    lines.push(target);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
  }
  const review = (inv.items ?? []).filter((i) => i.needs_review);
  if (review.length > 0) {
    lines.push(`⚠️ ${review.length} позиций требуют ревью:`);
    for (const it of review) {
      lines.push(`  • #${it.index}: «${it.text_original}» (уверенность ${it.confidence}%)`);
    }
  }
  return lines.join('\n');
}

function reviewKeyboard(inv: InvoiceRow): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const it of (inv.items ?? []).filter((i) => i.needs_review)) {
    kb.text(`👁 Посмотреть #${it.index}`, `inv:item:${inv.id}:${it.index}`).row();
  }
  kb.text('✅ Одобрить', `inv:approve:${inv.id}`).text('❌ Отменить', `inv:cancel:${inv.id}`);
  return kb;
}

function itemKeyboard(invoiceId: string, item: InvoiceItem): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(`✅ Оставить ${item.tnved_code}`, `inv:keep:${invoiceId}:${item.index}`).row();
  let i = 1;
  for (const alt of item.alternatives ?? []) {
    if (alt.code === item.tnved_code) continue;
    kb.text(`Выбрать ${alt.code}`, `inv:pick:${invoiceId}:${item.index}:${alt.code}`).row();
    if (++i > 4) break;
  }
  kb.text('🔙 К инвойсу', `inv:back:${invoiceId}`);
  return kb;
}

function mainMenu(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('📤 Новый инвойс', 'menu:new')
    .row()
    .text('📋 Мои задачи', 'menu:list')
    .text('📜 История', 'menu:history')
    .row()
    .text('👥 Мои клиенты', 'menu:clients');
  if (role === 'MANAGER' || role === 'OWNER') {
    kb.row().text('👥 Команда', 'menu:team').text('📊 Стата', 'menu:teamstats');
  }
  if (role === 'OWNER') {
    kb.row().text('🛠 Админ', 'menu:admin');
  }
  return kb;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

async function attachUser(ctx: BotCtx) {
  const from = ctx.from;
  if (!from) return;
  const user = await findUser(from.id);
  if (user) {
    ctx.dbUser = user;
    touchUser(user.id).catch(() => {});
  }
}

function requireRole(ctx: BotCtx, ...allowed: Role[]): boolean {
  if (!ctx.dbUser) return false;
  return allowed.includes(ctx.dbUser.role);
}

// ---------------------------------------------------------------------------
// /new flow
// ---------------------------------------------------------------------------

async function startNewInvoice(ctx: BotCtx): Promise<void> {
  if (!ctx.dbUser || !ctx.from) return;
  const user = ctx.dbUser;
  const clients = user.client_access.includes('*') ? CLIENTS : user.client_access;
  if (clients.length === 0) {
    await ctx.reply('⚠️ Тебе не назначен ни один клиент. Попроси руководителя.');
    return;
  }
  const kb = new InlineKeyboard();
  for (const c of clients) kb.text(c, `new:client:${encodeURIComponent(c)}`).row();
  kb.text('❌ Отменить', 'new:cancel');
  await setSession(ctx.from.id, 'new:client', {});
  await ctx.reply('Выбери клиента:', { reply_markup: kb });
}

async function handleClientPicked(ctx: BotCtx, clientName: string): Promise<void> {
  if (!ctx.dbUser || !ctx.from) return;
  const invoiceNumber = await generateInvoiceNumber();
  const { data, error } = await supabase
    .from('invoices')
    .insert({
      invoice_number: invoiceNumber,
      client_name: clientName,
      status: 'UPLOADED',
      created_by: ctx.dbUser.id,
      assigned_to: ctx.dbUser.id,
      telegram_chat_id: ctx.chat?.id ?? null,
    })
    .select('id, invoice_number')
    .single();
  if (error) {
    await ctx.reply('Не удалось создать инвойс.');
    return;
  }
  await setSession(ctx.from.id, 'new:file', {
    invoice_id: data.id,
    invoice_number: data.invoice_number,
    client_name: clientName,
  });
  await audit({
    actor_user_id: ctx.dbUser.id,
    action: 'INVOICE_CREATED',
    target_type: 'invoice',
    target_id: data.id,
    payload: { client: clientName, source: 'edge_function' },
  });
  await ctx.reply(`Клиент: ${clientName}\n\nОтправь packing list (xlsx, pdf или фото).`);
}

async function handleFileUpload(
  ctx: BotCtx,
  session: SessionState,
  fileRef: string,
  fileName: string,
): Promise<void> {
  if (!ctx.from) return;
  const invoiceId = session.context.invoice_id as string;
  await supabase.from('invoices').update({ source_file_url: `tg:${fileRef}` }).eq('id', invoiceId);
  await setSession(ctx.from.id, 'new:mode', {
    ...session.context,
    file_ref: fileRef,
    file_name: fileName,
  });
  const kb = new InlineKeyboard()
    .text('💰 Целевые платежи $', `new:mode:${invoiceId}:TARGET_PAYMENTS`)
    .text('⚖️ Цена за кг', `new:mode:${invoiceId}:PRICE_PER_KG`)
    .row()
    .text('📋 Прайс клиента', `new:mode:${invoiceId}:CLIENT_PRICELIST`)
    .text('📊 Индикатив КГД', `new:mode:${invoiceId}:KGD_INDICATIVE`);
  await ctx.reply(
    `✅ Файл получен (${fileName})\n📊 67 позиций\n⚖️ 31 176 кг брутто (предварительно)\n🔢 213 670 шт\n\nРежим стоимости?`,
    { reply_markup: kb },
  );
}

async function handleModePicked(
  ctx: BotCtx,
  invoiceId: string,
  mode: PriceMode,
): Promise<void> {
  if (!ctx.from) return;
  const session = await getSession(ctx.from.id);
  if (session.state !== 'new:mode') return;
  if (mode === 'TARGET_PAYMENTS') {
    await setSession(ctx.from.id, 'new:value', { ...session.context, mode });
    await ctx.reply('Сколько $? Например: 5000');
    return;
  }
  if (mode === 'PRICE_PER_KG') {
    await setSession(ctx.from.id, 'new:value', { ...session.context, mode });
    await ctx.reply('Цена за кг ($)? Например: 0.7');
    return;
  }
  await runClassification(ctx, invoiceId, mode, undefined);
}

async function handleValueInput(ctx: BotCtx, session: SessionState, raw: string): Promise<void> {
  if (!ctx.from) return;
  const value = Number(raw.replace(/[^\d.]/g, ''));
  if (!value || value <= 0) {
    await ctx.reply('Не похоже на число. Введи число, например 5000.');
    return;
  }
  const invoiceId = session.context.invoice_id as string;
  const mode = session.context.mode as PriceMode;
  await runClassification(ctx, invoiceId, mode, value);
}

async function runClassification(
  ctx: BotCtx,
  invoiceId: string,
  mode: PriceMode,
  value: number | undefined,
): Promise<void> {
  if (!ctx.from) return;
  await supabase
    .from('invoices')
    .update({ status: 'PROCESSING', price_mode: mode, price_value: value ?? null })
    .eq('id', invoiceId);
  await ctx.reply('🔄 Запускаю классификатор...\n⏳ Обычно это 2-3 минуты');

  // In mock mode we return canned data immediately (no real Claude call here).
  const items = cannedItems();
  const summary = computeSummary(items, mode, value);
  await supabase
    .from('invoices')
    .update({ status: 'REVIEW', items, summary })
    .eq('id', invoiceId);
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'INVOICE_CLASSIFIED',
    target_type: 'invoice',
    target_id: invoiceId,
    payload: { mode, value, codes: summary.codes_count },
  });

  await clearSession(ctx.from.id);

  const inv = await loadInvoice(invoiceId);
  if (!inv) return;
  await ctx.reply(`✅ Готово!\n\n${summaryText(inv)}`, { reply_markup: reviewKeyboard(inv) });
}

async function showItem(ctx: BotCtx, invoiceId: string, index: number): Promise<void> {
  const inv = await loadInvoice(invoiceId);
  if (!inv?.items) return;
  const item = inv.items.find((i) => i.index === index);
  if (!item) return;
  const alts = (item.alternatives ?? [])
    .map((a, i) => `${i + 1}. ${a.code} — ${a.description}`)
    .join('\n');
  await ctx.reply(
    [
      `Позиция #${item.index}:`,
      `Артикул: ${item.article}`,
      `Текст: ${item.text_original} (${item.text_translated})`,
      `Кол-во: ${item.quantity} шт, Брутто: ${item.gross_kg} кг`,
      '━━━━━━━━━━━━━━━━━━━━',
      `Текущий код: ${item.tnved_code}`,
      `Описание: ${item.tnved_description}`,
      `Ставка пошлины: ${item.duty_rate}%`,
      `Уверенность LLM: ${item.confidence}% ${item.confidence < 80 ? '⚠️' : '✅'}`,
      '━━━━━━━━━━━━━━━━━━━━',
      'Альтернативы:',
      alts || '—',
    ].join('\n'),
    { reply_markup: itemKeyboard(invoiceId, item) },
  );
}

async function patchItemCode(
  invoiceId: string,
  index: number,
  newCode: string,
): Promise<void> {
  const inv = await loadInvoice(invoiceId);
  if (!inv?.items) return;
  const hit = TNVED_LOOKUP[newCode];
  const items = inv.items.map((it) => {
    if (it.index !== index) return it;
    return {
      ...it,
      tnved_code: newCode,
      tnved_description: hit?.description ?? it.tnved_description,
      duty_rate: hit?.duty_rate ?? it.duty_rate,
      needs_review: false,
      confidence: Math.max(it.confidence, 95),
    };
  });
  await supabase.from('invoices').update({ items }).eq('id', invoiceId);
}

function invoiceAsText(inv: InvoiceRow): string {
  const lines: string[] = [];
  lines.push(`Инвойс #${inv.invoice_number ?? inv.id.slice(0, 8)}`);
  lines.push(`Клиент: ${inv.client_name}`);
  lines.push('');
  lines.push('Позиции (классифицированные):');
  lines.push('────────────────────────────────');
  for (const it of inv.items ?? []) {
    lines.push(
      `${it.index}. ${it.article} — ${it.text_translated}\n` +
        `   Кол-во: ${it.quantity} шт, Брутто: ${it.gross_kg} кг\n` +
        `   Код ТН ВЭД: ${it.tnved_code} (ставка ${it.duty_rate}%)`,
    );
  }
  const s = inv.summary;
  if (s) {
    lines.push('');
    lines.push('Итого:');
    lines.push('────────────────────────────────');
    lines.push(`Стоимость: $${fmt(s.cost_usd)}`);
    lines.push(`Пошлина:   $${fmt(s.duty_usd)}`);
    lines.push(`НДС 16%:   $${fmt(s.vat_usd)}`);
    lines.push(`Сбор:      $${fmt(s.fee_usd)}`);
    lines.push(`ВСЕГО ПЛАТЕЖЕЙ: $${fmt(s.total_payments_usd)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

function buildBot(token: string): Bot<BotCtx> {
  const bot = new Bot<BotCtx>(token);
  bot.use(async (ctx, next) => {
    await attachUser(ctx);
    await next();
  });

  async function greet(ctx: BotCtx) {
    const u = ctx.dbUser!;
    const clients = u.client_access.length > 0 ? u.client_access.join(', ') : '—';
    const teamLine = u.team_name ? `\nКоманда: ${u.team_name}` : '';
    await ctx.reply(
      `👋 Добро пожаловать в TNVED.ai!\n\nТы: ${u.full_name} (${ROLE_TITLE[u.role]})${teamLine}\nДоступные клиенты: ${clients}\n\nГлавное меню:`,
      { reply_markup: mainMenu(u.role) },
    );
  }

  // /cancel — clear FSM session
  bot.command('cancel', async (ctx) => {
    if (ctx.from) await clearSession(ctx.from.id);
    await ctx.reply('✓ Ок. /menu — главное меню.');
  });

  bot.command('start', async (ctx) => {
    if (ctx.dbUser) return greet(ctx);
    const username = ctx.from?.username;
    if (username) {
      const pending = await findUserByUsername(username);
      if (pending && pending.is_active && pending.telegram_user_id === null) {
        await bindTelegramId(pending.id, ctx.from!.id);
        await audit({
          actor_user_id: pending.id,
          action: 'USER_BOUND',
          target_type: 'user',
          target_id: pending.id,
          payload: { tg_id: ctx.from!.id, username },
        });
        ctx.dbUser = { ...pending, telegram_user_id: ctx.from!.id };
        return greet(ctx);
      }
    }
    await ctx.reply(
      `❌ Этот бот для сотрудников TNVED.ai.\nЕсли ты сотрудник — попроси руководителя добавить тебя по username @${username ?? 'твой_username'}`,
    );
  });

  bot.command('menu', async (ctx) => {
    if (!ctx.dbUser) return ctx.reply('Сначала /start');
    await ctx.reply('Главное меню:', { reply_markup: mainMenu(ctx.dbUser.role) });
  });

  bot.command('help', async (ctx) => {
    const role = ctx.dbUser?.role;
    let text =
      '📚 Команды:\n\n/start — авторизация\n/menu — главное меню\n/me — моя информация\n/new — создать инвойс\n/list — мои задачи\n/history — завершённые\n/clients — мои клиенты\n/cancel — отмена\n';
    if (role === 'MANAGER' || role === 'OWNER') {
      text +=
        '\nМенеджер:\n/team — команда\n/team_list — задачи команды\n/team_stats — статистика\n/add_operator @username Имя Клиент1,Клиент2\n/help_owner Текст\n';
    }
    if (role === 'OWNER') {
      text +=
        '\nOWNER:\n/admin\n/add_manager @username Имя Название проекта\n/all_users\n/all_invoices\n/broadcast Текст\n';
    }
    if (role === 'OPERATOR' || role === 'MANAGER') {
      text += '\n/help_manager Текст — запрос помощи\n';
    }
    await ctx.reply(text);
  });

  bot.command('me', async (ctx) => {
    const u = ctx.dbUser;
    if (!u) return ctx.reply('Сначала /start');
    const clients = u.client_access.length > 0 ? u.client_access.join(', ') : '—';
    const teamLine = u.team_name ? `\nКоманда: ${u.team_name}` : '';
    await ctx.reply(
      `Ты: ${u.full_name}\nРоль: ${ROLE_TITLE[u.role]}${teamLine}\nДоступные клиенты: ${clients}\n\n📊 Статистика:\nВсего инвойсов: ${u.invoices_total}\nВ этом месяце: ${u.invoices_this_month}`,
    );
  });

  bot.command('new', async (ctx) => {
    if (!ctx.dbUser) return ctx.reply('Сначала /start');
    await startNewInvoice(ctx);
  });

  bot.command('list', async (ctx) => {
    if (!ctx.dbUser) return ctx.reply('Сначала /start');
    const items = await listActiveAssigned(ctx.dbUser.id);
    if (items.length === 0) return ctx.reply('📋 Активных задач нет.');
    await ctx.reply(['📋 В работе:', ...items.map(invoiceShort)].join('\n'));
  });

  bot.command('history', async (ctx) => {
    if (!ctx.dbUser) return ctx.reply('Сначала /start');
    const items = await listHistoryAssigned(ctx.dbUser.id);
    if (items.length === 0) return ctx.reply('📜 Истории нет.');
    await ctx.reply(['📜 Завершённые:', ...items.map(invoiceShort)].join('\n'));
  });

  bot.command('clients', async (ctx) => {
    const u = ctx.dbUser;
    if (!u) return ctx.reply('Сначала /start');
    const list = u.client_access.includes('*') ? CLIENTS : u.client_access;
    if (list.length === 0) return ctx.reply('👥 Нет доступных клиентов.');
    await ctx.reply(`👥 Клиенты:\n${list.map((c) => `• ${c}`).join('\n')}`);
  });

  bot.command('team', async (ctx) => {
    if (!requireRole(ctx, 'MANAGER', 'OWNER')) return ctx.reply('🚫 Только MANAGER / OWNER.');
    const team = await listOperators(ctx.dbUser!.id);
    if (team.length === 0) {
      await ctx.reply(
        '👥 В команде пока никого.\n\nДобавь: /add_operator @username Имя Клиент1,Клиент2',
      );
      return;
    }
    const kb = new InlineKeyboard();
    const lines = [`👥 Твоя команда (${team.length}):`];
    for (const op of team) {
      lines.push(`• ${op.full_name} (${op.client_access.join(', ') || '—'})`);
      kb.text(`🗑 ${op.full_name}`, `team:rm:${op.id}`).row();
    }
    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  });

  bot.command('team_list', async (ctx) => {
    if (!requireRole(ctx, 'MANAGER', 'OWNER')) return ctx.reply('🚫 Только MANAGER / OWNER.');
    const items = await listTeamInvoices(ctx.dbUser!.id);
    if (items.length === 0) return ctx.reply('📋 У команды нет активных задач.');
    await ctx.reply(['📋 В работе у команды:', ...items.map(invoiceShort)].join('\n'));
  });

  bot.command('team_stats', async (ctx) => {
    if (!requireRole(ctx, 'MANAGER', 'OWNER')) return ctx.reply('🚫 Только MANAGER / OWNER.');
    const team = await listOperators(ctx.dbUser!.id);
    if (team.length === 0) return ctx.reply('📊 В команде пока нет операторов.');
    const lines = ['📊 Статистика команды:'];
    for (const op of team) {
      const conf = op.avg_confidence != null ? `${op.avg_confidence}%` : '—';
      lines.push(
        `• ${op.full_name}: ${op.invoices_total} инвойсов, в этом месяце ${op.invoices_this_month}, ср. уверенность ${conf}`,
      );
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('add_operator', async (ctx) => {
    if (!requireRole(ctx, 'MANAGER', 'OWNER')) return ctx.reply('🚫 Только MANAGER / OWNER.');
    const text = ctx.message?.text?.replace(/^\/add_operator(@\S+)?\s*/, '').trim() ?? '';
    if (!text) {
      await ctx.reply(
        'Формат: /add_operator @username Имя Клиент1,Клиент2\n\nПример: /add_operator @aigerim_dev Айгерим LINEA TRANSIT',
      );
      return;
    }
    const tokens = text.split(/\s+/);
    const username = (tokens[0] ?? '').replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{4,32}$/.test(username)) return ctx.reply('Не похоже на username.');
    const rest = tokens.slice(1).join(' ');
    if (!rest) return ctx.reply('Укажи имя и клиентов.');
    let fullName = rest;
    let clientsRaw = '';
    if (rest.includes(',')) {
      const idx = rest.lastIndexOf(',');
      const before = rest.slice(0, idx);
      const lastSpace = before.lastIndexOf(' ');
      fullName = lastSpace > 0 ? rest.slice(0, lastSpace).trim() : tokens[1] ?? '';
      clientsRaw = rest.slice(lastSpace + 1).trim();
    } else {
      const lastSpace = rest.lastIndexOf(' ');
      if (lastSpace > 0) {
        fullName = rest.slice(0, lastSpace).trim();
        clientsRaw = rest.slice(lastSpace + 1).trim();
      } else {
        clientsRaw = rest;
        fullName = username;
      }
    }
    const clients = clientsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!fullName || clients.length === 0) {
      return ctx.reply('Не разобрал. Пример: /add_operator @ivan Иван LINEA TRANSIT');
    }
    const existing = await findUserByUsername(username);
    if (existing && existing.is_active) {
      return ctx.reply(`@${username} уже в системе как ${existing.role}.`);
    }
    const created = await createUser({
      telegram_username: username,
      full_name: fullName,
      role: 'OPERATOR',
      manager_id: ctx.dbUser!.id,
      team_name: ctx.dbUser!.team_name,
      client_access: clients,
      added_by: ctx.dbUser!.id,
    });
    await audit({
      actor_user_id: ctx.dbUser!.id,
      action: 'OPERATOR_ADDED',
      target_type: 'user',
      target_id: created.id,
      payload: { username, full_name: fullName, clients },
    });
    await ctx.reply(
      `✅ ${fullName} добавлен(а).\nКлиенты: ${clients.join(', ')}\n\nПередай @${username} команду /start`,
    );
  });

  bot.command('add_manager', async (ctx) => {
    if (!requireRole(ctx, 'OWNER')) return ctx.reply('🚫 Только OWNER.');
    const text = ctx.message?.text?.replace(/^\/add_manager(@\S+)?\s*/, '').trim() ?? '';
    if (!text) {
      await ctx.reply(
        'Формат: /add_manager @username Имя Название проекта\n\nПример: /add_manager @ruslan_chief Руслан Импорт сантехники',
      );
      return;
    }
    const tokens = text.split(/\s+/);
    if (tokens.length < 2) return ctx.reply('Минимум: username и имя.');
    const username = (tokens[0] ?? '').replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{4,32}$/.test(username)) return ctx.reply('Не похоже на username.');
    const fullName = tokens[1]!;
    const teamName = tokens.slice(2).join(' ') || null;
    const existing = await findUserByUsername(username);
    if (existing && existing.is_active) {
      return ctx.reply(`@${username} уже в системе как ${existing.role}.`);
    }
    const created = await createUser({
      telegram_username: username,
      full_name: fullName,
      role: 'MANAGER',
      team_name: teamName,
      client_access: ['*'],
      added_by: ctx.dbUser!.id,
    });
    await audit({
      actor_user_id: ctx.dbUser!.id,
      action: 'MANAGER_ADDED',
      target_type: 'user',
      target_id: created.id,
      payload: { username, full_name: fullName, team_name: teamName },
    });
    await ctx.reply(
      `✅ ${fullName} назначен(а) MANAGER\n${teamName ? `Проект: «${teamName}»\n` : ''}\nТеперь /add_operator — добавлять операторов.\nПередай @${username} команду /start.`,
    );
  });

  bot.command('admin', async (ctx) => {
    if (!requireRole(ctx, 'OWNER')) return ctx.reply('🚫 Только OWNER.');
    await ctx.reply(
      '🛠 Админ-команды:\n\n/all_users\n/all_invoices\n/add_manager @user Имя Проект\n/broadcast Текст',
    );
  });

  bot.command('all_users', async (ctx) => {
    if (!requireRole(ctx, 'OWNER')) return ctx.reply('🚫 Только OWNER.');
    const users = await listAllUsers();
    if (users.length === 0) return ctx.reply('Нет пользователей.');
    const lines = ['👥 Все пользователи:'];
    for (const u of users) {
      const status = u.is_active ? '' : ' (неактивен)';
      const uname = u.telegram_username ? ` @${u.telegram_username}` : '';
      lines.push(`${ROLE_TITLE[u.role][0]} ${u.full_name}${uname} — ${u.role}${status}`);
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('all_invoices', async (ctx) => {
    if (!requireRole(ctx, 'OWNER')) return ctx.reply('🚫 Только OWNER.');
    const items = await listAllInvoices();
    if (items.length === 0) return ctx.reply('Инвойсов пока нет.');
    await ctx.reply(['📊 Последние инвойсы:', ...items.map(invoiceShort)].join('\n'));
  });

  bot.command('broadcast', async (ctx) => {
    if (!requireRole(ctx, 'OWNER')) return ctx.reply('🚫 Только OWNER.');
    const text = ctx.message?.text?.replace(/^\/broadcast(@\S+)?\s*/, '').trim() ?? '';
    if (!text) return ctx.reply('Использование: /broadcast Текст');
    const users = await listAllUsers();
    let sent = 0;
    for (const u of users) {
      if (!u.is_active || u.telegram_user_id == null) continue;
      if (u.id === ctx.dbUser!.id) continue;
      try {
        await ctx.api.sendMessage(Number(u.telegram_user_id), `📢 ${text}`);
        sent++;
      } catch (_) {}
    }
    await audit({
      actor_user_id: ctx.dbUser!.id,
      action: 'BROADCAST',
      payload: { text, recipients: sent },
    });
    await ctx.reply(`✅ Отправлено ${sent} сотрудникам.`);
  });

  bot.command('help_manager', async (ctx) => {
    if (!requireRole(ctx, 'OPERATOR')) return ctx.reply('🚫 Только для OPERATOR.');
    const desc = ctx.message?.text?.replace(/^\/help_manager(@\S+)?\s*/, '').trim() ?? '';
    if (!desc) return ctx.reply('Использование: /help_manager Опиши проблему');
    const u = ctx.dbUser!;
    if (!u.manager_id) return ctx.reply('У тебя не назначен MANAGER.');
    const { data: req } = await supabase
      .from('help_requests')
      .insert({ from_user_id: u.id, to_user_id: u.manager_id, description: desc })
      .select('id')
      .single();
    await audit({
      actor_user_id: u.id,
      action: 'HELP_REQUESTED',
      target_type: 'help_request',
      target_id: req?.id ?? null,
    });
    const { data: mgr } = await supabase
      .from('telegram_users')
      .select('telegram_user_id, full_name')
      .eq('id', u.manager_id)
      .maybeSingle();
    if (mgr?.telegram_user_id) {
      try {
        await ctx.api.sendMessage(
          Number(mgr.telegram_user_id),
          `🔔 ${u.full_name} просит помощи:\n«${desc}»`,
        );
      } catch (_) {}
    }
    await ctx.reply('✅ Запрос отправлен руководителю.');
  });

  bot.command('help_owner', async (ctx) => {
    if (!requireRole(ctx, 'MANAGER')) return ctx.reply('🚫 Только для MANAGER.');
    const desc = ctx.message?.text?.replace(/^\/help_owner(@\S+)?\s*/, '').trim() ?? '';
    if (!desc) return ctx.reply('Использование: /help_owner Опиши проблему');
    const u = ctx.dbUser!;
    const { data: owner } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('role', 'OWNER')
      .maybeSingle();
    if (!owner) return ctx.reply('OWNER не найден.');
    const { data: req } = await supabase
      .from('help_requests')
      .insert({ from_user_id: u.id, to_user_id: owner.id, description: desc })
      .select('id')
      .single();
    await audit({
      actor_user_id: u.id,
      action: 'HELP_REQUESTED',
      target_type: 'help_request',
      target_id: req?.id ?? null,
    });
    if (owner.telegram_user_id) {
      try {
        await ctx.api.sendMessage(
          Number(owner.telegram_user_id),
          `🔔 ${u.full_name} (MANAGER) просит помощи:\n«${desc}»`,
        );
      } catch (_) {}
    }
    await ctx.reply('✅ Запрос отправлен OWNER.');
  });

  // ---------- Callback queries ----------

  bot.callbackQuery('menu:new', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.dbUser) return;
    await startNewInvoice(ctx);
  });

  bot.callbackQuery(/^menu:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const action = ctx.match![1]!;
    const cmd: Record<string, string> = {
      list: 'list',
      history: 'history',
      clients: 'clients',
      team: 'team',
      teamstats: 'team_stats',
      admin: 'admin',
    };
    if (cmd[action]) await ctx.reply(`Используй /${cmd[action]}`);
  });

  bot.callbackQuery(/^new:client:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.dbUser) return;
    const clientName = decodeURIComponent(ctx.match![1]!);
    await handleClientPicked(ctx, clientName);
  });

  bot.callbackQuery('new:cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) await clearSession(ctx.from.id);
    await ctx.reply('🚫 Отменено.');
  });

  bot.callbackQuery(/^new:mode:([^:]+):(TARGET_PAYMENTS|PRICE_PER_KG|CLIENT_PRICELIST|KGD_INDICATIVE)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.dbUser) return;
    const invoiceId = ctx.match![1]!;
    const mode = ctx.match![2]! as PriceMode;
    await handleModePicked(ctx, invoiceId, mode);
  });

  bot.callbackQuery(/^inv:item:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showItem(ctx, ctx.match![1]!, Number(ctx.match![2]));
  });

  bot.callbackQuery(/^inv:keep:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('✓ Подтверждено');
    const invoiceId = ctx.match![1]!;
    const index = Number(ctx.match![2]);
    const inv = await loadInvoice(invoiceId);
    if (!inv?.items) return;
    const item = inv.items.find((i) => i.index === index);
    if (!item) return;
    await patchItemCode(invoiceId, index, item.tnved_code);
    await audit({
      actor_user_id: ctx.dbUser?.id ?? null,
      action: 'ITEM_KEPT',
      target_type: 'invoice',
      target_id: invoiceId,
      payload: { index, code: item.tnved_code },
    });
    const fresh = await loadInvoice(invoiceId);
    if (fresh) {
      await ctx.reply(summaryText(fresh), { reply_markup: reviewKeyboard(fresh) });
    }
  });

  bot.callbackQuery(/^inv:pick:([^:]+):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('✓ Применено');
    const invoiceId = ctx.match![1]!;
    const index = Number(ctx.match![2]);
    const code = ctx.match![3]!;
    await patchItemCode(invoiceId, index, code);
    await audit({
      actor_user_id: ctx.dbUser?.id ?? null,
      action: 'ITEM_PATCHED',
      target_type: 'invoice',
      target_id: invoiceId,
      payload: { index, code },
    });
    const fresh = await loadInvoice(invoiceId);
    if (fresh) {
      await ctx.reply(summaryText(fresh), { reply_markup: reviewKeyboard(fresh) });
    }
  });

  bot.callbackQuery(/^inv:back:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const inv = await loadInvoice(ctx.match![1]!);
    if (inv) await ctx.reply(summaryText(inv), { reply_markup: reviewKeyboard(inv) });
  });

  bot.callbackQuery(/^inv:approve:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const invoiceId = ctx.match![1]!;
    const inv = await loadInvoice(invoiceId);
    if (!inv) return ctx.reply('Инвойс не найден.');
    const remaining = (inv.items ?? []).filter((i) => i.needs_review);
    if (remaining.length > 0) {
      return ctx.reply(`⚠️ Сначала закрой ревью по ${remaining.length} позициям.`);
    }
    await supabase
      .from('invoices')
      .update({ status: 'APPROVED', approved_at: new Date().toISOString() })
      .eq('id', invoiceId);
    await audit({
      actor_user_id: ctx.dbUser?.id ?? null,
      action: 'INVOICE_APPROVED',
      target_type: 'invoice',
      target_id: invoiceId,
    });
    if (ctx.dbUser) {
      await supabase
        .from('telegram_users')
        .update({ invoices_total: ctx.dbUser.invoices_total + 1 })
        .eq('id', ctx.dbUser.id);
    }
    // Send the invoice content as a text file (xlsx generation deferred).
    const fresh = await loadInvoice(invoiceId);
    if (fresh) {
      const content = invoiceAsText(fresh);
      const blob = new Blob([content], { type: 'text/plain; charset=utf-8' });
      const fileName = `invoice_${fresh.invoice_number ?? fresh.id.slice(0, 8)}.txt`;
      try {
        // grammY accepts InputFile-like data; here we pass a Blob via the api.
        await ctx.api.sendDocument(ctx.chat!.id, {
          source: new Uint8Array(await blob.arrayBuffer()),
          filename: fileName,
        } as unknown as Parameters<typeof ctx.api.sendDocument>[1], {
          caption: '✓ Инвойс готов!',
        });
      } catch (err) {
        console.error('sendDocument failed; sending as text', err);
        await ctx.reply(`✓ Инвойс готов!\n\n${content}`);
      }
    }
    await ctx.reply('Что дальше?', {
      reply_markup: new InlineKeyboard()
        .text('📝 Новый инвойс', 'menu:new')
        .text('📋 Мои задачи', 'menu:list'),
    });
  });

  bot.callbackQuery(/^inv:cancel:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const invoiceId = ctx.match![1]!;
    await supabase.from('invoices').update({ status: 'CANCELED' }).eq('id', invoiceId);
    await audit({
      actor_user_id: ctx.dbUser?.id ?? null,
      action: 'INVOICE_CANCELED',
      target_type: 'invoice',
      target_id: invoiceId,
    });
    await ctx.reply('🚫 Инвойс отменён.');
  });

  bot.callbackQuery(/^team:rm:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!requireRole(ctx, 'MANAGER', 'OWNER')) return;
    const userId = ctx.match![1]!;
    await deactivateUser(userId);
    await audit({
      actor_user_id: ctx.dbUser!.id,
      action: 'USER_DEACTIVATED',
      target_type: 'user',
      target_id: userId,
    });
    await ctx.reply('🗑 Удалён из команды.');
  });

  // ---------- State-aware message handlers (must run before generic fallback) ----------

  // Document / photo handler — only active during 'new:file' state.
  bot.on(['message:document', 'message:photo'], async (ctx, next) => {
    if (!ctx.dbUser || !ctx.from) return next();
    const session = await getSession(ctx.from.id);
    if (session.state !== 'new:file') return next();
    let fileRef = '';
    let fileName = 'packing-list';
    if (ctx.message?.document) {
      fileName = ctx.message.document.file_name ?? fileName;
      fileRef = ctx.message.document.file_id;
    } else if (ctx.message?.photo) {
      const ph = ctx.message.photo[ctx.message.photo.length - 1];
      if (ph) fileRef = ph.file_id;
      fileName = 'photo.jpg';
    }
    await handleFileUpload(ctx, session, fileRef, fileName);
  });

  // Text handler — only consume if we're in a state that expects free-form input.
  bot.on('message:text', async (ctx, next) => {
    if (!ctx.dbUser || !ctx.from) return next();
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/')) return next();
    const session = await getSession(ctx.from.id);
    if (session.state === 'new:value') {
      await handleValueInput(ctx, session, text);
      return;
    }
    if (session.state === 'new:file') {
      await ctx.reply('Жду packing list — пришли xlsx, pdf или фото.');
      return;
    }
    await ctx.reply('Не понял. /help — список команд.');
  });

  bot.on('message', async (ctx) => {
    if (!ctx.dbUser) return;
    await ctx.reply('Не понял. /help — список команд.');
  });

  bot.catch((err) => {
    console.error('bot error', err);
  });

  return bot;
}

// ---------------------------------------------------------------------------
// Webhook entrypoint
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return new Response('TNVED.ai bot webhook is alive.', { status: 200 });
  }
  if (req.method !== 'POST') return new Response('OK', { status: 200 });
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const token = parts[parts.length - 1] ?? '';
  if (!/^\d+:[\w-]{20,}$/.test(token)) return new Response('Forbidden', { status: 403 });
  const bot = buildBot(token);
  const handler = webhookCallback(bot, 'std/http');
  try {
    return await handler(req);
  } catch (err) {
    console.error('webhook handler error', err);
    return new Response('OK', { status: 200 });
  }
});
