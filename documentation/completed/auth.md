# Plan

Replace the shared-token shim (`API_TOKEN` env var, `X-API-Token` header) with real per-user authentication: email/password login, DB-backed sessions, an in-app Users page, and a logout affordance. Single role — no admin tier. The system is not yet live, so no data preservation is required.

# Scope

**In scope:**
- `users` and `sessions` tables (migration 010), SQLAlchemy models, seed script for the first user.
- Backend: `deps.py` rewrite (bearer-token session auth, no fail-open), new `/auth` router (login/logout/me), new `/users` router (list/create/edit/deactivate/reset-password) with a last-active-user 409 guard.
- Frontend: `client.ts` header change, `TokenGate` becomes a real login screen with proactive auth check, logout in the app shell, new `/users` route with full CRUD page modelled on the Doctors page.
- Test suite: conftest auth override, wholesale replacement of `test_auth.py`, new `test_users.py`, frontend test updates for the header and gate changes.

**Explicitly out of scope:** MFA, rate limiting on login attempts, email-based password reset, audit logging, account lockout after failed attempts, "remember me" / sliding expiry, roles/permissions.

# Design Decisions

1. **Password hashing: `bcrypt`** as a direct dependency (not `passlib`, which is effectively unmaintained). Default cost factor. Note: bcrypt silently truncates input at 72 bytes; enforce a max password length of 72 characters at the Pydantic layer so the limit is visible rather than silent.
2. **Session token:** opaque `secrets.token_urlsafe(32)`, returned to the client exactly once on login. Only its SHA-256 hex digest is stored in `sessions.token_hash`. Lookup is by hash, so a DB leak does not leak usable tokens.
3. **Transport:** `Authorization: Bearer <token>`. One-line changes in `client.ts` and `deps.py`.
4. **Expiry:** fixed 30 days from login, no sliding renewal. Logout deletes the session row. Login lazily deletes that user's expired session rows (one extra DELETE, no cron job).
5. **Revocation on deactivate:** `get_current_user` checks `user.active` on every request, so deactivating a user takes effect immediately without hunting their sessions.
6. **No fail-open.** The `API_TOKEN` env var and all references to it are removed entirely. Every router endpoint 401s without a valid session. `/health`, `/docs`, `/openapi.json` remain open (they live outside the routers).
7. **No CSRF handling:** a bearer token in a header (not a cookie) is not CSRF-exploitable. Accepted tradeoff: the token lives in localStorage and is therefore readable by any XSS. For an internal tool with a small trusted user base this is acceptable and is a documented decision, not an oversight.
8. **Trust model:** single role. Any logged-in user can create, edit, deactivate, and reset the password of any other user. Password recovery = a teammate resets you via the Users page. This is the deliberate recovery story (no email infrastructure exists).
9. **Lock-out guard:** `PATCH /users/{id}` refuses with 409 to set `active=false` on the last remaining active user. Absolute last resort if everyone is somehow deactivated: re-run `seed_users.py` against Railway.
10. **Password rules:** minimum 8 characters, maximum 72, nothing else.
11. **`get_current_user` return shape:** returns the `User` ORM object. Nothing downstream currently reads the old `{"user": "admin"}` dict, so this is a safe upgrade and gives `/auth/me` its data for free.
12. **Migration number is 010** — 009 is already taken by `009_doctors_signatures.py`. Revision "010", down_revision "009".

---

# Task 1: Data model, migration 010, seed script

**A.** State of the world: the app has 19 tables (through migration 009, doctor signatures) and a token-shim auth seam in `deps.py`. Nothing auth-related exists in the schema. This task adds the two auth tables and the bootstrap path; no existing file changes except the models package `__init__`.

**B.** Files:
- New: `backend/app/models/user.py` (User, Session models)
- Edit: `backend/app/models/__init__.py` (export both)
- New: `backend/alembic/versions/010_users_sessions.py`
- New: `backend/seed/seed_users.py`
- Edit: `backend/pyproject.toml` (add `bcrypt`)
- Tests: extend `backend/tests/test_models.py` (or a new small test module) with round-trip and constraint tests

