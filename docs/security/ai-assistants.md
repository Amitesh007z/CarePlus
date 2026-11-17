# AI assistants (C8 care assistant, C9 knowledge assistant)

Both assistants are **not diagnostic systems**. They do not diagnose, treat or claim a cure. All data is synthetic.

## Provider port and keys

- Domain code depends on `backend/src/modules/ai/llm/provider.ts` only. The Gemini adapter (`gemini.ts`) is the only file that knows the vendor's API.
- `GEMINI_API_KEY` is backend-only and optional. Without it, both assistants return their safe fallback and the rest of the application is unaffected (tests 15 in C8 and C9).
- The key travels in the `x-goog-api-key` header, never in a URL. Provider errors keep only Google's status name (for example `NOT_FOUND`). Response bodies and request text are never logged.
- Current models: generation `gemini-3.1-flash-lite`; embeddings `gemini-embedding-001` at 768 dimensions. `gemini-2.5-*` returns HTTP 404 to new keys.

## Timeouts, retries and fallback

| Event | Behaviour |
| --- | --- |
| Model output is not valid JSON or fails the schema, or a claim/citation check fails | One retry with a stricter instruction. A second failure returns **not-found** (C9) or the **safe fallback** (C8). The rejected output is never shown. |
| Timeout or transport failure | No retry. C8 returns the safe fallback (zero recommendations). C9 returns the closest approved passage verbatim, labelled `fallback: true`. |
| Provider not configured | Same as a transport failure. |

Timeouts: `AI_LLM_TIMEOUT_MS` (default 8000 ms). Indexing uses a 30 s budget per batch.

## AI-A: care assistant (C8)

Pipeline order, enforced in `backend/src/modules/ai/care/care.service.ts`:

1. **Authenticate**: `protect(... 'PATIENT')` requires a session and CSRF on writes.
2. **Minimum context**: consent, age (from date of birth) and active allergy rows only. No conditions, medications or contact details.
3. **Red flags**, deterministic, before any model call: the rules in `backend/src/modules/appointments/redFlags.ts`. Emergency returns `urgency: EMERGENCY`, zero products and zero doctors. Emergency guidance is never blocked by consent or rate limits.
4. **Consent**: without health-data consent the request is refused with `422 CONSENT_REQUIRED`, because the allergy filter needs the health record.
5. **Rate limit**: per patient, `AI_CARE_RATE_LIMIT_MAX` requests per `AI_CARE_RATE_WINDOW_SEC` (defaults 10 per 10 minutes), before any model spend.
6. **Extraction** (model): need, duration, constraints, keywords. Facts only.
7. **Clarification**: a need counts only when it is named and has searchable keywords. An unclear age also triggers a question. The response has zero recommendations until clarified.
8. **Retrieval** (PostgreSQL): active doctors whose specialty matches, falling back to general-practice doctors. Active, non-Rx, in-stock medicines matching the keywords.
9. **Deterministic exclusions**: Rx-only items (in SQL and again in code), and allergy-class conflicts (`matchAllergies`, the same exact-match rule as prescriptions). Cross-reactivity is not inferred.
10. **Empty candidate set**: no model call, no fabricated matches.
11. **Ranking** (model): sees only the remaining candidates and returns IDs, one reason per item and an urgency.
12. **Validation**: strict schema (unknown keys rejected). Every ID must be in the candidate set. No duplicates. No price, stock, availability or Rx claims and no diagnostic phrases (`forbiddenClaimIn`). Life-stage constraints allow no products.
13. **Response** is built from database values only: names, SKU, price, availability and Rx status come from PostgreSQL, never from the model.
14. **Urgency** is the more cautious of the model's answer and the deterministic floor: `SEE_DOCTOR` for a duration of 7 days or more, or a life-stage constraint (pregnancy, infant, child, elderly). If there are no products, it is at least `SEE_DOCTOR`.
15. **Log** (see Privacy).

Confirmation: the API never writes to the cart, orders or appointments (tested). The UI requires explicit confirmation before adding to the cart; booking goes through the existing booking page.

### Red-flag rules: what is implemented and its limits

Implemented (reused unchanged from the appointments module): chest pain or pressure; breathing difficulty (phrases such as "can't breathe", "shortness of breath", "gasping"); possible stroke signs (face drooping, slurred speech, one-sided weakness or numbness, sudden weakness, numbness or confusion).

These are the three examples named in the brief. They are **not** a clinical triage protocol.

- Keyword matching misses paraphrases, typos and other languages. A missed emergency is possible. The emergency guidance on every screen says so.
- No other emergencies are detected. Unconsciousness, severe bleeding, seizures, self-harm and so on are not covered.
- Constraint and duration floors are coarse heuristics.

## AI-B: knowledge assistant (C9)

### Storage (PostgreSQL + pgvector on Neon)

- `knowledge_documents`: slug, title, document type, version, effective from and to, region, audience, status (`DRAFT`, `APPROVED`, `SUPERSEDED`, `ARCHIVED`), source, content and its SHA-256, indexing status and a short error code, timestamps.
- `document_chunks`: section, heading path, content and `vector(768)`, with an HNSW cosine index.
- Triggers enforce versioning in the database:
  - Content and identity columns of a non-draft version cannot change. A change means a new version row.
  - Status moves only `DRAFT → APPROVED | ARCHIVED` and `APPROVED → SUPERSEDED | ARCHIVED`.
  - Versions are never deleted.
