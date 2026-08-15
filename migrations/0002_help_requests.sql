-- Help requests: OPERATOR -> MANAGER or MANAGER -> OWNER.
CREATE TABLE help_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    to_user_id   UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    invoice_id   UUID,
    description  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED')),
    response     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at  TIMESTAMPTZ
);

CREATE INDEX idx_help_to_status ON help_requests(to_user_id, status);
CREATE INDEX idx_help_from      ON help_requests(from_user_id, created_at DESC);
