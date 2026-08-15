-- telegram_user_id is nullable so that managers/owners can add users by username
-- before those users have ever messaged the bot. Their telegram_user_id is filled
-- in on first /start (see bindTelegramId in users.repo.ts).
ALTER TABLE telegram_users ALTER COLUMN telegram_user_id DROP NOT NULL;
