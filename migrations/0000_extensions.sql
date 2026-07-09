-- Bootstrap extensions the bot relies on. Run FIRST because subsequent
-- migrations call gen_random_uuid() and use pg_trgm indexes.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
