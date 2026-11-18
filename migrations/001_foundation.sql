-- Fresh namespace; deliberately no DROP, DELETE, or legacy table changes.
CREATE SCHEMA IF NOT EXISTS packing_invoice_v2;

CREATE TABLE IF NOT EXISTS packing_invoice_v2.users (
  telegram_id bigint PRIMARY KEY CHECK (telegram_id > 0),
  roles text[] NOT NULL CHECK (
    cardinality(roles) > 0 AND
    roles <@ ARRAY['owner', 'packing', 'reviewer', 'invoice', 'accountant']::text[] AND
    array_position(roles, NULL) IS NULL
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packing_invoice_v2.role_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_id bigint NOT NULL,
  previous_roles text[],
  new_roles text[] NOT NULL,
  actor text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
