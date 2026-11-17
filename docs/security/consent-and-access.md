# Consent, access and appointment rules (C2)

## Consent
- Consent is an explicit state on the patient profile: `consent_status`, `consent_at` (last grant) and `consent_withdrawn_at`.
- A missing grant is never treated as consent. Registration records consent explicitly, and the database enforces that a granted state has a grant time and no withdrawal time.
- Withdraw or re-grant with `POST /api/v1/patients/me/consent { "granted": true | false }`. Both are idempotent and audited only when the state changes.

### What withdrawal does
| Area | Effect |
|---|---|
| New health data (allergies, conditions, medications) | Refused with `422 CONSENT_REQUIRED`. The insert itself checks consent, so a concurrent withdrawal cannot slip through. |
| Editing or resolving existing records | Still allowed. Editing never adds new data. |
| Doctor view of clinical context | Refused with `403 CONSENT_WITHDRAWN`. |
| Doctor appointment list | Appointments of patients who have withdrawn consent are hidden from doctors. |
| New bookings | Refused with `422 CONSENT_REQUIRED`. |
| Existing appointments | Not cancelled automatically. The patient can still cancel or reschedule them. |
| The patient's own data | Always visible to the patient. |

Records are not deleted on withdrawal. Deletion is a separate, later decision.

## Access rules
- The patient's identity always comes from the server session. No route accepts a patient or doctor id from the request body.
- Patients see only their own profile, health data, medications and appointments. Another patient's record returns `404`.
- A doctor sees a patient's clinical context only when there is a live appointment (`REQUESTED`, `CONFIRMED` or `COMPLETED`) between them and consent is in place. Otherwise the response is `404`. The context excludes address, email, mobile and emergency contact.
- A doctor sees only their own appointments.
- Admins have no route to clinical data in this checkpoint.

## Appointment rules
- Statuses: `REQUESTED`, `CONFIRMED`, `COMPLETED`, `CANCELLED`. Transitions live in one table (`policy.ts`).
  - The patient cancels: REQUESTED or CONFIRMED move to CANCELLED.
  - The doctor confirms: REQUESTED moves to CONFIRMED.
  - The doctor completes: CONFIRMED moves to COMPLETED, and only once the slot has started.
- Double booking is prevented in two layers. The booking transaction locks the slot row (`FOR UPDATE`). A partial unique index allows only one occupying appointment per slot. The index is the backstop and maps to `409 SLOT_TAKEN`.
- Cancellation and rescheduling are free until 2 hours before the slot. Cancelling inside 2 hours forfeits the INR 100 booking fee. **The fee is simulated**: no payment is taken and no refund is made. The `fee_status` column records `SIMULATED_HELD`, `SIMULATED_RELEASED` or `SIMULATED_FORFEITED`.
- Rescheduling inside 2 hours is refused. Rescheduling must stay with the same doctor. This is a recommendation, since the source policy is silent on rescheduling inside 2 hours.
- Patients submit symptoms and a complaint. Diagnosis is recorded only by a doctor.

## Audit
- Sensitive changes write an append-only `audit_logs` row: profile edits, consent changes, health and medication changes, bookings, cancellations, reschedules and doctor status changes.
- Audit rows store identifiers and states only, never health text or contact details.
