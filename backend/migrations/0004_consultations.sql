-- C3: consultations, vitals and addenda. Finalized records are immutable at the database level.

-- Escalation flag on appointments, set at booking from a small deterministic rule set.
ALTER TABLE appointments ADD COLUMN escalated boolean NOT NULL DEFAULT false;
ALTER TABLE appointments ADD COLUMN escalation_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE appointments ADD CONSTRAINT appointments_id_patient_doctor_uniq UNIQUE (id, patient_user_id, doctor_user_id);
CREATE INDEX appointments_escalated_idx ON appointments (doctor_user_id, escalated) WHERE escalated;

CREATE TABLE consultations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id        uuid NOT NULL UNIQUE,
  patient_user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  doctor_user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINALIZED')),
  chief_complaint       text CHECK (chief_complaint IS NULL OR char_length(chief_complaint) BETWEEN 3 AND 500),
  examination_notes     text CHECK (examination_notes IS NULL OR char_length(examination_notes) <= 4000),
  -- Free text only. No diagnosis code list is loaded, so no code is stored or implied.
  diagnosis_description text CHECK (diagnosis_description IS NULL OR char_length(diagnosis_description) BETWEEN 3 AND 500),
  severity              text CHECK (severity IS NULL OR severity IN ('MILD', 'MODERATE', 'SEVERE')),
  follow_up_on          date,
  finalized_at          timestamptz,
  finalized_by          uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- The consultation must belong to the same appointment, patient and doctor.
  CONSTRAINT consultations_appointment_fk FOREIGN KEY (appointment_id, patient_user_id, doctor_user_id)
    REFERENCES appointments (id, patient_user_id, doctor_user_id) ON DELETE RESTRICT,
  CONSTRAINT consultations_finalized_complete_chk CHECK (
    status = 'DRAFT'
    OR (finalized_at IS NOT NULL AND finalized_by IS NOT NULL AND chief_complaint IS NOT NULL
        AND diagnosis_description IS NOT NULL AND severity IS NOT NULL)
  )
);
CREATE INDEX consultations_patient_status_idx ON consultations (patient_user_id, status, finalized_at);
CREATE INDEX consultations_doctor_status_idx ON consultations (doctor_user_id, status);
CREATE TRIGGER consultations_set_updated_at BEFORE UPDATE ON consultations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION consultations_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consultations cannot be deleted';
  END IF;
  IF NEW.appointment_id <> OLD.appointment_id OR NEW.patient_user_id <> OLD.patient_user_id
     OR NEW.doctor_user_id <> OLD.doctor_user_id THEN
    RAISE EXCEPTION 'consultation ownership cannot change';
  END IF;
  IF OLD.status = 'FINALIZED' THEN
    RAISE EXCEPTION 'finalized consultations are immutable; add an addendum instead';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER consultations_guard_trg BEFORE UPDATE OR DELETE ON consultations
  FOR EACH ROW EXECUTE FUNCTION consultations_guard();

-- Vitals: one row per consultation, editable only while the consultation is a draft.
CREATE TABLE vitals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid NOT NULL UNIQUE REFERENCES consultations (id) ON DELETE RESTRICT,
  bp_systolic      smallint CHECK (bp_systolic BETWEEN 60 AND 260),
  bp_diastolic     smallint CHECK (bp_diastolic BETWEEN 30 AND 160),
  pulse            smallint CHECK (pulse BETWEEN 30 AND 230),
  temperature_c    numeric(4, 1) CHECK (temperature_c BETWEEN 30.0 AND 45.0),
  spo2             smallint CHECK (spo2 BETWEEN 50 AND 100),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vitals_bp_pair_chk CHECK ((bp_systolic IS NULL) = (bp_diastolic IS NULL)),
  CONSTRAINT vitals_bp_order_chk CHECK (bp_systolic IS NULL OR bp_systolic > bp_diastolic)
);
CREATE TRIGGER vitals_set_updated_at BEFORE UPDATE ON vitals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION vitals_guard() RETURNS trigger AS $fn$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM consultations WHERE id = COALESCE(NEW.consultation_id, OLD.consultation_id);
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'vitals can only change while the consultation is a draft';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER vitals_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON vitals
  FOR EACH ROW EXECUTE FUNCTION vitals_guard();

-- Addenda: append-only corrections to a finalized consultation.
CREATE TABLE consultation_addenda (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid NOT NULL REFERENCES consultations (id) ON DELETE RESTRICT,
  author_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  content          text NOT NULL CHECK (char_length(content) BETWEEN 3 AND 2000),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consultation_addenda_consultation_idx ON consultation_addenda (consultation_id, created_at);

CREATE FUNCTION consultation_addenda_guard() RETURNS trigger AS $fn$
DECLARE
  st text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'consultation addenda are append-only';
  END IF;
  SELECT status INTO st FROM consultations WHERE id = NEW.consultation_id;
  IF st IS DISTINCT FROM 'FINALIZED' THEN
    RAISE EXCEPTION 'addenda can only be added to a finalized consultation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER consultation_addenda_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON consultation_addenda
  FOR EACH ROW EXECUTE FUNCTION consultation_addenda_guard();
