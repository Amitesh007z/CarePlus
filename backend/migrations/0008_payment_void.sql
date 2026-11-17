-- C6: a cancelled cash-on-delivery order was never paid, so its payment is voided rather than refunded.
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('SUCCEEDED', 'PENDING', 'COLLECTED', 'REFUNDED', 'VOIDED'));
