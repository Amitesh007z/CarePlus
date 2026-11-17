# Search sync, medicine catalogue and pharmacy fulfilment (C5)

Written for: engineers and reviewers who need to know what leaves the database, what can fail, and what the
clinical rules actually do.

## Source of truth

PostgreSQL is authoritative. Search is a ranking aid. Search results are re-read from PostgreSQL before they are
shown: the provider returns object IDs, and PostgreSQL applies filters, sorting, pagination, active status and stock.
A stale index entry therefore cannot show a deactivated medicine or a wrong price.

## What is indexed

| Index | Object ID | Fields (allow-list in `search-sync.ts`) |
|---|---|---|
| `carepulse_medicines` | medicine UUID | sku, name, strength, form, category, packSize, priceInr, rxRequired, allergyClass, description, manufacturer |
| `carepulse_doctors` | doctor user UUID | displayName, specialty, experienceYears |

Not indexed, by design: stock, chronic eligibility, timestamps, patient data, registration numbers, email,
mobile, availability, prescriptions and anything clinical. Stock is excluded because it changes on every dispense
and is not a search attribute, so stock-only filtering always uses PostgreSQL.

## Outbox

- A catalogue write and its `search_sync_jobs` row commit in one transaction. A rollback leaves no job (tested).
- Writes never call the provider. An Algolia outage cannot fail or delay a catalogue write.
- A job means "make the index match the database for this object". The worker reads the current row when it runs,
  so duplicate and late jobs can only write current data.
- At most one `PENDING` job per object (partial unique index). A change while a job is `PROCESSING` queues a new one.
- Statuses: `PENDING`, `PROCESSING` (leased for 2 minutes), `SUCCEEDED`, `SUPERSEDED` (a newer pending job covers
  it), `DEAD` (after 6 attempts; kept for inspection).
- Retry backoff: 5 s doubling to a 15 min cap.
- Batches of up to 50, at most 3 concurrent workers. A failed batch is retried object by object, so one bad object
  cannot hold back its neighbours.
- Claiming uses `FOR UPDATE SKIP LOCKED`, so several processes are safe.

## Provider and credentials

- Algolia is reached through a small REST adapter (`algolia.adapter.ts`) with a hard timeout on every call.
- Writes use the backend-only admin key. Queries use the restricted search-only key when it is set.
- Provider failures become `SearchProviderError` with a kind (`TIMEOUT`, `UNAVAILABLE`, `REJECTED`) and an HTTP status.
  Response bodies and credentials never reach an error message, a log line or a client.
- Keys live in backend environment variables only. Nothing with `VITE_` or `ALGOLIA_` reaches the frontend bundle;
  a unit test scans the frontend source and env files for credential names.
- If Algolia is not configured, search falls back to PostgreSQL and the outbox waits durably.

## Operator commands

```
npm run search:setup        # apply index settings (idempotent)
npm run search:reindex      # queue every active medicine and doctor, then drain
npm run search:reconcile    # compare the database with each index; queue missing and stray objects
npm run search:drain        # process due jobs once
npm run search:status       # counts by job state
```

Reconciliation runs through the outbox too. It never writes to the provider directly.

## Search API

`GET /api/v1/catalogue/search` returns `engine` (`algolia` or `postgres`), `degraded` (a search was requested but the
provider failed) and `truncated` (more matches than the 1000-candidate cap). The frontend falls back to
`GET /api/v1/catalogue/medicines` if the search endpoint itself fails.

## Fulfilment lifecycle

```
QUEUED -> VERIFIED -> PACKED -> OUT_FOR_DELIVERY -> DELIVERED
QUEUED | VERIFIED -> REJECTED (reason required; the patient may re-send)
```

- The patient sends an issued, unexpired prescription. One open request at a time.
- Verify re-runs the allergy and major-interaction checks, because allergies can change after issue.
- Pack is dispensing. In one transaction it locks the stock rows in id order, refuses if any line is short, marks the
  prescription FULFILLED, and writes one `DISPENSE` ledger row per line. Any failure rolls all of it back.
- Stock is an append-only ledger (`stock_movements`, with UPDATE and DELETE blocked by trigger). The balance can never
  go negative (CHECK constraint, and the adjustment path rejects it).

## Clinical rules

- **Drug interactions.** Rules live in `drug_interactions` and are added by an admin with a mandatory source
  reference. **No rules are shipped.** The brief supplied no curated dataset, so the engine is complete but has
  nothing to act on until a clinical owner provides one. A MAJOR rule blocks issuing; MODERATE and MINOR rules are
  shown as warnings and stored on the issued record.
- **90-day validity.** A draft can request 90 days only if every medicine is marked `chronic_eligible` by an admin.
  Nothing is marked, so 90 days is refused for every current medicine. The check is repeated at issue.

## Known limits

- The candidate cap is 1000 matches per search. Beyond that the result is flagged `truncated`.
- Stock-only filtering uses PostgreSQL search, not Algolia.
- The 11 pending and 5 dead jobs in the local database came from the outage and retry tests. They use synthetic
  `T5` medicines and are harmless, but they would be indexed if Algolia were configured against this database.
