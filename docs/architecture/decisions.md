# Architecture decisions (overrides to the PRD / master prompt)

| # | Decision | Replaces | Notes |
|---|----------|----------|-------|
| 1 | Backend stays **Node.js** | PRD note about a Java backend | Knowingly non-compliant with the hackathon Java rule. |
| 2 | **No ORM**: `pg` + plain SQL migrations | Prisma | Runner in `backend/src/infrastructure/database/migrate.ts`. |
| 3 | **No Redis** | Optional Redis | Rate limiting is stored in PostgreSQL so it is multi-replica safe. |
| 4 | **Algolia** for medicine and doctor search | PostgreSQL-only search | Derived index, synced via a transactional outbox (later checkpoint). |
| 5 | **AI-B (knowledge assistant) uses pgvector in Neon.** No Neo4j. | Neo4j for chunks and embeddings (earlier decision, reversed at C9) | `knowledge_documents` and `document_chunks` (with `vector(768)` and an HNSW index) live in the same Neon database. Access filters (role audience, document type, region, status, effective window) are in the SQL `WHERE` clause that ranks by similarity, so they apply before any passage reaches the model. See `docs/security/ai-assistants.md`. |
| 7 | **LLM access goes through a provider-neutral port** (`backend/src/modules/ai/llm/provider.ts`). Gemini is the first adapter. | Vendor SDK calls in domain code | Domain code never imports a vendor SDK. Keys stay on the backend. Current models: `gemini-3.1-flash-lite` for generation and `gemini-embedding-001` at 768 dimensions. `gemini-2.5-*` returns 404 for new keys. |
| 6 | DB driver `neon-ws` option | n/a | For networks blocking TCP 5432. Default `pg`. |