- At most one `APPROVED` version per slug (partial unique index). Approval supersedes the previous version in one transaction and keeps it as history.
- Audience follows document type (`CHECK`). A clinician protocol can never be labelled patient-facing.

### Ingestion

- Markdown with `---` front matter, validated with Zod. PDF is not supported: the corpus is Markdown, and a PDF parser would add risk with no source that needs it.
- Headings are preserved, and each chunk carries its heading path. Chunks stay within 700 characters and never cross a section boundary. The embedded text includes the title and heading path.
- A new version is created as a draft and indexed. Re-indexing rebuilds chunks from the stored content. The same version number with different content is refused (`409 VERSION_EXISTS`). Chunk replacement is atomic: a failure keeps the previous chunks and records `FAILED` with a short code (`EMBEDDING_TIMEOUT`, `EMBEDDING_UNAVAILABLE`, and so on).
- A failed version cannot be approved. A version that fails re-indexing after approval drops out of retrieval (fail closed) until it is re-indexed.

### Access (enforced in code and in SQL, before ranking)

`backend/src/modules/ai/knowledge/knowledge.policy.ts`:

| Role | Audiences | Document types |
| --- | --- | --- |
| PATIENT | PATIENT | POLICY, FAQ, MEDICINE_LEAFLET |
| DOCTOR | PATIENT, CLINICIAN | + CLINICAL_PROTOCOL |
| PHARMACIST | PATIENT, STAFF | + PHARMACY_PROCEDURE |
| ADMIN | all (review) | all |

Region: national (`IN`) always, plus `IN-XX` for a patient whose profile state is known. Clinic-time date: documents must be effective on the current date. A version whose `effective_to` has passed is excluded, even when its status is `APPROVED`.

The question cannot change any of this. It is embedded for similarity only.

### Answering

1. Authenticate, then rate-limit (`AI_KNOWLEDGE_RATE_LIMIT_MAX`, default 30 per 10 minutes).
2. Embed the question (`RETRIEVAL_QUERY`).
3. Retrieve the top 5 chunks, with every filter in the `WHERE` clause.
4. Confidence bands from similarity (see below). Nothing above 0.65 means not-found, with no generation call.
5. The model receives up to 4 passages, delimited as untrusted data. It returns `answerable`, an answer and cited chunk IDs. A citation outside the passages, an answer with no citations, or invalid output is rejected.
6. Confidence comes from the retrieval score of the cited passages, not from the model.

Not-found is the same whether the question is unsupported or the matching documents are restricted. The response never reveals that a restricted document exists.

### Confidence thresholds (initial heuristics, not calibrated)

- HIGH: similarity above 0.80. MEDIUM: 0.65 to 0.80. Below 0.65: not covered.
- These are the PRD's initial values. They are **not** calibrated for this embedding model or corpus. Scores depend on wording and on the corpus size.
- Calibration measured on the seeded corpus, a patient in Karnataka, live `gemini-embedding-001`:
  - Relevant questions scored **0.62 to 0.76**. Almost all were MEDIUM. None reached HIGH in the probe.
  - Unrelated text scored about **0.47 to 0.51**, so it was correctly not covered.
  - An unsupported insurance question scored **0.653**, just above the floor. It was refused only because the model judged the passages unanswerable. The grounding gate is therefore the model's `answerable` check, plus citation validation, and not the threshold alone.
- Re-check these heuristics against real questions before relying on the bands.

### Prompt injection

- Questions and document text are untrusted. Angle brackets are stripped and the text is wrapped in tags. The system prompt says to ignore instructions inside them.
- What the model can do is limited in code: it can only cite passages it was given, and it cannot change filters, roles or audiences. Tested in `c9.integration.test.ts` and `c9.unit.test.ts`.
- A poisoned document can still change the wording of an answer about its own passage. It cannot widen access or cite content outside the retrieved set. Content review is an admin responsibility.

### Corpus

`backend/knowledge/*.md` holds eight files. **They are synthetic placeholders written for development, not the approved Master Context Prompt text.** Each one says so in its `source` field. Replace them with the approved text before any real use.

## Privacy: AI interaction log

`ai_interactions` (migration `0010_ai_care.sql`) is append-only, enforced by a trigger. Each row records:

- feature, role, user ID, outcome, urgency and confidence;
- a **SHA-256 of the input, its length, and never the input itself**;
- red-flag labels (the rule names, not the text), candidate counts, top score;
- provider, model, LLM attempts, latency and an error code.

It never stores message text, model output, or health details. Log write failures are reported to server logs and do not block the response.

## Evidence

`backend/src/scripts/ai-evidence.ts` regenerates `docs/evidence/c8-care-assistant-examples.json` and `docs/evidence/c9-knowledge-examples.json` from live calls, with a synthetic patient. Run it after seeding the corpus.

## Operations

- Seed the corpus: `npm run seed:knowledge` in `backend` (needs `GEMINI_API_KEY` and at least one ADMIN account). Idempotent: unchanged versions are not re-embedded.
- Admin console: `/admin/knowledge`. Upload is limited by the app-wide 100 KB JSON body limit.
- Migrations `0010_ai_care.sql` and `0011_knowledge_pgvector.sql` are additive. `0011` requires the `vector` extension, which Neon provides.
