-- Bot conversation state for the webhook bot. Tracks per-user FSM state
-- between updates (Edge Functions are stateless).
CREATE TABLE bot_session (
    telegram_user_id BIGINT PRIMARY KEY,
    state            TEXT NOT NULL,
    context          JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_bot_session_updated ON bot_session(updated_at);
