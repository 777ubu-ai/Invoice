-- Audit log: every user action.
CREATE TABLE audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES telegram_users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     UUID,
    payload       JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor  ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);
