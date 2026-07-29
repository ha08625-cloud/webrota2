# Rota Generator — Architecture Hub

Read this file first, every chat. It stays deliberately thin — cross-cutting facts only — so a chat working on one rota domain doesn't have to load the other's detail to get oriented. Once you know which domain the task is in, load the matching document below and stop there unless the task genuinely crosses the boundary.

## Overview

Two independent rota generators for a medical practice, sharing one deployment:

- **Clinical rota** (`architecture-clinical.md`) — the original system, ported from a Google Apps Script project attached to a Google Spreadsheet (the port removed GAS's 6-minute execution limit). Generates a working rota for doctors from a master template over a configurable 1–4 week period, applying annual leave, duty assignments, clinic assignments, and room allocations via a Phase 0–12 generation engine, with interactive editing (drag-and-drop, cell edit menus, WFH, undo) in a web UI.
- **Reception rota** (`architecture-reception.md`) — a second, much simpler rota type for reception staff: one day at a time, hourly slots, phones-coverage validation, template-copy instead of a generation engine. Built later, independent of the clinical domain end to end.

**What the two domains share, and nothing else:** auth, the app shell (`App.tsx`'s two shells, one router), the HTTP client (`api/client.ts`), and deployment (one Railway service, one database). No doctors, rooms, clinic types, counters, leave, closures, duty, staging, or generation-engine code is imported by or into the reception domain, and nothing reception-specific is imported by the clinical domain. If you find yourself reaching for a clinical helper from reception code (or vice versa), that is very likely a mistake, not a missing cross-reference in these docs.

**Status:** both domains are feature-complete and deployed to production (Railway, PostgreSQL), seeded, and verified end to end. Access control is real per-user email/password login with DB-backed sessions (the earlier shared-token shim has been fully replaced) and gates both domains identically. Outstanding work is listed below.

## Outstanding Tasks

All outstanding items are on the clinical side; the reception rota has no known outstanding work as of its v1 (deliberate v1 scope exclusions — leave tracking, multi-day views, fairness counters, auto-assignment — are recorded in `architecture-reception.md`, not repeated here as tasks).

| Task | Scope | Priority | Notes |
|---|---|---|---|
| Master rota bulk row operations | Python + React | Low | "Remove all of a leaver's sessions", "copy week 1 to weeks 2–4", "populate a new doctor's full week". Single-slot create/delete covers the common case; revisit only if the per-slot workflow proves too slow in practice |
| Master rota multi-template management | Python + React | Low | Create/activate/rename templates. Currently the single seeded active template (`MasterRotaTemplate.is_active`, resolved deterministically by the GET) |
| Add role information to room rota cells | Python | Medium | Room-centric view is a deferred frontend transformation; cells should display doctor role alongside code |

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI under `/api/v1`, SQLAlchemy 2.0, Alembic |
| Database | PostgreSQL (production, Railway) / SQLite (dev and tests) |
| Generation engine | Pure Python (`backend/app/engine/`), no FastAPI dependency — clinical rota only; reception has no engine, see `architecture-reception.md` |
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS v3.4, served same-origin by FastAPI from `frontend/dist` |
| Server state | TanStack Query |
| Drag-and-drop | `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` (the older, stable dnd-kit generation, chosen over the pre-1.0 `@dnd-kit/react` rewrite). Clinical rota only — the reception grids have no drag-and-drop |
| Forms | Zod for validation; plain React state, no form library |
| UI primitives | Radix UI, installed per-primitive (`react-popover`, `react-dialog`) |
| Auth | Per-user email/password login, DB-backed sessions (`users`/`sessions` tables), shared by both domains. `Authorization: Bearer <token>`, opaque token hashed (SHA-256) before storage, 30-day fixed expiry, no fail-open — every router endpoint requires a valid session. Single role, no admin tier: see `backend/app/api/routers/users.py`, `backend/app/api/deps.py` |
| Packaging | `uv` + `pyproject.toml` (hatchling) backend; `npm` frontend, Node 24 pinned via `engines` and matched in CI |
| Testing | pytest (engine + API, SQLite) + Postgres migration round trip, via GitHub Actions; Vitest + React Testing Library + MSW for the frontend |

## Conventions

Shared across both domains' routers and schemas:

- **Transaction boundaries:** each mutating endpoint commits explicitly on success; a raised `HTTPException` leaves the session uncommitted, so partial work is discarded.
- **Duplicate detection** is via catching `IntegrityError` on commit (race-free), mapped to 409 — not pre-checking. The documented exceptions (master-rota session POST, reception master-session POST) pre-check instead, to produce a descriptive 409 naming the conflicting slot.
- **Field naming:** objects embedded in lists alongside other `_id` fields use prefixed ids (`rota_id`, `session_id`, `staff_id`, `template_id`) — a bare `id` would be ambiguous there; standalone CRUD entity schemas (`DoctorOut`, `RoomOut`, `ReceptionStaffOut`, ...) use plain `id`. The frontend's types mirror wire names exactly, no client-side renaming.
- **The room_id/room_type XOR** on room eligibilities and preferred rooms is enforced at the API boundary (Pydantic validators, 422) as well as by the DB check constraints — clinical-only, since it exists to model an exclusive physical resource. Reception has no analogous XOR (see `architecture-reception.md`).

## CI (`ci.yml`)

Three independent jobs on every push and pull request, covering both domains (there is no separate CI path per domain):

1. **Backend test suite** — `uv sync --extra dev`, then the full pytest suite (engine + API, clinical and reception) on in-memory SQLite. API tests run `TestClient` with `get_db` dependency-overridden to a fresh SQLite engine per test. Two client fixtures: `client` also overrides `get_current_user` with a stub user, so most tests don't need to authenticate to exercise a route; `client_no_auth` leaves `get_current_user` un-overridden to exercise the real login/session path (auth plan, Task 4) — see `backend/tests/test_api/conftest.py`.
2. **Postgres migration validation** — upgrade/downgrade/upgrade round trip against a `postgres:16` service container, proving both migration directions and native enum type cleanup against a real Postgres before Railway ever runs a migration.
3. **Frontend gate** — Node 24, `npm ci` (requires `frontend/package-lock.json` committed), then typecheck / vitest / build, in that order so a fast typecheck failure doesn't wait on the slower build.

## Deployment

Single Railway service deployed from the GitHub repo, Root Directory `/` (repo root — both `backend/` and `frontend/` must be inside one build context, since FastAPI serves the built frontend same-origin). One service, one database, both domains' tables and routes deployed together — there is no independent deploy path for reception.

**Build (`nixpacks.toml`, repo root).** Drives the Nixpacks build plan explicitly rather than relying on provider auto-detection, since neither `backend/pyproject.toml` nor `frontend/package.json` sits at the scanned root — `providers = ["python", "node"]` only puts the runtimes on PATH; every install/build command is written out with an explicit `cd`. Python installs into a manually created venv at `/opt/venv` (the nixpkgs `python3` has no bundled pip; `python3 -m venv` bootstraps one), which persists into the runtime image but is not on PATH at runtime. `frontend/dist` is built here. Deliberately no `[start]` section — the start command lives in exactly one place.

**Run (`railway.toml`, repo root).** `[deploy] startCommand` runs migrate-then-serve: `cd backend && alembic upgrade head && uvicorn app.api.main:app` — idempotent, so repeat deploys are safe. Health check on `/health`. [UNRESOLVED: the project copy of `railway.toml` uses bare `alembic`/`uvicorn`, but `nixpacks.toml` documents that the venv is not on runtime PATH and the start command must call `/opt/venv/bin/*` explicitly. One file is stale — confirm against the repo and correct this paragraph.]

**Serving.** FastAPI mounts `frontend/dist` at `/` (`mount_frontend()`; path overridable via `FRONTEND_DIST`) only if the directory and its `index.html` both exist, so a half-built dist never mounts. Registered routes always beat the mount; `SPAStaticFiles` serves `index.html` as the fallback for unknown non-API paths so client-side routes survive a hard refresh, while `/api/*` misses stay real JSON 404s. No cache-control headers are set — if stale-frontend-after-deploy ever appears, that is where to look.

**Environment variables** (Railway dashboard):

- `DATABASE_URL` — the Railway Postgres service; must use the `postgresql://` scheme, not `postgres://`.
- `CORS_ORIGINS` — the production origin. Same-origin serving means the SPA never makes a cross-origin request, so this is hardening only; a correct value can only be verified via a cross-origin `curl`, not by watching the app work.

Auth has no env var of its own any more (the `API_TOKEN` shared-token shim was removed — see the Tech Stack table above for the current model and its source files). Every router endpoint requires a valid `Authorization: Bearer <token>` session; there is no fail-open mode, so a fresh environment has no way in until at least one user exists — see Seeding below.

**Seeding.** `seed/run_all.py` runs both domains' seeders in one transaction: rooms, doctors, system counters, and the master template (clinical), plus reception coverage rules (`seed_reception_coverage.py`) — see `architecture-clinical.md`'s "Seeds" section for the clinical seeders and `architecture-reception.md` for why reception staff themselves are deliberately *not* seeded. Run manually from a local machine against Railway's public Postgres URL (`DATABASE_PUBLIC_URL`). There is deliberately no clinic-type seed either — clinic types are entered via the frontend. `setup.csv` remains in the repo as reference data only.

`seed/seed_users.py` bootstraps the first login and is deliberately separate from `run_all.py` — a one-off, run manually the same way, reading `SEED_USER_EMAIL`/`SEED_USER_NAME`/`SEED_USER_PASSWORD` from the environment with no hardcoded fallback. Idempotent: re-running it against an email that already exists is a safe no-op. This is also the recovery path if every user is somehow deactivated (auth plan, Design Decision 9) — every other user is managed from the Users page instead once at least one active login exists. Shared by both domains: there is one `users` table, not one per domain.

## Document Index

| Document | Contents |
|---|---|
| architecture-clinical.md | The clinical (doctor) rota in full: generation engine, data layer, REST API, staging, leave planning, frontend grids and editing. Load this for any clinical-rota task |
| architecture-reception.md | The reception (staff) rota in full: data model, routers, coverage validation, frontend grids. Load this for any reception-rota task |
| documentation/phase_pipeline.md | Phase sequence 0–12 as implemented (clinical engine only): purpose, reads/writes, execution order, including Phase 9C's supervision assignment and Phase 12's six validation checks |

The `docs/domain-model.md` document referenced by earlier versions of this index was abandoned during the M2 rewrite and never existed at that path; there is nothing to link.
