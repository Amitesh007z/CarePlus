-- C4: medicine catalogue, prescriptions and prescription items. Issued prescriptions are immutable in the database.

CREATE TABLE medicines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                text NOT NULL UNIQUE CHECK (char_length(sku) BETWEEN 3 AND 32),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  strength           text CHECK (strength IS NULL OR char_length(strength) <= 40),
  form               text NOT NULL CHECK (char_length(form) BETWEEN 2 AND 40),
  category           text NOT NULL CHECK (char_length(category) BETWEEN 2 AND 40),
  pack_size          text NOT NULL CHECK (char_length(pack_size) BETWEEN 2 AND 60),
  price_inr          numeric(10, 2) NOT NULL CHECK (price_inr >= 0),
  stock_qty          integer NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  rx_required        boolean NOT NULL,
  allergy_class      text CHECK (allergy_class IS NULL OR char_length(allergy_class) BETWEEN 2 AND 60),
  description        text,
  manufacturer       text,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medicines_active_name_idx ON medicines (active, name);
CREATE TRIGGER medicines_set_updated_at BEFORE UPDATE ON medicines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE SEQUENCE prescription_number_seq START 1;

ALTER TABLE consultations ADD CONSTRAINT consultations_id_patient_doctor_uniq UNIQUE (id, patient_user_id, doctor_user_id);

CREATE TABLE prescriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rx_number                 text UNIQUE,
  consultation_id           uuid NOT NULL,
  patient_user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  doctor_user_id            uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status                    text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'FULFILLED', 'SUPERSEDED')),
  advice                    text CHECK (advice IS NULL OR char_length(advice) <= 500),
  issued_at                 timestamptz,
  issued_by                 uuid,
  valid_till                date,
  fulfilled_at              timestamptz,
  replaces_prescription_id  uuid REFERENCES prescriptions (id) ON DELETE RESTRICT,
  superseded_by_id          uuid REFERENCES prescriptions (id) ON DELETE RESTRICT,
  allergy_check             jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Bound to the consultation's patient and doctor: a prescription cannot point at someone else's record.
  CONSTRAINT prescriptions_consultation_fk FOREIGN KEY (consultation_id, patient_user_id, doctor_user_id)
    REFERENCES consultations (id, patient_user_id, doctor_user_id) ON DELETE RESTRICT,
  CONSTRAINT prescriptions_issued_complete_chk CHECK (
    status = 'DRAFT' OR (rx_number IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL
      AND valid_till IS NOT NULL AND allergy_check IS NOT NULL)
  ),
  CONSTRAINT prescriptions_fulfilled_chk CHECK (status <> 'FULFILLED' OR fulfilled_at IS NOT NULL),
  CONSTRAINT prescriptions_superseded_chk CHECK (status <> 'SUPERSEDED' OR superseded_by_id IS NOT NULL)
);
CREATE INDEX prescriptions_patient_status_idx ON prescriptions (patient_user_id, status, issued_at);
CREATE INDEX prescriptions_doctor_idx ON prescriptions (doctor_user_id, created_at);
CREATE INDEX prescriptions_consultation_idx ON prescriptions (consultation_id);
-- A correction can be issued only once for any original prescription.
CREATE UNIQUE INDEX prescriptions_one_replacement_idx ON prescriptions (replaces_prescription_id)
  WHERE replaces_prescription_id IS NOT NULL;
CREATE TRIGGER prescriptions_set_updated_at BEFORE UPDATE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE prescription_items (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id           uuid NOT NULL REFERENCES prescriptions (id) ON DELETE RESTRICT,
  line_no                   smallint NOT NULL CHECK (line_no BETWEEN 1 AND 30),
  medicine_id               uuid NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  medicine_name_snapshot    text NOT NULL,
  strength_snapshot         text,
  allergy_class_snapshot    text,
  dose                      text NOT NULL CHECK (char_length(dose) BETWEEN 1 AND 60),
  frequency                 text NOT NULL CHECK (char_length(frequency) BETWEEN 1 AND 60),
  duration_days             integer NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
  instructions              text CHECK (instructions IS NULL OR char_length(instructions) <= 300),
  quantity                  integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescription_items_line_uniq UNIQUE (prescription_id, line_no),
  CONSTRAINT prescription_items_medicine_uniq UNIQUE (prescription_id, medicine_id)
);
CREATE TRIGGER prescription_items_set_updated_at BEFORE UPDATE ON prescription_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Lifecycle guard. Drafts are freely editable. Issued records accept only the lifecycle transitions
-- ISSUED -> FULFILLED and ISSUED -> SUPERSEDED, and their clinical content may never change.
CREATE FUNCTION prescriptions_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'issued prescriptions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF NOT (OLD.status = 'ISSUED' AND NEW.status IN ('FULFILLED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'issued prescriptions are immutable; create a replacement instead';
  END IF;
  IF NEW.rx_number IS DISTINCT FROM OLD.rx_number OR NEW.consultation_id <> OLD.consultation_id
     OR NEW.patient_user_id <> OLD.patient_user_id OR NEW.doctor_user_id <> OLD.doctor_user_id
     OR NEW.advice IS DISTINCT FROM OLD.advice OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.valid_till IS DISTINCT FROM OLD.valid_till
     OR NEW.allergy_check IS DISTINCT FROM OLD.allergy_check
     OR NEW.replaces_prescription_id IS DISTINCT FROM OLD.replaces_prescription_id THEN
    RAISE EXCEPTION 'issued prescription content cannot change';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER prescriptions_guard_trg BEFORE UPDATE OR DELETE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION prescriptions_guard();

CREATE FUNCTION prescription_items_guard() RETURNS trigger AS $fn$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM prescriptions WHERE id = COALESCE(NEW.prescription_id, OLD.prescription_id);
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'prescription items can only change while the prescription is a draft';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER prescription_items_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON prescription_items
  FOR EACH ROW EXECUTE FUNCTION prescription_items_guard();
