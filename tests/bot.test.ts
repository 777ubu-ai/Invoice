import test from 'node:test';
import assert from 'node:assert/strict';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../src/bot.js';
import { HOME } from '../src/menu.js';
import type { Role } from '../src/access.js';

const botInfo: UserFromGetMe = {
  id: 123, is_bot: true, first_name: 'Test', username: 'test_bot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
  can_manage_bots: false, supports_join_request_queries: false,
};

function message(text: string, privateChat = true): Update {
  return { update_id: 1, message: {
    message_id: 1, date: 0,
    from: { id: 42, is_bot: false, first_name: 'Test' },
    chat: privateChat ? { id: 42, type: 'private', first_name: 'Test' } : { id: -1, type: 'group', title: 'Group' },
    text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] } : {}),
  } };
}

function harness(kind: 'packing' | 'invoice', roles: Role[], owners: number[] = []) {
  const state = { roles, failed: false, reads: 0 };
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const bot = createBot('123:test', kind, { async rolesFor() {
    state.reads++;
    if (state.failed) throw new Error('database unavailable');
    return state.roles;
  } }, owners);
  bot.botInfo = botInfo;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as unknown as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  return { bot, calls, state };
}

test('accountant cannot open Packing Bot or invoke an old callback', async () => {
  const { bot, calls } = harness('packing', ['accountant']);
  await bot.handleUpdate(message('/start'));
  assert.match(String(calls[0]!.payload.text), /Нет доступа/);
  assert.deepEqual(calls[0]!.payload.reply_markup, { remove_keyboard: true });
  await bot.handleUpdate({ update_id: 2, callback_query: {
    id: 'stale', from: { id: 42, is_bot: false, first_name: 'Test' },
    chat_instance: 'test', message: (message('/start') as { message: NonNullable<Update['message']> }).message,
    data: 'approve_invoice:1',
  } });
  assert.equal(calls[1]!.method, 'answerCallbackQuery');
  assert.equal(calls[1]!.payload.text, 'Нет доступа');
});

test('accountant sees finances in Invoice Bot but not document preparation', async () => {
  const { bot, calls } = harness('invoice', ['accountant']);
  await bot.handleUpdate(message(HOME.sections));
  const text = String(calls[0]!.payload.text);
  assert.match(text, /Оплаты и расходы/);
  assert.doesNotMatch(text, /Новый инвойс/);
  assert.match(text, /ещё не подключены/);
});

test('accountant cannot query restricted grid even with a typed command', async () => {
  const { bot, calls } = harness('invoice', ['accountant']);
  await bot.handleUpdate(message('/price 3916100000'));
  assert.equal(calls[0]!.payload.text, 'Нет доступа к сетке.');
});

test('owner receives clear guidance for grid without treating invalid codes as valid', async () => {
  const { bot, calls } = harness('invoice', [], [42]);
  await bot.handleUpdate(message(HOME.grid));
  await bot.handleUpdate(message('/price 123'));
  await bot.handleUpdate(message('/price 3916100000'));
  assert.match(String(calls[0]!.payload.text), /\/price/);
  assert.match(String(calls[1]!.payload.text), /\/price/);
  assert.match(String(calls[2]!.payload.text), /ещё не подключена/);
});

test('owner can enter both bots; unknown user cannot enter either', async () => {
  for (const kind of ['packing', 'invoice'] as const) {
    const owner = harness(kind, [], [42]);
    await owner.bot.handleUpdate(message('/menu'));
    assert.match(String(owner.calls[0]!.payload.text), /новая версия/);
    assert.equal(owner.state.reads, 0);
    const unknown = harness(kind, []);
    await unknown.bot.handleUpdate(message('/start'));
    assert.match(String(unknown.calls[0]!.payload.text), /Нет доступа/);
  }
});

test('roles are checked again after reassignment and database failures fail closed', async () => {
  const { bot, calls, state } = harness('packing', ['packing']);
  await bot.handleUpdate(message('/menu'));
  state.roles = ['accountant'];
  await bot.handleUpdate(message('/menu'));
  assert.match(String(calls[1]!.payload.text), /Нет доступа/);
  state.failed = true;
  await assert.rejects(bot.handleUpdate(message('/menu')));
  assert.equal(calls.length, 2);
});

test('group chats never receive internal roles or menus', async () => {
  const { bot, calls, state } = harness('invoice', ['accountant']);
  await bot.handleUpdate(message('/me', false));
  assert.equal(calls.length, 0);
  assert.equal(state.reads, 0);
});

test('old commands and files do not execute the retired pipeline', async () => {
  const { bot, calls } = harness('invoice', ['invoice']);
  await bot.handleUpdate(message('/new_invoice'));
  const file = message('') as { update_id: number; message: NonNullable<Update['message']> };
  delete (file.message as { text?: string }).text;
  Object.assign(file.message, { document: { file_id: 'test', file_unique_id: 'test', file_name: 'packing.xlsx' } });
  await bot.handleUpdate(file);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(String(call.payload.text), /ещё не подключена/);
});
