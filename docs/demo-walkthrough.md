# CarePulse demo walkthrough

Written for: a tester or reviewer who wants to click through every feature. All data is synthetic.

## Start the app

```
npm run dev:api     # API on http://localhost:4000
npm run dev:web     # web on http://localhost:5173
```

Open http://localhost:5173.

## Accounts

Password for the demo accounts is `Demo@1234`.

| Role | Email | Notes |
|---|---|---|
| Patient | anita.rao@example.com | Penicillin allergy recorded, so the allergy check triggers on Amoxicillin |
| Patient | vikram.s@example.com | No allergies |
| Doctor | dr.mehta@example.com | 09:00 to 17:00 every day, 30-minute slots, 14 days of slots open |
| Admin | admin@example.com | Catalogue, drug interaction rules, search status |
| Pharmacist | pharmacist@example.com | Password is the `SEED_PHARMACIST_PASSWORD` in `backend/.env` |

Any patient can register a new account at /register. Patients must accept consent.

## Slots

Every active doctor has weekly hours (Monday to Sunday, 09:00 to 17:00, 30-minute slots). Slots for the next 14 days are materialised. To refresh them later, run `npm run slots:enable`.

## 1. Accounts and access (C1)

1. Sign in as each role. Each lands on its own home.
2. Open a patient page as the doctor, or a doctor page as a patient. You are sent away.
3. Sign out and try a protected URL. You are sent to /login.

## 2. Patient profile, consent, booking (C2)

1. Sign in as Anita. Open **Profile**. Edit a field, then save.
2. Open **Health**. Review the allergy and condition list. Withdraw consent and confirm the doctor view is blocked (see step 4 below).
3. Open **Doctors**. Search "Mehta". Open her profile and pick a slot from the next 14 days. Confirm the booking. It appears under **Appointments**.
4. Reschedule or cancel a visit. Cancelling within 2 hours shows the simulated INR 100 fee.

## 3. Doctor workspace and consultation (C3)

1. Sign in as Dr. Mehta. The dashboard shows today's queue.
2. Open the Anita visit. Confirm the appointment, then start the consultation.
3. Fill the chief complaint, diagnosis (free text), vitals and severity. Save the draft.
4. Finalise. The record locks. Add an addendum to see that it appends rather than edits.

## 4. Prescriptions and allergy safety (C4)

1. Still as the doctor, open the finalised consultation and click **New** for a prescription.
2. Search "amoxi" and add Amoxicillin. The allergy alert blocks the prescription (Anita is penicillin-allergic).
3. Remove Amoxicillin and add Azithromycin. Preview, then issue. The number is `CP-YYYY-NNNNNN`.
4. Sign in as Anita. Open **Prescriptions**. Open the issued one and download the PDF.

## 5. Catalogue and search (C5)

1. Open **Medicines** (no login needed). Type a name, including a typo such as "amoxcillin". Typo tolerance comes from Algolia.
2. Use the category, Rx/OTC and price filters, change the sort, and page through results. Clear filters resets them.
3. Open a medicine. Stock shows only as availability, never as an exact count.
4. Sign in as admin and open **Admin, Medicines**. Create a medicine, edit a price, deactivate one. A deactivated medicine disappears from the public catalogue.
5. The search status endpoint `/api/v1/admin/search/status` shows whether Algolia is configured and the job counts.

## 6. Cart, checkout and orders (C6)

1. As Vikram, add two OTC medicines from **Medicines**. Open **Cart**. The summary explains the delivery fee (INR 40 under INR 299, free above) and any discount.
2. Try to add a prescription-only medicine. It is refused with a message.
3. Open **Checkout**. Choose an address (add one if needed) and a payment method (Card, simulated, or cash on delivery). Place the order.
4. The confirmation page shows the order number and the explanation of the total. Refresh and retry: the same order comes back.
5. As Anita, buy from one of her issued prescriptions with **Buy these medicines** on the prescription page. The items and quantities are exactly the prescription's, the total takes 10% off, and delivery is free.
6. Open **Orders**. Open an order to see tracking. Cancel an order that is still placed. Stock comes back.

## 7. Pharmacist console (C7)

Sign in as the pharmacist.

1. **Home** shows counts: awaiting verification, in progress, delivered and rejected today, low stock, and out of stock.
2. **Orders** lists the verification queue. Open an order. The history shows who acted, when, and why.
3. For a prescription order, open the prescription review. It shows the medicines, quantities, patient name and age, prescriber, validity, and any allergy or interaction alerts. It never shows diagnosis, advice or notes.
4. Verify the order, then pack, dispatch and deliver it. Each step is only offered when it is valid.
5. Reject an order. A reason is required. Stock is returned once.
6. **Stock** lists inventory. Tick **Low stock only** to see items at or below 10 units. Adjust a stock level with a reason. Negative results are refused. Movement history shows every change.

## Roles that must be refused

- A patient calling any pharmacist route: 403.
- A doctor calling pharmacist routes: 403.
- A pharmacist calling doctor prescription-editing routes: 403.

## Checks you can run

- `npm run test -w backend` runs the API suite against the separate test database.
- `npm run test -w frontend` runs the web suite.
- `npm run e2e` drives the real browser journey (needs both servers running).
