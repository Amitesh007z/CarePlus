# RBAC test accounts and testing checklist

All data is synthetic. Passwords here are local demo passwords. Never use them outside the demo database.
The same content is shown in the app at `/test-guide`, which every signed-in role can open.

## Demo accounts

| Role | Email | Password | Use it for |
| --- | --- | --- | --- |
| PATIENT | anita.rao@example.com | Demo@1234 | Patient with consent and profile. Care assistant, Ask CarePulse, orders. |
| PATIENT | vikram.s@example.com | Demo@1234 | Second patient, to check that data stays separate. |
| DOCTOR | dr.mehta@example.com | Demo@1234 | Doctor workspace. Reads clinician documents through Ask CarePulse. |
| PHARMACIST | pharmacist@example.com | value of `SEED_PHARMACIST_PASSWORD` in `backend/.env` | Pharmacy queue, stock, prescription review. Reads staff procedures. |
| ADMIN | admin@example.com | Demo@1234 | Catalogue, knowledge console and versions. Reads every audience for review. |

Demo password is `Demo@1234` unless `SEED_DEMO_PASSWORD` was set when seeding. If an account is missing, run `npm run seed` in `backend`.

## Who can reach what (RBAC)

| Area | Patient | Doctor | Pharmacist | Admin |
| --- | --- | --- | --- | --- |
| Dashboard (own role) | Yes | Yes | Yes | Yes |
| Doctor directory and booking | Yes | No | No | No |
| Doctor consultations and patient chart | No | Yes | No | No |
| Prescriptions (issue) | No | Yes | No | No |
| Prescriptions (view own) | Yes | No | No | No |
| Cart, checkout, orders | Yes | No | No | No |
| Pharmacy queue, orders, stock | No | No | Yes | No |
| Admin medicines and knowledge console | No | No | No | Yes |
| Medicine catalogue (public) | Yes | Yes | Yes | Yes |
| Care assistant (AI-A) | Yes | No | No | No |
| Ask CarePulse (AI-B) | Yes | Yes | Yes | Yes |
| Test guide | Yes | Yes | Yes | Yes |

Knowledge access for AI-B: patients read patient documents only. Doctors also read clinician protocols. Pharmacists also read staff procedures. Admins read all.

## Checklist

### Everyone
- [ ] Sign in with your account. The role chip and nav match the access table.
- [ ] Nav bar fits the window at narrow, tablet and wide widths. Links scroll sideways in the middle sizes.
- [ ] Sign out returns you to the login page, and Back does not reopen the session.
- [ ] Turn off the AI key (or stop the AI call). Appointments, orders and prescriptions still work.

### Patient
- [ ] Care assistant: "I have a dry cough for two days" gives SELF_CARE, product cards with prices, and doctor cards.
- [ ] Care assistant: "Severe chest pain since this morning" shows the emergency panel and no cards.
- [ ] Care assistant: "I feel off" asks what you need help with and shows no cards.
- [ ] Care assistant: "Add to cart" asks for confirmation first. Cancelling adds nothing.
- [ ] Ask CarePulse: "What is your return and refund policy?" gives a grounded answer with a source chip, section and version.
- [ ] Ask CarePulse: "Show me the clinician triage protocol" returns not-found with support and pharmacist options.
- [ ] Ask CarePulse: "Does CarePulse cover my health insurance claims?" returns not-found.
- [ ] Doctor booking: pick a slot and confirm. Cancelling inside 2 hours shows the simulated INR 100 fee.
- [ ] Health page: add a penicillin allergy. The care assistant then removes penicillin-class items.
- [ ] Profile: withdraw consent. The care assistant then refuses with a consent message.

### Doctor
- [ ] Open a patient chart and a consultation. Add vitals. An impossible value is refused.
- [ ] Issue a prescription. A medicine that matches a recorded allergy is blocked.
- [ ] Ask CarePulse: "Clinician triage protocol for chest pain" gives the clinician document as a source.
- [ ] Doctor cannot open the admin console or the pharmacy queue.

### Pharmacist
- [ ] Pharmacy queue: open a prescription, review it, and check the allergy warning is shown.
- [ ] Stock: adjust a quantity and check the movement appears in the history.
- [ ] Ask CarePulse: "What does the dispensing procedure say about the allergy record?" gives the staff procedure.
- [ ] Pharmacist cannot get clinician documents through Ask CarePulse.

### Admin
- [ ] Knowledge: list documents and open one. Check audience, effective date and indexing status.
- [ ] Knowledge: upload a new version as a draft, re-index it, then approve. The old version is marked superseded.
- [ ] Knowledge: uploading the same version number with different text is refused.
- [ ] Medicines: add or change a medicine. The public catalogue reflects it.
- [ ] Admin pages are closed to patients, doctors and pharmacists (direct URL gives access denied).

## Automated tests

```bash
cd backend
npx vitest run tests/c8.unit.test.ts tests/c9.unit.test.ts tests/c8.integration.test.ts tests/c9.integration.test.ts

cd ../frontend
npx vitest run src/features/ai src/features/knowledge
```

The integration files need `TEST_DATABASE_URL` and `GEMINI_API_KEY` in `backend/.env`.
