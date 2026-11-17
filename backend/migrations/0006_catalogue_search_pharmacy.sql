-- C5: catalogue search sync (transactional outbox), pharmacy fulfilment, append-only stock ledger,
-- drug interaction rules and the 90-day chronic validity gate. PostgreSQL stays the source of truth.

-- Medicines: a therapeutic category replaces the Rx/OTC placeholder (Rx/OTC is rx_required), and the
-- chronic flag is a curated, admin-set eligibility. Nothing is eligible until someone sets it.
ALTER TABLE medicines ADD COLUMN chronic_eligible boolean NOT NULL DEFAULT false;
UPDATE medicines SET category = CASE sku
    WHEN 'MED-1001' THEN 'Antibiotic'
    WHEN 'MED-1002' THEN 'Antibiotic'
    WHEN 'MED-1003' THEN 'Respiratory'
    WHEN 'MED-1004' THEN 'Respiratory'
    WHEN 'MED-1005' THEN 'Cough and cold'
    WHEN 'MED-1006' THEN 'Pain and fever'
    WHEN 'MED-1007' THEN 'Allergy'
    WHEN 'MED-1008' THEN 'Vitamins'
  END
 WHERE sku IN ('MED-1001','MED-1002','MED-1003','MED-1004','MED-1005','MED-1006','MED-1007','MED-1008')
   AND category IN ('Rx', 'OTC');
CREATE INDEX medicines_active_category_idx ON medicines (category) WHERE active;
CREATE INDEX medicines_active_price_idx ON medicines (price_inr) WHERE active;

-- Transactional outbox. A row means "make the search index match the database for this object".
-- The worker reads the current row when it processes the job, so duplicate jobs are harmless.
CREATE TABLE search_sync_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  index_name       text NOT NULL CHECK (index_name IN ('carepulse_medicines', 'carepulse_doctors')),
  object_id        uuid NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'SUPERSEDED', 'DEAD')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       text CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- At most one waiting job per object: a burst of edits collapses into one sync.
CREATE UNIQUE INDEX search_sync_jobs_pending_uniq ON search_sync_jobs (index_name, object_id) WHERE status = 'PENDING';
CREATE INDEX search_sync_jobs_due_idx ON search_sync_jobs (next_attempt_at) WHERE status IN ('PENDING', 'PROCESSING');
CREATE INDEX search_sync_jobs_status_idx ON search_sync_jobs (status, updated_at);
CREATE TRIGGER search_sync_jobs_set_updated_at BEFORE UPDATE ON search_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pharmacy fulfilment: one open request per prescription. A rejected request can be re-submitted.
CREATE TABLE fulfilments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id     uuid NOT NULL REFERENCES prescriptions (id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'QUEUED'
                      CHECK (status IN ('QUEUED', 'VERIFIED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REJECTED')),
  pharmacist_user_id  uuid REFERENCES users (id) ON DELETE RESTRICT,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  verified_at         timestamptz,
  packed_at           timestamptz,
  dispatched_at       timestamptz,
  delivered_at        timestamptz,
  rejected_at         timestamptz,
  rejection_reason    text CHECK (rejection_reason IS NULL OR char_length(rejection_reason) BETWEEN 3 AND 300),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fulfilments_rejection_reason_required CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL)
);
CREATE UNIQUE INDEX fulfilments_one_open_idx ON fulfilments (prescription_id) WHERE status <> 'REJECTED';
CREATE INDEX fulfilments_status_idx ON fulfilments (status, requested_at);
CREATE TRIGGER fulfilments_set_updated_at BEFORE UPDATE ON fulfilments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only stock ledger. medicines.stock_qty is the running balance; each change is a row here.
CREATE TABLE stock_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id     uuid NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  delta           integer NOT NULL CHECK (delta <> 0),
  balance_after   integer NOT NULL CHECK (balance_after >= 0),
  reason          text NOT NULL CHECK (reason IN ('ADJUSTMENT', 'DISPENSE')),
  note            text CHECK (note IS NULL OR char_length(note) <= 200),
  fulfilment_id   uuid REFERENCES fulfilments (id) ON DELETE RESTRICT,
  actor_user_id   uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_dispense_has_fulfilment CHECK (reason <> 'DISPENSE' OR fulfilment_id IS NOT NULL)
);
CREATE INDEX stock_movements_medicine_idx ON stock_movements (medicine_id, created_at DESC);
CREATE FUNCTION stock_movements_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'stock movements are append-only';
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();

-- Drug interaction rules. Curated only: no rule is invented here. source_reference is mandatory.
CREATE TABLE drug_interactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_a_id     uuid NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  medicine_b_id     uuid NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  severity          text NOT NULL CHECK (severity IN ('MAJOR', 'MODERATE', 'MINOR')),
  effect            text NOT NULL CHECK (char_length(effect) BETWEEN 5 AND 300),
  source_reference  text NOT NULL CHECK (char_length(source_reference) BETWEEN 3 AND 200),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drug_interactions_pair_order CHECK (medicine_a_id < medicine_b_id),
  CONSTRAINT drug_interactions_pair_uniq UNIQUE (medicine_a_id, medicine_b_id)
);
CREATE TRIGGER drug_interactions_set_updated_at BEFORE UPDATE ON drug_interactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Prescriptions: validity (30 days, or 90 only for chronic-eligible medicines) and the interaction check at issue.
ALTER TABLE prescriptions ADD COLUMN validity_days smallint NOT NULL DEFAULT 30 CHECK (validity_days IN (30, 90));
ALTER TABLE prescriptions ADD COLUMN interaction_check jsonb;

-- Replace the lifecycle guard so the new issued-record fields are immutable too.
CREATE OR REPLACE FUNCTION prescriptions_guard() RETURNS trigger AS $fn$
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
     OR NEW.interaction_check IS DISTINCT FROM OLD.interaction_check
     OR NEW.validity_days IS DISTINCT FROM OLD.validity_days
     OR NEW.replaces_prescription_id IS DISTINCT FROM OLD.replaces_prescription_id THEN
    RAISE EXCEPTION 'issued prescription content cannot change';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
