# TNVED.ai Telegram Bot (Sprint 3)

Telegram bot for TNVED.ai operators. UX layer over the Sprint 2 API.

## Stack

- Node.js 20 + TypeScript (ESM)
- grammY
- Supabase (PostgreSQL) for users, audit, invoices
- Redis for FSM state / idempotency cache (later)
- BullMQ for long-running classification polling (later)

## Local development

```bash
cp .env.example .env
# Fill TELEGRAM_BOT_TOKEN, SUPABASE_SERVICE_KEY at minimum.
npm install
npm run dev
```

### Bootstrap OWNER

The first user needs to be created via CLI:

```bash
# Set in .env:
# INITIAL_OWNER_TG_USER_ID=123456789
# INITIAL_OWNER_USERNAME=@your_username
# INITIAL_OWNER_NAME=Your Name

npm run init-owner
```

Then send `/start` to the bot from the same Telegram account.

## Project layout

```
bot/
├── src/
│   ├── main.ts                 entrypoint
│   ├── bot.ts                  grammY bot wiring
│   ├── config/env.ts           zod-validated env
│   ├── middleware/             auth, role, logging
│   ├── handlers/
│   │   ├── common/             /start /menu /help /me /cancel
│   │   ├── invoice/            invoice flow (TBD)
│   │   ├── operator/           operator commands (TBD)
│   │   ├── manager/            manager commands (TBD)
│   │   └── owner/              owner commands (TBD)
│   ├── conversations/          multi-step dialogs (TBD)
│   ├── services/               supabase, repos, api client
│   ├── keyboards/              inline keyboards
│   ├── queues/                 BullMQ workers (TBD)
│   ├── utils/                  logger, helpers
│   └── types/
├── scripts/init-owner.ts
└── tests/
```

## Status

This is the foundation commit:

- ✅ Supabase schema applied (telegram_users, help_requests, audit_log, invoices stub)
- ✅ /start, /menu, /help, /me, /cancel
- ✅ Auth + audit middleware
- 🚧 Team management (next)
- 🚧 Invoice creation flow (next)
- 🚧 Mock Sprint 2 API in `../api-mock/` (next)
