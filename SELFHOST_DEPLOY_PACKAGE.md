# Invoice / TNVED.ai Self-Host Deploy Package

Target VPS: `185.22.65.11`
Future path: `/opt/tnved-bot`
Docker project name: `tnved_bot`
Source branch: `agent/invoice-selfhost-recovery`

This package is prepared for a future deploy. Do not run these commands until
the deployment window is approved.

## Required Secrets

User-provided:

- `TELEGRAM_BOT_TOKEN` from BotFather.
- `TELEGRAM_API_ID` from my.telegram.org.
- `TELEGRAM_API_HASH` from my.telegram.org.
- `ANTHROPIC_API_KEY` from Anthropic Console.
- `INITIAL_OWNER_TG_USER_ID` from Telegram user info.

Generate on the VPS during deployment:

- `POSTGRES_PASSWORD`: `openssl rand -base64 24`
- `SUPABASE_JWT_SECRET`: `openssl rand -base64 48`
- `SUPABASE_SERVICE_KEY`: `./scripts/gen-service-role-jwt.sh`

Production policy:

- `MAX_TELEGRAM_FILE_BYTES=104857600` by default (100 MB).
- Increase only after checking free disk and backup capacity.

## Docker Isolation

The compose project uses explicit names so it does not collide with UrTruck,
BizChat, n8n, or other stacks on the VPS.

- Network: `tnved_bot_network`
- Postgres volume: `tnved_bot_postgres_data`
- Telegram Bot API file volume: `tnved_bot_telegram_data`
- Telegram temp volume: `tnved_bot_telegram_tmp`

No service publishes Postgres, PostgREST, or Telegram Bot API to the public
network. Administration should use `docker compose exec` over SSH.

Resource guards:

- Postgres: `1g`, `1.0` CPU.
- PostgREST: `256m`, `0.5` CPU.
- Bot + local Telegram API: `1536m`, `2.0` CPU.

## Database Startup Safety

Static audit of `migrations/0000` through `0008`:

- No `DROP`.
- No `TRUNCATE`.
- No data-destructive `DELETE`.
- Extensions use `CREATE EXTENSION IF NOT EXISTS`.
- Later migrations use additive `ALTER TABLE` and `CREATE TABLE IF NOT EXISTS`
  where needed.

The first Postgres start applies migrations only to an empty Docker volume.
Never run `docker compose down -v` on production unless a verified restore plan
is approved.

## Backup Plan

Backup location, outside the Postgres Docker volume:

```bash
/var/backups/tnved-bot
```

Daily backup command:

```bash
cd /opt/tnved-bot
docker compose exec -T postgres pg_dump -U tnved tnved \
  | gzip > /var/backups/tnved-bot/tnved_$(date +%Y%m%d_%H%M%S).sql.gz
```

Retention policy:

- Keep 7 daily backups.
- Keep 4 weekly backups.
- Copy at least one verified backup off-server before deleting Railway/Supabase.

Restore command:

```bash
cd /opt/tnved-bot
gzip -dc /var/backups/tnved-bot/tnved_YYYYMMDD_HHMMSS.sql.gz \
  | docker compose exec -T postgres psql -U tnved -d tnved
```

Verification command:

```bash
cd /opt/tnved-bot
docker compose exec -T postgres psql -U tnved -d tnved \
  -c "select count(*) as users from telegram_users;"
docker compose exec -T postgres psql -U tnved -d tnved \
  -c "select count(*) as invoices from invoices;"
```

## Post-Deploy Health Checks

Run only after the approved deploy:

```bash
cd /opt/tnved-bot
docker compose ps
docker compose exec -T postgres pg_isready -U tnved -d tnved
docker compose exec -T postgrest wget -qO- http://localhost:3000/ >/dev/null
docker compose logs --no-log-prefix bot | tail -100
```

Expected signals:

- Postgres is healthy.
- PostgREST is reachable only inside the compose network.
- Bot process is alive.
- TNVED CSV preload completes.
- Telegram `getMe` succeeds.
- `getWebhookInfo` shows polling-compatible state.
- Logs do not contain Telegram bot tokens or API credentials.

Do not use `getUpdates`, `deleteWebhook`, `setWebhook`, broadcasts, or real
packing lists during the technical health check.
