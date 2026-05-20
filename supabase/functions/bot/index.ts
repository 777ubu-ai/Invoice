// TNVED.ai Telegram bot — Supabase Edge Function (webhook mode).
//
// Webhook URL pattern:
//   https://<project>.supabase.co/functions/v1/bot/<TELEGRAM_BOT_TOKEN>
//
// The bot token is part of the URL path and acts as a shared secret.
//
// This is a slim webhook-mode counterpart to the Node bot in ../../../bot.
// It implements read-only views and one-shot management commands; the full
// invoice flow (/new) requires the Node version on Railway/Fly.

import { Bot, Context, InlineKeyboard, webhookCallback } from 'grammy';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Role = 'OWNER' | 'MANAGER' | 'OPERATOR';

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

interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  client_name: string;
  status: string;
  assigned_to: string | null;
  updated_at: string;
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

function invoiceShort(inv: InvoiceRow): string {
  const num = inv.invoice_number ?? inv.id.slice(0, 8);
  return `• #${num} ${inv.client_name} — ${STATUS_RU[inv.status] ?? inv.status}`;
}

function mainMenu(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard()
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
      '📚 Команды:\n\n/start — авторизация\n/menu — главное меню\n/me — моя информация\n/list — мои задачи\n/history — завершённые\n/clients — мои клиенты\n/cancel — отмена\n';
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
    text += '\n📦 /new (создание инвойса) — в полной версии (Railway).';
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

  bot.command('cancel', async (ctx) => {
    await ctx.reply('✓ Ок. /menu — главное меню.');
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
    const list = u.client_access.includes('*') ? ['LINEA TRANSIT', 'ТОО Альфа'] : u.client_access;
    if (list.length === 0) return ctx.reply('👥 Нет доступных клиентов.');
    await ctx.reply(`👥 Клиенты:\n${list.map((c) => `• ${c}`).join('\n')}`);
  });

  bot.command('new', async (ctx) => {
    if (!ctx.dbUser) return ctx.reply('Сначала /start');
    await ctx.reply(
      '📦 Создание инвойса доступно в полной версии бота.\n\nЭта (webhook) версия — для управления командой и просмотра задач.\nДля полного flow разверни Node-версию из репо на Railway.',
    );
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

  bot.on('message', async (ctx) => {
    if (!ctx.dbUser) return;
    await ctx.reply('Не понял команду. /help — список команд.');
  });

  bot.catch((err) => {
    console.error('bot error', err);
  });

  return bot;
}

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
