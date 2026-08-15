-- Telegram users table: stores OWNER, MANAGER, OPERATOR accounts.
CREATE TABLE telegram_users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_user_id    BIGINT UNIQUE NOT NULL,
    telegram_username   TEXT,
    full_name           TEXT NOT NULL,

    role                TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'OPERATOR')),
    team_name           TEXT,
    manager_id          UUID REFERENCES telegram_users(id) ON DELETE SET NULL,

    client_access       JSONB NOT NULL DEFAULT '[]'::jsonb,

    added_by            UUID REFERENCES telegram_users(id) ON DELETE SET NULL,
    added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active         TIMESTAMPTZ,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    language            TEXT NOT NULL DEFAULT 'ru',

    invoices_total      INTEGER NOT NULL DEFAULT 0,
    invoices_this_month INTEGER NOT NULL DEFAULT 0,
    avg_confidence      NUMERIC(5,2),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tguser_tg       ON telegram_users(telegram_user_id);
CREATE INDEX idx_tguser_role     ON telegram_users(role);
CREATE INDEX idx_tguser_manager  ON telegram_users(manager_id);
CREATE INDEX idx_tguser_active   ON telegram_users(is_active) WHERE is_active = TRUE;

-- Only one OWNER allowed.
CREATE UNIQUE INDEX idx_tguser_one_owner ON telegram_users(role) WHERE role = 'OWNER';
