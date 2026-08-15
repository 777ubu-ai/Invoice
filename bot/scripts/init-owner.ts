import { env } from '../src/config/env.js';
import { createUser, findByTelegramId } from '../src/services/users.repo.js';
import { audit } from '../src/services/audit.repo.js';
import { logger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const tgId = env.INITIAL_OWNER_TG_USER_ID;
  const username = env.INITIAL_OWNER_USERNAME;
  const fullName = env.INITIAL_OWNER_NAME;

  if (tgId == null || !username || !fullName) {
    logger.error(
      'Set INITIAL_OWNER_TG_USER_ID, INITIAL_OWNER_USERNAME, INITIAL_OWNER_NAME in .env',
    );
    process.exit(1);
    return;
  }

  const existing = await findByTelegramId(tgId);
  if (existing) {
    logger.info({ id: existing.id, role: existing.role }, 'OWNER already exists');
    process.exit(0);
    return;
  }

  const owner = await createUser({
    telegram_user_id: tgId,
    telegram_username: username,
    full_name: fullName,
    role: 'OWNER',
    client_access: ['*'],
  });

  await audit({
    actor_user_id: owner.id,
    action: 'OWNER_INITIALIZED',
    target_type: 'user',
    target_id: owner.id,
    payload: { username, full_name: fullName },
  });

  logger.info({ id: owner.id }, '✓ OWNER created. Send /start to the bot.');
}

main().catch((err) => {
  logger.fatal({ err }, 'init-owner failed');
  process.exit(1);
});
