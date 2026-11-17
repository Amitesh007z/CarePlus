-- C1: identity, role profiles, server-side sessions, DB-backed rate limiting.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role              text NOT NULL CHECK (role IN ('PATIENT', 'DOCTOR', 'PHARMACIST', 'ADMIN')),
  email             citext NOT NULL UNIQUE,
  mobile            text UNIQUE CHECK (mobile IS NULL OR mobile ~ '^[6-9][0-9]{9}$'),
  password_hash     text NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE patient_profiles (
  user_id                  uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  full_name                text NOT NULL,
  dob                      date NOT NULL CHECK (dob <= CURRENT_DATE),
  gender                   text NOT NULL CHECK (gender IN ('MALE', 'FEMALE', 'OTHER')),
  blood_group              text NOT NULL CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'UNKNOWN')),
  address_line             text NOT NULL,
  city                     text NOT NULL,
  state                    text NOT NULL,
  pincode                  text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  emergency_contact_name   text NOT NULL,
  emergency_contact_phone  text NOT NULL CHECK (emergency_contact_phone ~ '^[6-9][0-9]{9}$'),
  consent_status           boolean NOT NULL DEFAULT false,
  consent_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER patient_profiles_set_updated_at BEFORE UPDATE ON patient_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE doctor_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  display_name     text NOT NULL,
  specialty        text NOT NULL,
  registration_no  text NOT NULL UNIQUE,
  experience_years integer NOT NULL CHECK (experience_years >= 0),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER doctor_profiles_set_updated_at BEFORE UPDATE ON doctor_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pharmacist_profiles (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER pharmacist_profiles_set_updated_at BEFORE UPDATE ON pharmacist_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE admin_profiles (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admin_profiles_set_updated_at BEFORE UPDATE ON admin_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Server-side sessions. Only the SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Fixed-window counters shared by every API replica (no Redis).
CREATE TABLE rate_limits (
  key            text PRIMARY KEY,
  hits           integer NOT NULL,
  window_ends_at timestamptz NOT NULL
);
