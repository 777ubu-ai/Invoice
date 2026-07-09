-- Precedent-based learning: every approved (product_name → tnved_code) pair goes
-- here. Classifier queries this table before each LLM call and uses matches as
-- few-shot hints. Broker gets colour-coded highlights in xlsx: green when a
-- code was applied ≥N times, yellow when it's a similar-item match, white when
-- brand-new.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.tnved_precedents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_name_normalized TEXT NOT NULL,
  tnved_code TEXT NOT NULL,
  tnved_description TEXT,
  duty_rate NUMERIC,
  first_seen_invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  last_used_invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES public.telegram_users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  usage_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_name, product_name_normalized, tnved_code)
);

CREATE INDEX IF NOT EXISTS idx_precedents_name_trgm
  ON public.tnved_precedents
  USING gin (product_name_normalized gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_precedents_client_code
  ON public.tnved_precedents (client_name, tnved_code);

CREATE INDEX IF NOT EXISTS idx_precedents_last_used
  ON public.tnved_precedents (client_name, last_used_at DESC);

COMMENT ON TABLE public.tnved_precedents IS
  'Per-client whitelist of approved (product_name, tnved_code) pairs. Classifier consults this before each LLM call; matches surface as green/yellow highlights in the final xlsx.';
