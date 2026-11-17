# CarePulse

Fictional healthcare portal (hackathon project). **All data is synthetic. Not medical advice.**

Stack: React + TypeScript + Vite + Tailwind (frontend), Node.js + TypeScript + Express (API), Neon PostgreSQL accessed with `pg` and plain SQL migrations (no ORM). Algolia is planned for medicine and doctor search, and Neo4j for the AI-B knowledge (RAG) store. There is no Redis. See `docs/architecture/decisions.md`.

Status: **C2 complete** (profile, health context, consent, doctor directory, slots and appointments). Prescriptions start at C3.

## Patient profile, consent and appointments (C2)

- Profile, structured allergies and conditions, medications and consent live in their own tables. Withdrawal is an explicit, audited state. See `docs/security/consent-and-access.md` for what withdrawal changes.
- Doctors are discovered through a public directory that exposes no registration number or contact details. Slots are generated lazily from weekly IST availability rules, 14 days at a time.
- Booking locks the slot row inside a transaction. A partial unique index guarantees one active appointment per slot. Six simultaneous bookings yield exactly one.
- Cancelling inside 2 hours forfeits the INR 100 booking fee. This fee is **simulated**: no payment is taken or refunded.
- Sensitive changes are written to an append-only `audit_logs` table.

## Authentication (C1)

- Patient self-registration only. The API rejects any `role` field, so privileged accounts can't be created publicly.
- Login by email or mobile, with a generic failure message and per-IP and per-identifier rate limits stored in PostgreSQL.
- Argon2id password hashing (`@node-rs/argon2`). Hashes are rehashed automatically when parameters change.
- Server-side sessions. Only the SHA-256 of the cookie token is stored. The cookie is HttpOnly and expires after `SESSION_TTL_HOURS`. Login rotates the session. Logout revokes it server-side.
- Production cookie is `__Host-cp_sid`, Secure, SameSite=None, for the cross-site Vercel and Render setup. Local dev uses `cp_sid`, SameSite=Lax.
- CSRF: writes must send `X-CSRF-Token`, which is returned by `/auth/login`, `/auth/register` and `/auth/me` and held in memory only. Foreign `Origin` headers are rejected.
- Seed: `npm run seed` creates the synthetic demo accounts. The pharmacist needs `SEED_PHARMACIST_PASSWORD`.

## Requirements

- Node.js >= 20.11 (22 LTS recommended). Toolchain versions are pinned to work on Node 20.11:
  TypeScript 5.9, Vite 6, Vitest 3, ESLint 9. Do not bump to the latest majors without upgrading Node.
- A Neon project (free tier is fine).

## Setup

```bash
npm install
cp backend/.env.example backend/.env     # fill in DATABASE_URL, APP_ORIGIN
cp frontend/.env.example frontend/.env   # VITE_API_BASE_URL
npm run migrate                          # applies backend/migrations/*.sql
```

Neon connection strings:

- `DATABASE_URL`: the **pooled** string (host contains `-pooler`). Used by the running API.
- `DIRECT_DATABASE_URL`: the **direct** string. Used only by `npm run migrate` (advisory lock and DDL need a stable session). Optional; falls back to `DATABASE_URL`.

## Run locally

```bash
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:5173
```

Health: `GET /health/live` (process up), `GET /health/ready` (database reachable and migrations current, else 503).
Connectivity check used by the UI: `GET /api/v1/ping`.

## Scripts (run from the repo root)

| Command | What it does |
| --- | --- |
| `npm run build` | Build API (`tsc`) and web (`vite build`) |
| `npm run typecheck` | Strict TypeScript check, both packages |
| `npm run lint` | ESLint, both packages |
| `npm test` | Vitest, both packages |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run migrate:status` | Show applied, pending and drifted migrations |

## Database migrations

SQL files in `backend/migrations/` named `NNNN_description.sql`, applied in order. Each runs in its own transaction under an advisory lock, and its SHA-256 is stored in `schema_migrations`. Editing an already-applied file is refused (drift). Add a new file instead. Migrations never run automatically on API boot.

Integration tests that need a real database run only when `TEST_DATABASE_URL` is set. Use a disposable Neon branch.

## Security notes (C0)

- Environment is validated at startup with Zod and fails fast. Error messages name variables, never values.
- CORS is an explicit allow-list (`APP_ORIGIN`). Helmet headers, 100 kb body limit, request IDs on every response.
- Errors use one envelope; unexpected errors return a generic message and never a stack trace.
- Logs redact cookies, authorization headers, passwords, tokens and connection strings, and omit query strings.
- `.env` files are git-ignored. The frontend only reads `VITE_API_BASE_URL`. Never put secrets in `VITE_*` variables.

## Layout

```
backend/   Express API (src/modules/*, src/infrastructure/*, migrations/)
frontend/  React SPA (src/app, src/components, src/features, src/lib)
docs/      Architecture, API and security notes (added per checkpoint)
```
