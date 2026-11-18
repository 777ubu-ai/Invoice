CREATE TABLE IF NOT EXISTS packing_invoice_v2.invoice_drafts (
  id uuid PRIMARY KEY,
  created_by bigint NOT NULL CHECK (created_by > 0),
  invoice_number text NOT NULL CHECK (length(invoice_number) BETWEEN 1 AND 80),
  invoice_date date NOT NULL,
  seller text NOT NULL CHECK (length(seller) BETWEEN 1 AND 500),
  buyer text NOT NULL CHECK (length(buyer) BETWEEN 1 AND 500),
  currency text NOT NULL CHECK (currency IN ('USD','EUR','RUB','KZT','CNY')),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
  total_cents numeric(28,0) NOT NULL CHECK (total_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_drafts_created_by_idx ON packing_invoice_v2.invoice_drafts (created_by, created_at DESC);
