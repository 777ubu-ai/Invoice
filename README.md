# TNVED.ai — Invoice automation

Repository for TNVED.ai project. Monorepo layout:

```
.
├── bot/         Telegram bot (Sprint 3) — see bot/README.md
├── api-mock/    Mock Sprint 2 API (used by the bot until the real API exists)
├── migrations/  SQL migrations applied to Supabase
└── docs/        Architecture and operator guides
```

## Sprint 3 — Telegram bot for operators

Status: in progress on branch `claude/telegram-bot-planning-zXqOn`.

See `bot/README.md` for development setup and `TNVED Sprint3 Telegram TZ v1.pdf` for the
spec.

## Infrastructure

- **Supabase** project `tnved-bot` (region eu-central-1) — schema in `migrations/`.
- **Telegram bot** `@InvoiceAgentsBot`.