**C.** Instructions:
- `users`: `id` (int PK), `email` (String, unique, nullable=False), `name` (String, nullable=False), `password_hash` (String, nullable=False), `active` (Boolean, nullable=False, default True), `created_at` (DateTime(timezone=True), nullable=False).
- `sessions`: `id` (int PK), `token_hash` (String, unique — the unique constraint doubles as the lookup index, same pattern as 009), `user_id` (FK to users.id, nullable=False, indexed), `created_at`, `expires_at` (both DateTime(timezone=True), nullable=False).
- No DB-level ON DELETE CASCADE (none exists anywhere in this schema); use ORM `relationship(..., cascade="all, delete-orphan")` from User to Session, consistent with GeneratedRota/RotaSession.
- Migration: revision "010", down_revision "009", additive only, no enums (so none of 001/002's enum handling applies — say so in the docstring, matching house style). `downgrade()` drops `sessions` before `users`.
- `seed_users.py`: same pattern as `seed_doctors.py`. Creates one user from env vars `SEED_USER_EMAIL`, `SEED_USER_NAME`, `SEED_USER_PASSWORD` (fail loudly if unset — do not fall back to hardcoded credentials). Idempotent: if a user with that email exists, print and exit without error. Hash with bcrypt. Do NOT add it to `run_all.py` — it is run manually, exactly once, against Railway's `DATABASE_PUBLIC_URL`.
- Do not touch `deps.py` or any router in this task.

# Task 2: Backend auth core — deps.py, /auth router

**A.** Data model changes are complete: User and Session models exist, migration 010 is in place, bcrypt is a dependency. This task replaces the token shim with session auth and adds login/logout/me. The full API test suite will fail after this task until Task 4 fixes the conftest — that is expected; Tasks 2–4 should land as one commit or in immediate succession.

**B.** Files:
- Edit: `backend/app/api/deps.py`
- New: `backend/app/api/routers/auth.py`
- New: `backend/app/api/schemas/auth.py`
- New: `backend/app/api/auth_utils.py` (or similar): `hash_password`, `verify_password`, `hash_token`, `new_session_token` — shared by routers, seed script, and tests
- Edit: `backend/app/api/main.py` (register the auth router)
- Edit: `backend/app/api/routers/__init__.py`, `backend/app/api/schemas/__init__.py`

**C.** Instructions:
- `get_current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User`:
  - Parse `Bearer <token>`; 401 on missing/malformed header.
  - SHA-256 the token, look up `sessions.token_hash`, join to user; 401 if no row, expired (`expires_at < now`), or `user.active` is False. Single 401 detail string for all cases — do not leak which check failed.
  - Remove all `API_TOKEN` / `os.environ` / `X-API-Token` logic. Update the module docstring (it currently describes the M3.5 shim).
- `/auth` router (registered under `/api/v1/auth`):
  - `POST /login` `{email, password}` -> `{token, user: UserOut}`. Verify bcrypt; on success delete that user's expired sessions (Decision 4), create a session with 30-day expiry, return the raw token. 401 on bad email or password (same message for both). Inactive users cannot log in.
  - `POST /logout` (authenticated): delete the session row for the presented token, 204.
  - `GET /me` (authenticated): return `UserOut` for the current user.
- `UserOut`: `id, email, name, active, created_at`. Never include `password_hash` in any schema.
- Login must use bcrypt verification even for nonexistent emails is NOT required (timing-attack hardening is out of scope) — a plain early return on unknown email is fine.

# Task 3: Backend /users router

**A.** Auth core is complete: `get_current_user` validates bearer sessions, `/auth` provides login/logout/me, and password/token utilities exist in `auth_utils.py`. This task adds user management endpoints following the doctors-router conventions (soft delete via `active`, IntegrityError-to-409 for duplicates).

**B.** Files:
- New: `backend/app/api/routers/users.py`
- Edit: `backend/app/api/schemas/auth.py` (add UserIn, UserPatch)
- Edit: `backend/app/api/main.py`, routers/schemas `__init__` exports

**C.** Instructions:
- `GET /users`: all users (including inactive), ordered by name.
- `POST /users` `{email, name, password}`: bcrypt-hash, create active user. Duplicate email -> catch IntegrityError on commit, map to 409 (house convention — no pre-check).
- `PATCH /users/{id}`: partial update of `email`, `name`, `active`, and optional `password` (write-only field; when present, re-hash and also delete all of that user's sessions so a reset kicks out any holder of the old token).
  - **Guard (Decision 9):** if the patch sets `active=False` and the target is currently the last active user, 409 with a clear detail ("cannot deactivate the last active user"). Count check inside the same transaction.
  - Deactivating any other user is allowed, including yourself (the guard makes self-deactivation safe).
- No DELETE endpoint — soft delete only, matching doctors.
- Password validation: min 8 / max 72 via Pydantic on both POST and PATCH.

# Task 4: Backend test suite migration

**A.** Tasks 1–3 are complete; the API now 401s everything, which breaks every existing API test. This task is the highest-blast-radius step: fix the shared fixture, replace the auth tests, and add users tests.

**B.** Files:
- Edit: `backend/tests/test_api/conftest.py`
- Replace: `backend/tests/test_api/test_auth.py`
- New: `backend/tests/test_api/test_users.py`

**C.** Instructions:
- In the `client` fixture, add `app.dependency_overrides[get_current_user] = lambda: _test_user` alongside the existing `get_db` override, and pop it in the same `finally`. `_test_user` can be a lightweight stub object with the User attributes routers touch (at minimum `id`, `email`, `name`, `active=True`) — it does not need a DB row, because overridden dependencies bypass `get_current_user` entirely. If any router turns out to need a real FK to users, create a real row in the fixture instead; prefer the stub until forced.
- Every other test file should pass unchanged after this — that is the acceptance check for the fixture edit. Run the full suite.
- New `test_auth.py` (real auth path, using `client_no_auth` — add a second fixture identical to `client` but WITHOUT the `get_current_user` override, sharing the same DB override):
  - 401 with no header / malformed header / unknown token.
  - Login happy path returns a token; token works on a protected endpoint via `Authorization: Bearer`.
  - Wrong password 401; unknown email 401; inactive user cannot log in.
  - Expired session 401 (insert a session row with past `expires_at` directly via `db_session`).
  - Deactivating a user mid-session: their existing token 401s on the next request.
  - Logout deletes the session; token 401s afterwards.
  - Login cleans up that user's expired session rows.
  - `/health` still open with no auth.
- `test_users.py` (can use the overridden `client` for CRUD, `client_no_auth` where session interaction matters):
  - List/create/patch happy paths; duplicate email 409.
  - Password reset re-hashes and deletes the target's sessions.
  - Last-active-user deactivation 409; deactivating a non-last user succeeds.
  - `password_hash` never appears in any response body.

# Task 5: Frontend auth — client, login screen, logout

**A.** Backend is complete and its test suite green: bearer-session auth with `/auth` and `/users` endpoints. This task converts the frontend from reactive token prompt to a real login flow. Frontend-only; run Vitest.

**B.** Files:
- Edit: `frontend/src/api/client.ts` (+ `client.test.ts`)
- New: `frontend/src/api/auth.ts` (+ test): login/logout/me API functions and TanStack hooks
- Edit: `frontend/src/auth/tokenStore.ts` (likely unchanged logic; rename storage key)
- Rewrite: `frontend/src/auth/TokenGate.tsx` (+ test) — becomes `LoginGate` (keep the file/component name TokenGate if renaming causes churn; implementer's choice, but be consistent)
- Edit: `frontend/src/App.tsx` (logout affordance in the fixed left nav)
- Edit: `frontend/test/msw/handlers.ts` if shared handlers need auth endpoints

**C.** Instructions:
- `client.ts`: replace the `X-API-Token` header with `Authorization: Bearer ${token}`. Everything else (401 listener, error shaping, FormData handling) unchanged. Update `client.test.ts` header assertions.
- Gate behaviour:
  - On mount, if a token exists in localStorage, call `GET /auth/me`. Success -> render children. 401 -> clear token, show login form. No token -> login form immediately (do not wait for a request to fail).
  - Keep the existing `onUnauthorized` wiring so a mid-session 401 (expired/revoked) also drops to the login form.
  - Login form: email + password, submit calls `POST /auth/login`, stores the token, calls `queryClient.resetQueries()` (preserve the existing deliberate reset behaviour and its comment), renders children.
  - Show a generic "invalid email or password" error on 401 from login.
- Logout: nav button calls `POST /auth/logout` (ignore failures), clears the token, calls `queryClient.clear()`, returns to the login form.
- Tests: mount-with-valid-token renders children; mount-with-no-token shows form without firing protected requests; successful login stores token and resets queries; failed login shows the error; logout clears token and shows the form.

# Task 6: Frontend Users page

**A.** Login/logout works end to end. This task adds the `/users` management page. The Doctors CRUD (`DoctorsPage.tsx`, `DoctorFormDialog.tsx`, `doctors.ts`, `doctorSchema.ts` and their tests) is the structural template — copy its patterns rather than designing from scratch.

**B.** Files:
- New: `frontend/src/api/users.ts` (+ test)
- New: `frontend/src/lib/userSchema.ts` (+ test) — zod: email format, name required, password min 8 / max 72 (required on create, optional on edit)
- New: `frontend/src/components/UserFormDialog.tsx` (+ test)
- New: `frontend/src/routes/UsersPage.tsx` (+ test)
- Edit: `frontend/src/App.tsx` (route + nav entry)

**C.** Instructions:
- List all users with active/inactive state (follow the Doctors page's presentation of inactive rows).
- Create dialog: email, name, password. Edit dialog: email, name, optional new password ("leave blank to keep current" — this doubles as the reset-password mechanism, no separate flow needed).
- Deactivate/reactivate toggle via PATCH. Surface the backend's 409 for the last active user as a toast/inline error using the existing error-mapping conventions (`mapValidationErrors.ts`, `Toast.tsx`).
- Confirm-style warning when deactivating yourself is optional polish, not required — the backend guard is the safety net.

# Task 7: Deployment, cleanup, docs

**A.** Feature-complete and tested. This task removes the shim's remains and lands the operational pieces.

**B.** Files:
- Edit: `ci.yml` only if it references `API_TOKEN` (check; likely no change)
- Sweep: any remaining `API_TOKEN` / `X-API-Token` references in code, comments, `.env.example`
- Docs: architecture.md updates are maintained by the user — flag the affected sections rather than editing unprompted

**C.** Instructions:
- Grep the whole repo for `API_TOKEN` and `X-API-Token`; remove every remaining reference.
- Railway: run `alembic upgrade head`, run `seed_users.py` once with the three `SEED_USER_*` env vars against `DATABASE_PUBLIC_URL`, delete the `API_TOKEN` env var from the Railway dashboard.
- Deployment verification: unauthenticated `curl` to any `/api/v1` endpoint returns 401; login via the UI works; `/health` returns 200.
- Architecture sections needing user updates: Outstanding Tasks table (remove Auth row), Tech Stack auth row, Infrastructure "Auth seam" paragraph, deployment env vars (`API_TOKEN` removed, `SEED_USER_*` documented as one-time), Frontend Authentication Boundary section, and the deployment checklist item about 401-without-header (now inherent rather than env-dependent).
