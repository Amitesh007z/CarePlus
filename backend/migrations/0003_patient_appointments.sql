-- C2: consent states, structured health context, doctor availability, slots, appointments, audit trail.

-- 1. Consent. Withdrawal is an explicit state, and a missing grant is never treated as consent.
ALTER TABLE patient_profiles ADD COLUMN consent_withdrawn_at timestamptz;
ALTER TABLE patient_profiles ADD CONSTRAINT patient_consent_state_chk CHECK (
  consent_status = false OR (consent_at IS NOT NULL AND consent_withdrawn_at IS NULL)
);

CREATE INDEX doctor_profiles_directory_idx ON doctor_profiles (active, specialty);

-- 2. Structured health context. Allergies and conditions are rows, not free text.
CREATE TABLE health_info (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  type             text NOT NULL CHECK (type IN ('ALLERGY', 'CONDITION')),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  allergy_class    text CHECK (allergy_class IS NULL OR char_length(allergy_class) BETWEEN 2 AND 60),
  severity         text CHECK (severity IS NULL OR severity IN ('MILD', 'MODERATE', 'SEVERE')),
  noted_on         date NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  notes            text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_info_class_only_for_allergy_chk CHECK (type = 'ALLERGY' OR allergy_class IS NULL)
);
CREATE UNIQUE INDEX health_info_active_name_uniq ON health_info (patient_user_id, type, lower(name)) WHERE active;
CREATE INDEX health_info_patient_idx ON health_info (patient_user_id, type, active);
CREATE TRIGGER health_info_set_updated_at BEFORE UPDATE ON health_info
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE patient_medications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  medication_name  text NOT NULL CHECK (char_length(medication_name) BETWEEN 2 AND 120),
  dose             text CHECK (dose IS NULL OR char_length(dose) <= 60),
  frequency        text CHECK (frequency IS NULL OR char_length(frequency) <= 60),
  started_on       date NOT NULL,
  ended_on         date,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_medications_dates_chk CHECK (ended_on IS NULL OR ended_on >= started_on),
  CONSTRAINT patient_medications_stopped_has_end_chk CHECK (active OR ended_on IS NOT NULL)
);
CREATE INDEX patient_medications_patient_idx ON patient_medications (patient_user_id, active);
CREATE TRIGGER patient_medications_set_updated_at BEFORE UPDATE ON patient_medications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Doctor availability rules (IST wall clock) and materialised bookable slots.
CREATE TABLE doctor_availability (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  slot_minutes     smallint NOT NULL CHECK (slot_minutes IN (15, 20, 30, 60)),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doctor_availability_window_chk CHECK (end_time > start_time)
);
CREATE INDEX doctor_availability_doctor_idx ON doctor_availability (doctor_user_id) WHERE active;
CREATE TRIGGER doctor_availability_set_updated_at BEFORE UPDATE ON doctor_availability
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE appointment_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DISABLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_slots_window_chk CHECK (ends_at > starts_at),
  CONSTRAINT appointment_slots_doctor_start_uniq UNIQUE (doctor_user_id, starts_at),
  CONSTRAINT appointment_slots_id_doctor_uniq UNIQUE (id, doctor_user_id)
);
CREATE TRIGGER appointment_slots_set_updated_at BEFORE UPDATE ON appointment_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. Appointments. A slot can hold only one active booking; the composite FK keeps slot and doctor consistent.
CREATE TABLE appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  doctor_user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  slot_id            uuid NOT NULL,
  status             text NOT NULL CHECK (status IN ('REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED')),
  chief_complaint    text NOT NULL CHECK (char_length(chief_complaint) BETWEEN 3 AND 200),
  symptoms           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(symptoms) <= 15),
  duration_days      integer NOT NULL CHECK (duration_days BETWEEN 0 AND 3650),
  severity           text NOT NULL CHECK (severity IN ('MILD', 'MODERATE', 'SEVERE')),
  additional_notes   text CHECK (additional_notes IS NULL OR char_length(additional_notes) <= 1000),
  booking_fee_inr    numeric(10, 2) NOT NULL DEFAULT 100.00 CHECK (booking_fee_inr >= 0),
  fee_status         text NOT NULL DEFAULT 'SIMULATED_HELD'
                     CHECK (fee_status IN ('SIMULATED_HELD', 'SIMULATED_RELEASED', 'SIMULATED_FORFEITED')),
  cancelled_at       timestamptz,
  cancelled_by       text CHECK (cancelled_by IS NULL OR cancelled_by IN ('PATIENT', 'DOCTOR')),
  cancel_reason      text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 300),
  rescheduled_count  integer NOT NULL DEFAULT 0 CHECK (rescheduled_count >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_slot_doctor_fk FOREIGN KEY (slot_id, doctor_user_id)
    REFERENCES appointment_slots (id, doctor_user_id) ON DELETE RESTRICT,
  CONSTRAINT appointments_cancel_state_chk CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX appointments_one_active_per_slot ON appointments (slot_id)
  WHERE status IN ('REQUESTED', 'CONFIRMED', 'COMPLETED');
CREATE INDEX appointments_patient_status_idx ON appointments (patient_user_id, status, created_at);
CREATE INDEX appointments_doctor_status_idx ON appointments (doctor_user_id, status);
CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. Append-only audit trail. No FK on actor: audit records must outlive accounts.
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  actor_user_id  uuid,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  before_json    jsonb,
  after_json     jsonb,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at);

CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
