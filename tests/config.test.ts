import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotKind, parseRoles, telegramId } from '../src/access.js';
import { readConfig } from '../src/config.js';

test('each process selects its token and rejects accidentally identical bot tokens', () => {
  const env = {
    PACKING_BOT_TOKEN: '123:packing', INVOICE_BOT_TOKEN: '456:invoice',
    DATABASE_URL: 'postgresql://test:test@localhost/test', OWNER_TELEGRAM_IDS: '42, 43',
  };
  assert.equal(readConfig(env, 'packing').token, '123:packing');
  assert.equal(readConfig(env, 'invoice').token, '456:invoice');
  assert.deepEqual(readConfig(env, 'invoice').ownerIds, [42, 43]);
  assert.throws(() => readConfig({ ...env, INVOICE_BOT_TOKEN: env.PACKING_BOT_TOKEN }, 'invoice'));
  assert.throws(() => readConfig({ ...env, OWNER_TELEGRAM_IDS: '' }, 'packing'));
  assert.throws(() => readConfig({ ...env, OWNER_TELEGRAM_IDS: '42oops' }, 'packing'));
  assert.throws(() => readConfig({ ...env, DATABASE_URL: 'https://example.test' }, 'packing'));
});

test('role and process arguments reject misspellings rather than grant implicit access', () => {
  assert.throws(() => parseBotKind(undefined));
  assert.throws(() => parseBotKind('all'));
  assert.throws(() => parseRoles('accountant,admin'));
  assert.throws(() => parseRoles(''));
  assert.throws(() => telegramId('-42'));
  assert.throws(() => telegramId('9007199254740992'));
});
