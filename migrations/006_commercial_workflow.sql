-- Additive namespace: legacy invoices and files remain untouched.
CREATE TABLE IF NOT EXISTS packing_invoice_v2.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  details jsonb NOT NULL,
  created_by bigint NOT NULL CHECK (created_by > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_name_idx ON packing_invoice_v2.companies (lower(name));
CREATE TABLE IF NOT EXISTS packing_invoice_v2.commercial_invoices (
  id uuid PRIMARY KEY,
  created_by bigint NOT NULL CHECK (created_by > 0),
  payload jsonb NOT NULL,
  source_file bytea,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_owner_idx ON packing_invoice_v2.commercial_invoices(created_by,updated_at DESC);
CREATE TABLE IF NOT EXISTS packing_invoice_v2.commercial_versions (
  invoice_id uuid NOT NULL REFERENCES packing_invoice_v2.commercial_invoices(id),
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  xlsx bytea NOT NULL,
  source_file bytea NOT NULL,
  created_by bigint NOT NULL CHECK (created_by > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id,version)
);
CREATE TABLE IF NOT EXISTS packing_invoice_v2.commercial_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES packing_invoice_v2.commercial_invoices(id),
  revision bigint NOT NULL,
  actor bigint NOT NULL,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS packing_invoice_v2.commercial_active (
  telegram_id bigint PRIMARY KEY CHECK (telegram_id > 0),
  invoice_id uuid NOT NULL REFERENCES packing_invoice_v2.commercial_invoices(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS packing_invoice_v2.commercial_source_files (
  invoice_id uuid NOT NULL REFERENCES packing_invoice_v2.commercial_invoices(id),
  revision bigint NOT NULL,
  filename text NOT NULL,
  contents bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(invoice_id,revision)
);
CREATE TABLE IF NOT EXISTS packing_invoice_v2.company_forms (
  telegram_id bigint PRIMARY KEY CHECK (telegram_id > 0),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS packing_invoice_v2.company_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL,
  actor bigint NOT NULL,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
