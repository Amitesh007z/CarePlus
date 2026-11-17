-- C6: carts, checkout, orders with immutable snapshots, simulated payments, pharmacist verification records,
-- durable order notifications and delivery addresses. Money is numeric(10,2); calculations use integer paise in code.

CREATE TABLE patient_addresses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  label              text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 30),
  line               text NOT NULL CHECK (char_length(line) BETWEEN 5 AND 200),
  city               text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 60),
  state              text NOT NULL CHECK (char_length(state) BETWEEN 2 AND 60),
  pincode            text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX patient_addresses_one_default_idx ON patient_addresses (patient_user_id) WHERE is_default;
CREATE INDEX patient_addresses_patient_idx ON patient_addresses (patient_user_id, created_at);
CREATE TRIGGER patient_addresses_set_updated_at BEFORE UPDATE ON patient_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE carts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id    uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER carts_set_updated_at BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- prescription_id is set for lines that came from a prescription. Those lines are exact and locked in the cart.
CREATE TABLE cart_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id            uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  medicine_id        uuid NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  quantity           integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  prescription_id    uuid REFERENCES prescriptions (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_items_cart_medicine_uniq UNIQUE (cart_id, medicine_id)
);
CREATE INDEX cart_items_prescription_idx ON cart_items (cart_id, prescription_id);
CREATE TRIGGER cart_items_set_updated_at BEFORE UPDATE ON cart_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE SEQUENCE order_number_seq START 1;

CREATE TABLE orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number          text NOT NULL UNIQUE CHECK (order_number ~ '^ORD-[0-9]{4}-[0-9]{6}$'),
  patient_user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  idempotency_key       text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 64),
  request_hash          text NOT NULL CHECK (char_length(request_hash) = 64),
  status                text NOT NULL DEFAULT 'PLACED'
                        CHECK (status IN ('PLACED', 'VERIFIED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REJECTED', 'CANCELLED')),
  is_prescription_order boolean NOT NULL,
  subtotal_inr          numeric(10, 2) NOT NULL CHECK (subtotal_inr >= 0),
  discount_inr          numeric(10, 2) NOT NULL CHECK (discount_inr >= 0),
  delivery_fee_inr      numeric(10, 2) NOT NULL CHECK (delivery_fee_inr >= 0),
  total_inr             numeric(10, 2) NOT NULL CHECK (total_inr >= 0),
  payment_method        text NOT NULL CHECK (payment_method IN ('MOCK_CARD', 'COD')),
  address_snapshot      jsonb NOT NULL,
  stock_restored        boolean NOT NULL DEFAULT false,
  status_reason         text CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 3 AND 300),
  placed_at             timestamptz NOT NULL DEFAULT now(),
  verified_at           timestamptz,
  packed_at             timestamptz,
  dispatched_at         timestamptz,
  delivered_at          timestamptz,
  rejected_at           timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_idempotency_uniq UNIQUE (patient_user_id, idempotency_key),
  CONSTRAINT orders_total_adds_up CHECK (total_inr = subtotal_inr - discount_inr + delivery_fee_inr),
  CONSTRAINT orders_rejection_reason CHECK (status <> 'REJECTED' OR status_reason IS NOT NULL)
);
CREATE INDEX orders_patient_placed_idx ON orders (patient_user_id, placed_at DESC);
CREATE INDEX orders_status_placed_idx ON orders (status, placed_at);
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Only lifecycle columns may change on an order. Money, address, identity and idempotency fields are frozen.
CREATE FUNCTION orders_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders cannot be deleted';
  END IF;
  IF NEW.order_number IS DISTINCT FROM OLD.order_number OR NEW.patient_user_id <> OLD.patient_user_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_hash <> OLD.request_hash
     OR NEW.is_prescription_order <> OLD.is_prescription_order
     OR NEW.subtotal_inr <> OLD.subtotal_inr OR NEW.discount_inr <> OLD.discount_inr
     OR NEW.delivery_fee_inr <> OLD.delivery_fee_inr OR NEW.total_inr <> OLD.total_inr
     OR NEW.payment_method <> OLD.payment_method OR NEW.address_snapshot IS DISTINCT FROM OLD.address_snapshot
     OR NEW.placed_at <> OLD.placed_at THEN
    RAISE EXCEPTION 'order content is immutable';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER orders_guard_trg BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard();

-- Immutable order item snapshots: name, SKU, strength, pack and unit price are copied at placement.
CREATE TABLE order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  line_no               smallint NOT NULL CHECK (line_no BETWEEN 1 AND 100),
  medicine_id           uuid NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  sku_snapshot          text NOT NULL,
  name_snapshot         text NOT NULL,
  strength_snapshot     text,
  pack_size_snapshot    text NOT NULL,
  rx_required_snapshot  boolean NOT NULL,
  unit_price_inr        numeric(10, 2) NOT NULL CHECK (unit_price_inr >= 0),
  quantity              integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  line_total_inr        numeric(10, 2) NOT NULL CHECK (line_total_inr >= 0),
  prescription_id       uuid REFERENCES prescriptions (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_line_uniq UNIQUE (order_id, line_no),
  CONSTRAINT order_items_medicine_uniq UNIQUE (order_id, medicine_id),
  CONSTRAINT order_items_line_total CHECK (line_total_inr = unit_price_inr * quantity)
);
CREATE FUNCTION order_items_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'order item snapshots are immutable';
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER order_items_no_change BEFORE UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_append_only();

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL UNIQUE REFERENCES orders (id) ON DELETE RESTRICT,
  method             text NOT NULL CHECK (method IN ('MOCK_CARD', 'COD')),
  status             text NOT NULL CHECK (status IN ('SUCCEEDED', 'PENDING', 'COLLECTED', 'REFUNDED')),
  amount_inr         numeric(10, 2) NOT NULL CHECK (amount_inr > 0),
  gateway_reference  text NOT NULL UNIQUE CHECK (char_length(gateway_reference) BETWEEN 8 AND 64),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pharmacist checks at verification time. Append-only: one row per prescription per verification.
CREATE TABLE prescription_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  prescription_id    uuid NOT NULL REFERENCES prescriptions (id) ON DELETE RESTRICT,
  verifier_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  result             text NOT NULL CHECK (result IN ('PASSED')),
  checks             jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION prescription_verifications_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'prescription verifications are append-only';
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER prescription_verifications_no_change BEFORE UPDATE OR DELETE ON prescription_verifications
  FOR EACH ROW EXECUTE FUNCTION prescription_verifications_append_only();

-- Durable notifications: written in the order transaction, sent after commit, retried with backoff.
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('ORDER_CONFIRMATION')),
  order_id            uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  recipient_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          text CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_order_kind_uniq UNIQUE (order_id, kind)
);
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status IN ('PENDING', 'FAILED');
CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stock ledger: orders decrement on placement and restore exactly once on rejection or cancellation.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reason_check;
ALTER TABLE stock_movements ADD COLUMN order_id uuid REFERENCES orders (id) ON DELETE RESTRICT;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_check
  CHECK (reason IN ('ADJUSTMENT', 'DISPENSE', 'ORDER', 'ORDER_RESTORE'));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_order_link CHECK (
  (reason = 'ORDER' AND delta < 0 AND order_id IS NOT NULL)
  OR (reason = 'ORDER_RESTORE' AND delta > 0 AND order_id IS NOT NULL)
  OR (reason IN ('ADJUSTMENT', 'DISPENSE') AND order_id IS NULL)
);
CREATE UNIQUE INDEX stock_movements_order_restore_once ON stock_movements (order_id, medicine_id)
  WHERE reason = 'ORDER_RESTORE';
