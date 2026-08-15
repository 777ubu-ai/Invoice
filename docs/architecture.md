# Architecture — Sprint 3

## Components

```
Telegram users
      │
      ▼
┌─────────────────────────┐
│   grammY bot            │   bot/src/main.ts
│   (long polling)        │
│                         │
│ ├ session (in-memory)   │
│ ├ /cancel preempt       │
│ ├ conversations plugin  │
│ ├ logging               │
│ ├ auth (DB lookup)      │
│ ├ commands              │
│ └ callbacks composer    │
└──────────┬──────────────┘
           │ Supabase JS client
           ▼
   ┌───────────────────┐
   │ Supabase Postgres │
   │ telegram_users    │
   │ help_requests     │
   │ audit_log         │
   │ invoices          │
   └───────────────────┘
           ▲
           │
   ┌──────────────────┐
   │ api.ts (factory) │
   │  └ MockApiClient │  ← simulates Sprint 2 API
   └──────────────────┘
```

## Roles

```
OWNER
 └── MANAGER (team)
       └── OPERATOR (clients)
```

Enforced in code via `requireRole()` middleware and database constraints
(`idx_tguser_one_owner` unique index).

## Message flow

Every update passes through:

1. `session` — loads/persists per-user data (used by conversations).
2. Pre-conversation cancel — clears state on `/cancel`.
3. `conversations()` — resumes an active multi-step dialog if any.
4. `logging` — structured pino log line per update.
5. `auth` — DB lookup by `telegram_user_id`, attaches `ctx.dbUser`.
6. Command handler / callback composer.

## Conversations

Multi-step dialogs are isolated into `@grammyjs/conversations` v1 generators:

- `newInvoice` — client → file → mode → value → polling → review.
- `addOperator` — username → name → clients.
- `addManager` — username → name → team name.
- `helpRequest` — optional invoice → description → notify recipient.

## Sprint 2 API surface

Encapsulated in `bot/src/services/api.ts` with the `ApiClient` interface.
A `MockApiClient` provides canned data (TZ section 4.2 example) that writes
real rows into the `invoices` table so `/list`, `/history`, `/team_list`,
`/all_invoices` work end-to-end.

When the real Sprint 2 API ships, drop in an `HttpApiClient` and switch
in `api.ts` based on env. No other code in the bot needs to change.

## Persistence note

For MVP, session and conversation state live in memory. Restart of the bot
process drops in-progress dialogs. Switch to Redis (`@grammyjs/storage-redis`)
when uptime SLA requires it (TZ acceptance criterion 9.2).
