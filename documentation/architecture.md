# Rota Generator — Architecture Hub

Read this file first. It covers what's shared across the whole app; the two rota types each have their own detailed architecture doc, and you should only read the one relevant to what you're working on.

## Domains

The app is two independent rota systems sharing one deployment, one login, and one app shell:

- **`documentation/architecture-clinical.md`** — the clinical rota: the generation engine (`backend/app/engine/`), doctors/rooms/clinic types, leave, duty, closures, staging, master rota, and the whole `RotaGrid`/`MasterRotaGrid`/`StagingGrid` frontend. This is almost all of the app's complexity, and reception doesn't touch any of it.
- **`documentation/architecture-reception.md`** — the reception rota: reception staff, the weekday master template, generated day rotas, and phone-coverage rules. Small, self-contained schema and API (`/reception/*`), its own `ReceptionShell` and grids. Shares nothing with the clinical rota except what's described below.

## Overview

A rota generator for a medical practice: generates a working rota from a master template over a configurable 1–4 week period, applying annual leave, duty assignments, clinic assignments, and room allocations, with interactive editing (drag-and-drop, cell edit menus, WFH, undo) in a web UI. Ported from a Google Apps Script project attached to a Google Spreadsheet, which it replaces; the port removed GAS's 6-minute execution limit. The reception rota is a later, independent addition covering front-desk phone-coverage scheduling — see "Domains" above.

**Status:** feature-complete and deployed to production (Railway, PostgreSQL), seeded, and verified end to end — a non-technical admin can generate, edit, and validate a rota without touching the API, including one-off holiday-cover changes via the staging step (see "Staging" and "Frontend: Staging" in `documentation/architecture-clinical.md`) without editing the master template. Access control is real per-user email/password login with DB-backed sessions (the earlier shared-token shim has been fully replaced). Outstanding work is listed below.

## Outstanding Tasks

| Task | Scope | Priority | Notes |
|---|---|---|---|
| Master rota bulk row operations | Python + React | Low | "Remove all of a leaver's sessions", "copy week 1 to weeks 2–4", "populate a new doctor's full week". Single-slot create/delete covers the common case; revisit only if the per-slot workflow proves too slow in practice |
| Master rota multi-template management | Python + React | Low | Create/activate/rename templates. Currently the single seeded active template (`MasterRotaTemplate.is_active`, resolved deterministically by the GET) |
| Add role information to room rota cells | Python | Medium | Room-centric view is a deferred frontend transformation; cells should display doctor role alongside code |

All three of these are clinical-rota tasks — see `documentation/architecture-clinical.md`.

## Shared Frontend Infrastructure

The parts of the React app used by both rota types: routing shell, login/session handling, and the base HTTP client. Reference data pages, grids, and per-resource hooks are domain-specific and documented in each domain's own architecture doc.

### Application Shell & Providers

