# Prescriptions and safety rules (C4)

- **Lifecycle:** DRAFT → ISSUED → FULFILLED. A correction creates a replacement draft. The original becomes SUPERSEDED only when the replacement is issued. EXPIRED is derived from `valid_till` and is never stored.
- **Immutability:** database triggers allow drafts to change. Once issued, a prescription accepts only the transitions ISSUED → FULFILLED and ISSUED → SUPERSEDED, and its clinical content cannot change. Issued items cannot change, and issued records cannot be deleted.
- **Issuance requires:** the doctor who owns the consultation, a finalized consultation, at least one medicine, the patient's current consent, and no allergy conflict. Each blocked attempt is audited.
- **Allergy check:** deterministic and exact (case-insensitive). A medicine's allergy class is compared with the patient's recorded allergy class, or with the allergy name when it has no class. Policy is `BLOCK`. No cross-reactivity or unlisted relationship is inferred, and no model is involved.
- **Validity:** 30 days from issue, counted in clinic time. The brief's 90-day rule for chronic conditions is not applied, because the data model has no source-backed chronic flag.
- **Drug interactions:** not implemented. The brief supplies no curated interaction dataset, and none is invented.
- **Prescription numbers:** `CP-<year>-<6-digit sequence>`, assigned from a database sequence at issue, so they are unique under concurrency.
- **Patients:** see only their own issued prescriptions. Drafts are never returned. PDFs are built from the persisted record.
- **Fulfilment hook:** `markFulfilled` and `assertDispensable` are the entry points for the pharmacy checkpoint. Expired, superseded and already fulfilled prescriptions are refused.
