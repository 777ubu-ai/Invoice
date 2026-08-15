-- Minimal invoices table. Sprint 2 will extend this with classification fields.
-- Created here so the bot can store invoices via api-mock.
CREATE TABLE invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number      TEXT UNIQUE,
    client_name         TEXT NOT NULL,

    status              TEXT NOT NULL DEFAULT 'CREATED'
                          CHECK (status IN ('CREATED', 'UPLOADED', 'PROCESSING',
                                            'REVIEW', 'APPROVED', 'FAILED', 'CANCELED')),

    price_mode          TEXT CHECK (price_mode IN ('TARGET_PAYMENTS', 'PRICE_PER_KG',
                                                    'CLIENT_PRICELIST', 'KGD_INDICATIVE')),
    price_value         NUMERIC(14,2),

    source_file_url     TEXT,
    result_file_url     TEXT,

    summary             JSONB,
    items               JSONB,

    created_via         TEXT NOT NULL DEFAULT 'telegram_bot',
    telegram_chat_id    BIGINT,
    telegram_message_id BIGINT,

    created_by          UUID REFERENCES telegram_users(id) ON DELETE SET NULL,
    assigned_to         UUID REFERENCES telegram_users(id) ON DELETE SET NULL,
    reassigned_from     UUID REFERENCES telegram_users(id) ON DELETE SET NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at         TIMESTAMPTZ
);

CREATE INDEX idx_invoices_assigned ON invoices(assigned_to, status);
CREATE INDEX idx_invoices_status   ON invoices(status, created_at DESC);
CREATE INDEX idx_invoices_client   ON invoices(client_name);

-- Foreign key from help_requests now that invoices exists.
ALTER TABLE help_requests
    ADD CONSTRAINT fk_help_invoice
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