- **main.tsx** — the composition root. Creates the `QueryClient` (custom retry policy: no retries on any 4xx, since they will not succeed on retry; 5xx/network capped at 2 — so a 401 surfaces the login form immediately) and renders `QueryClientProvider > LoginGate > App`.
- **App.tsx** — routing and layout only, no providers: a top-level `BrowserRouter` (React Router v7, declarative mode — TanStack Query owns all server state, so no router loaders/actions) mounting three things — `/` (**LandingPage**, the shared entry point: two tiles, "Clinical Rota" and "Reception Rota", linking to `/clinical` and `/reception` respectively, nothing else on the page), `/clinical/*` (`ClinicalShell`), and `/reception/*` (`ReceptionShell`, added by the reception rota work — see `documentation/architecture-reception.md`). `ClinicalShell` renders a fixed left nav with a logout button and **sixteen page routes** (Rota list/detail, Staging, Master Rota, Clinic Types, Doctors, Leave, Leave Planning, Extra Sessions, School Holidays, Duty, Closures, Recurring Notes, Counters, Signatures, Users) — seventeen `<Route>` elements, the extra one being the pathless Session Management layout route described below. `ReceptionShell` is a separate, simpler shell with its own six-item nav and **six routes** (Day Rota, Master Template, Leave, Reception Staff, Coverage Rules, Hours) — no route, component, or nav item is shared between the two shells. [Three prior counts here — "ten routes", "twelve routes", then "fifteen routes" — were each already stale by the time they were read; this one is counted directly against `App.tsx`'s `<Route>` elements rather than incremented from the last stale figure, and should be re-counted the same way, not incremented, the next time a route changes.]

  The clinical left nav is **not** flat: the five session-planning pages (Annual Planner, Individual Leave, Extra Sessions, Closures, School Holidays) are collapsed into a single **Session Management** entry, which points at the first sub-tab and switches between the five with the horizontal tab bar in `components/SessionManagementTabs.tsx`. That module owns the tab list and exports it, because `App.tsx` needs both the first tab's path (where the parent entry links) and the whole path set — `NavLink`'s own `isActive` cannot match sibling paths, so without an explicit `groupPaths` check the parent entry would un-highlight the moment you changed sub-tab. The tab bar is rendered by a **pathless layout route** wrapping the five, not by the five pages themselves, so it exists in one place and cannot drift; those pages consequently render no `<h1>` of their own, the active tab being the heading. The grouping is presentational only — every path is unchanged from when these were five top-level entries, so existing links and bookmarks still resolve. Nav structure is covered by `src/App.test.tsx`, which drives the real `App` via `window.history` (it owns its own `BrowserRouter`, so `renderWithProviders`' `MemoryRouter` cannot reach it).

### Authentication Boundary

Enforcement is server-side (`get_current_user()` in `deps.py`); the frontend's job is a real login form, attaching the session token, and recovering when it is missing or invalid.

- **client.ts** attaches `Authorization: Bearer <token>` to **every** request (the whole API is gated, reads included), from `tokenStore.ts` (localStorage, so the token survives reloads). On any 401 it invokes the single listener registered via `onUnauthorized()`; `triggerUnauthorized()` lets the logout flow fire that same listener without a real 401 having occurred.
- **auth/LoginGate.tsx** (renamed from `TokenGate` when the shared-token prompt was replaced with real login) wraps the entire app. No stored token shows the login form immediately with no request fired. A stored token calls `GET /auth/me` to verify it before trusting it — renders nothing while that check is in flight, success renders children, a 401 clears the stale token and falls back to the form. Also listens for the `onUnauthorized` broadcast mid-session, so an expired or revoked session drops back to the login form from anywhere in the app. On successful login it stores the token and calls `queryClient.resetQueries()` explicitly, for the same "don't rely on incidental remount behaviour" reason as before.
- **Logout** lives in `App.tsx`'s nav (not LoginGate): `POST /auth/logout` is best-effort (a network failure must not block getting back to the login form), then the token is cleared, `queryClient.clear()` drops all cached data, and `triggerUnauthorized()` shows the login form immediately.

### API Communication

- **client.ts** — centralised HTTP client over `/api/v1` (relative base by default: Vite proxy in dev, same-origin static mount in production; `VITE_API_BASE_URL` overrides). Non-2xx responses throw a plain `ApiError` object (`{status, detail}`), never an `Error` instance; 204 resolves to `undefined`.
- **types.ts** — hand-written mirrors of the wire contract (the Pydantic schemas' JSON shapes, with `Out` suffixes dropped: `ValidationIssue`, `Doctor`, `RotaSession`, ...). Enum types mirror `enums.py` by *value* (`"draft"`, not `"DRAFT"`). Also carries the TanStack Query `Register` augmentation setting `defaultError: ApiError`, so every `useQuery`/`useMutation` error is typed correctly with no per-hook generics. These mirrors drift silently until a `tsc` failure forces a fix — the known cost of not generating them from the OpenAPI spec.
- **Per-resource hook modules** (`api/doctors.ts`, `api/clinicTypes.ts`, `api/leave.ts`, `api/duty.ts`, `api/counters.ts`) — TanStack Query hooks with hierarchical query keys; mutations invalidate their resource's key root rather than splicing caches (the rota and master-rota grids use cache splicing instead; reference data is cheap to refetch). These modules are all clinical-side; reception has its own equivalent hooks documented in `documentation/architecture-reception.md`.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI under `/api/v1`, SQLAlchemy 2.0, Alembic |
| Database | PostgreSQL (production, Railway) / SQLite (dev and tests) |
| Generation engine | Pure Python (`backend/app/engine/`), no FastAPI dependency |
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS v3.4, served same-origin by FastAPI from `frontend/dist` |
| Server state | TanStack Query |
| Drag-and-drop | `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` (the older, stable dnd-kit generation, chosen over the pre-1.0 `@dnd-kit/react` rewrite). `core` alone drives the rota grid's chip drag/drop; `sortable` adds list-reorder UIs (`DoctorFormDialog` preferred rooms, `ClinicTypesPage` enabled clinic types) |
| Forms | Zod for validation; plain React state, no form library |
| UI primitives | Radix UI, installed per-primitive (`react-popover`, `react-dialog`) |
| Auth | Per-user email/password login, DB-backed sessions (`users`/`sessions` tables). `Authorization: Bearer <token>`, opaque token hashed (SHA-256) before storage, 30-day fixed expiry, no fail-open — every router endpoint requires a valid session. Single role, no admin tier: see `backend/app/api/routers/users.py`, `backend/app/api/deps.py` |
| Packaging | `uv` + `pyproject.toml` (hatchling) backend; `npm` frontend, Node 24 pinned via `engines` and matched in CI |
| Testing | pytest (engine + API, SQLite) + Postgres migration round trip, via GitHub Actions; Vitest + React Testing Library + MSW for the frontend |

## CI (`ci.yml`)

Three independent jobs on every push and pull request:

1. **Backend test suite** — `uv sync --extra dev`, then the full pytest suite (engine + API) on in-memory SQLite. API tests run `TestClient` with `get_db` dependency-overridden to a fresh SQLite engine per test. Two client fixtures: `client` also overrides `get_current_user` with a stub user, so most tests don't need to authenticate to exercise a route; `client_no_auth` leaves `get_current_user` un-overridden to exercise the real login/session path (auth plan, Task 4) — see `backend/tests/test_api/conftest.py`.
2. **Postgres migration validation** — upgrade/downgrade/upgrade round trip against a `postgres:16` service container, proving both migration directions and native enum type cleanup against a real Postgres before Railway ever runs a migration.
3. **Frontend gate** — Node 24, `npm ci` (requires `frontend/package-lock.json` committed), then typecheck / vitest / build, in that order so a fast typecheck failure doesn't wait on the slower build.

## Deployment

Single Railway service deployed from the GitHub repo, Root Directory `/` (repo root — both `backend/` and `frontend/` must be inside one build context, since FastAPI serves the built frontend same-origin).

**Build (`nixpacks.toml`, repo root).** Drives the Nixpacks build plan explicitly rather than relying on provider auto-detection, since neither `backend/pyproject.toml` nor `frontend/package.json` sits at the scanned root — `providers = ["python", "node"]` only puts the runtimes on PATH; every install/build command is written out with an explicit `cd`. Python installs into a manually created venv at `/opt/venv` (the nixpkgs `python3` has no bundled pip; `python3 -m venv` bootstraps one), which persists into the runtime image but is not on PATH at runtime. `frontend/dist` is built here. Node is pinned by overriding the whole `node:setup` phase (`nixPkgs = ["nodejs_24"]` plus a `nixpkgsArchive` on the nixos-25.05 revision) rather than by `NIXPACKS_NODE_VERSION`: that variable only changes the attribute name requested, and nixpacks v1.41's own node archive is a Nov 2024 snapshot with no `nodejs_24` in it and nothing else new enough for vite 8. Bump the archive, not just the package name, to move Node later. Deliberately no `[start]` section — the start command lives in exactly one place.

**Run (`railway.toml`, repo root).** `[deploy] startCommand` runs migrate-then-serve: `cd backend && /opt/venv/bin/alembic upgrade head && /opt/venv/bin/uvicorn app.api.main:app` — idempotent, so repeat deploys are safe. Health check on `/health`. The `/opt/venv/bin/*` prefixes are required, not stylistic: the venv persists into the runtime image but is not on PATH there.

**Serving.** FastAPI mounts `frontend/dist` at `/` (`mount_frontend()`; path overridable via `FRONTEND_DIST`) only if the directory and its `index.html` both exist, so a half-built dist never mounts. Registered routes always beat the mount; `SPAStaticFiles` serves `index.html` as the fallback for unknown non-API paths so client-side routes survive a hard refresh, while `/api/*` misses stay real JSON 404s. No cache-control headers are set — if stale-frontend-after-deploy ever appears, that is where to look.

**Environment variables** (Railway dashboard):

- `DATABASE_URL` — the Railway Postgres service; must use the `postgresql://` scheme, not `postgres://`.
- `CORS_ORIGINS` — the production origin. Same-origin serving means the SPA never makes a cross-origin request, so this is hardening only; a correct value can only be verified via a cross-origin `curl`, not by watching the app work.

Auth has no env var of its own any more (the `API_TOKEN` shared-token shim was removed — see the Tech Stack table above for the current model and its source files). Every router endpoint requires a valid `Authorization: Bearer <token>` session; there is no fail-open mode, so a fresh environment has no way in until at least one user exists — see Seeding below.

**Seeding.** `seed/run_all.py` (rooms, doctors, system counters, master template) is run manually from a local machine against Railway's public Postgres URL (`DATABASE_PUBLIC_URL`). There is deliberately no clinic-type seed — clinic types are entered via the frontend. `setup.csv` remains in the repo as reference data only.

`seed/seed_users.py` bootstraps the first login and is deliberately separate from `run_all.py` — a one-off, run manually the same way, reading `SEED_USER_EMAIL`/`SEED_USER_NAME`/`SEED_USER_PASSWORD` from the environment with no hardcoded fallback, plus optional `SEED_USER_ACCESS_LEVEL` (defaults to `manager`). Idempotent: re-running it against an email that already exists is a safe no-op. This is also the recovery path if every user is somehow deactivated (auth plan, Design Decision 9), and — since migration 028 backfills every existing user as `nurse` (role-based auth plan, Design Decision 7) — the way a database ends up with a manager in it at all — every other user is managed from the Users page instead once at least one active login exists.

## Document Index

| Document | Contents |
|---|---|
| documentation/architecture-clinical.md | Clinical rota: generation engine, data layer, REST API, rota lifecycle, editing endpoints, staging, leave planning, and the clinical frontend (master rota, staging, generated rota grid) |
| documentation/architecture-reception.md | Reception rota: schema, `/reception/*` API, and frontend design decisions |
| documentation/completed/reception_rota.md | Full design-decision record for the reception rota, including provisional-plan corrections |
| docs/domain-model.md | Doctor types, room types, session structure, WFH, counter types, clinic types, eligibility and displacement rules — platform-agnostic |
| docs/phase-pipeline.md | Phase sequence 0–12 as implemented: purpose, reads/writes, execution order, including Phase 9C's supervision assignment and Phase 12's six validation checks |
