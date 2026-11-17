-- Foundation: extensions and shared helpers only. Domain tables arrive with their checkpoints.
-- pgvector ("vector") is enabled later, in the AI-B checkpoint.
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email/mobile columns

-- Reusable trigger: CREATE TRIGGER ... BEFORE UPDATE ... EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
