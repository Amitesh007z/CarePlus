# Architecture decisions (overrides to the PRD / master prompt)

| # | Decision | Replaces | Notes |
|---|----------|----------|-------|
| 1 | Backend stays **Node.js** | PRD note about a Java backend | Knowingly non-compliant with the hackathon Java rule. |
| 2 | **No ORM**: `pg` + plain SQL migrations | Prisma | Runner in `backend/src/infrastructure/database/migrate.ts`. |
| 3 | **No Redis** | Optional Redis | Rate limiting is stored in PostgreSQL so it is multi-replica safe. |
| 4 | **Algolia** for medicine and doctor search | PostgreSQL-only search | Derived index, synced via a transactional outbox (later checkpoint). |
| 5 | **AI-B (RAG) uses Neo4j** for chunk/vector storage and retrieval | pgvector in Neon | Postgres keeps `knowledge_documents` metadata and is still authoritative for access rules. Neo4j holds chunks, embeddings and document/section graph. Audience, region, document-type and effective-date filters must be applied inside the Neo4j query before similarity ranking. Details land in the AI-B checkpoint. |
| 6 | DB driver `neon-ws` option | n/a | For networks blocking TCP 5432. Default `pg`. |
