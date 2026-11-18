CREATE TABLE IF NOT EXISTS packing_invoice_v2.packing_jobs (
  id uuid PRIMARY KEY,
  created_by bigint NOT NULL CHECK (created_by > 0),
  filename text NOT NULL,
  source_file bytea NOT NULL,
  buyer_details jsonb NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('REVIEW','APPROVED','FAILED','CANCELED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS packing_jobs_owner_idx ON packing_invoice_v2.packing_jobs (created_by,created_at DESC);
