# Changelog

## Sprint 3 — Telegram bot for operators

### Added

- Supabase schema: `telegram_users`, `help_requests`, `audit_log`, `invoices`.
- grammY bot with TypeScript / ESM:
  - Auth middleware (DB lookup by `telegram_user_id`).
  - Role guard middleware (OWNER / MANAGER / OPERATOR).
  - pino logging.
  - Inline keyboards: main menu (per role), invoice review, item review,
    team, admin.
- Commands implemented end-to-end:
  - **Common**: `/start`, `/menu`, `/help`, `/me`, `/cancel`, `/list`,
    `/history`, `/clients`, `/new`.
  - **Operator**: `/help_manager`.
  - **Manager**: `/team`, `/team_list`, `/team_stats`, `/add_operator`,
    `/help_owner`.
  - **Owner**: `/admin`, `/add_manager`, `/all_users`, `/all_invoices`,
    `/broadcast`.
- `@grammyjs/conversations` flows for multi-step dialogs (new invoice,
  add operator, add manager, help request).
- Mock Sprint 2 API (`api.mock.ts`) returns canned data from TZ section 4.2
  and writes real rows into `invoices` so list/history work.
- Real `.xlsx` generation via `exceljs` on approve.
- Notifications service for reassignments and help requests.
- Dockerfile + `.dockerignore` for Railway/Fly deploy.
- Operator guide and architecture docs.

### Deferred to follow-up

- Redis-backed session for FSM recovery on restart.
- HMAC signing for callback_data.
- Webhook mode (currently long polling only).
- Real Sprint 2 API integration (currently mocked inside the bot).
