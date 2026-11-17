-- C8: AI care assistant interaction log. Privacy-conscious: a SHA-256 of the input, its length and
-- outcome metadata only. Full symptom text is never stored. Rows are append-only.

CREATE TABLE ai_interactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature               text NOT NULL CHECK (feature IN ('CARE', 'KNOWLEDGE')),
  user_id               uuid REFERENCES users (id) ON DELETE RESTRICT,
  role                  text NOT NULL CHECK (role IN ('PATIENT', 'DOCTOR', 'PHARMACIST', 'ADMIN')),
  input_sha256          text NOT NULL CHECK (char_length(input_sha256) = 64),
  input_chars           integer NOT NULL CHECK (input_chars >= 0),
  outcome               text NOT NULL CHECK (outcome IN (
                          'EMERGENCY', 'CLARIFICATION', 'ANSWERED', 'NO_MATCH', 'NOT_COVERED',
                          'FALLBACK', 'BLOCKED', 'RATE_LIMITED')),
  urgency               text CHECK (urgency IS NULL OR urgency IN ('SELF_CARE', 'SEE_DOCTOR', 'EMERGENCY')),
  confidence            text CHECK (confidence IS NULL OR confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  red_flag_labels       text[] NOT NULL DEFAULT '{}',
  candidate_count       integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  recommended_count     integer NOT NULL DEFAULT 0 CHECK (recommended_count >= 0),
  top_score             real,
  provider              text,
  model                 text,
  llm_attempts          integer NOT NULL DEFAULT 0 CHECK (llm_attempts >= 0),
  latency_ms            integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code            text,
  request_id            text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_interactions_user_idx ON ai_interactions (user_id, created_at DESC);
CREATE INDEX ai_interactions_outcome_idx ON ai_interactions (feature, outcome, created_at DESC);

-- Append-only, like the audit trail.
CREATE OR REPLACE FUNCTION ai_interactions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ai_interactions is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_interactions_no_update BEFORE UPDATE OR DELETE ON ai_interactions
  FOR EACH ROW EXECUTE FUNCTION ai_interactions_immutable();
