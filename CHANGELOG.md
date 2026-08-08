# Changelog

## Unreleased

### Added

- **ТН ВЭД ЕАЭС validation**: классификатор проверяет каждый 10-значный код
  против локального справочника (`bot/data/tnved-eaeu.csv`, 28k+ кодов).
  Невалидные коды уходят на автоматический retry с подсказкой реальных
  кодов из той же товарной подгруппы; Маке hard-fail'ит инвойс если код
  так и не удалось исправить.
- **База образцов (precedent learning)**: таблица `tnved_precedents` в
  Supabase — брокер вручную загружает проверенные инвойсы (xlsx или zip с
  папкой), классификатор при разборе новых позиций ищет похожие товары
  этого же клиента (pg_trgm fuzzy match) и получает код как подсказку.
  Совпадения подсвечиваются в итоговом xlsx: зелёным (точное совпадение,
  код уже применялся) или жёлтым (похожий товар). База наполняется
  **только** вручную через «📚 Образцы кодов» — одобренные ботом инвойсы
  туда не попадают автоматически, чтобы случайная ошибка брокера не стала
  «правилом».
- Загрузка образцов принимает как одиночный `.xlsx`, так и `.zip` с папкой
  инвойсов (использован `adm-zip`); выбор клиента можно сделать до или
  после отправки файла — бот сам подстроится под порядок действий.
- **Self-hosted деплой**: `docker-compose.yml` с Postgres 16 + PostgREST +
  бот, полная инструкция в `MIGRATION.md` для переезда с Railway/Supabase
  на собственный VPS без изменений в коде (PostgREST держит совместимость
  с supabase-js).
- Комбинированный контейнер: локальный `telegram-bot-api` сервер +
  Node-бот в одном образе — снимает лимит Telegram в 20 МБ на файл,
  позволяет принимать packing list'ы до 2 ГБ.

### Fixed

- Кнопки выбора клиента в «Образцах» больше не падают с
  `BUTTON_DATA_INVALID` — callback_data теперь короткий индекс вместо
  URL-encoded кириллического имени (Telegram ограничивает callback_data
  64 байтами).
- Убрана эвристика «подозрительных суффиксов» ТН ВЭД, которая ложно
  флагала реальные коды (например, `8418102001` для комбинированных
  холодильников) — теперь единственный источник истины — валидация по
  справочнику ЕАЭС.
- Бот не падает при старте если файл справочника ТН ВЭД отсутствует —
  деградирует до пропуска валидации с явным предупреждением в логах.

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
