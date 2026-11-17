-- C7: every order transition records who acted (role and user), when, and why. Append-only.
CREATE TABLE order_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  action             text NOT NULL CHECK (action IN ('place', 'verify', 'pack', 'dispatch', 'deliver', 'reject', 'cancel')),
  from_status        text,
  to_status          text NOT NULL,
  actor_user_id      uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_role         text NOT NULL CHECK (actor_role IN ('PATIENT', 'PHARMACIST')),
  reason             text CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 300),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);
CREATE FUNCTION order_events_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'order events are append-only';
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER order_events_no_change BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_append_only();

-- Pharmacist verification can now record a refusal as well as a pass, with the reason.
ALTER TABLE prescription_verifications DROP CONSTRAINT prescription_verifications_result_check;
ALTER TABLE prescription_verifications ADD CONSTRAINT prescription_verifications_result_check CHECK (result IN ('PASSED', 'REJECTED'));
ALTER TABLE prescription_verifications ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 300);
