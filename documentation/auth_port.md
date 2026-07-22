# Provisional Plan: Porting Admin Auth from Econsult to Rota Generator

Status: DRAFT — for review before any code is written.
Source system: Econsult (this project). Target system: Rota Generator (separate project/repo).

---

## 1. Ground Rules

- This creates **two copies** of the auth system, not one shared one. A future fix or
  policy change (e.g. bcrypt cost factor, zxcvbn threshold, lockout duration) must be
  applied in both codebases by hand. Nothing enforces this. Accepted tradeoff per prior
  discussion — noted here so it's written down, not just said out loud.
- The rota generator needs **its own Postgres database** (or at minimum its own schema)
  with its own `admin_users`, `admin_sessions`, `admin_auth_codes` tables. This is not
  optional — session validation reads from a database, not from a portable token.
- Anything below marked **[REWRITE]** means: the logic/pattern is being reused, but the
  file itself is not a drop-in copy — it needs to be re-authored against the rota
  generator's own app structure.
- Anything marked **[COPY]** means: close to a direct copy, adapted only for import
  paths and naming.
- Anything marked **[NEW]** means: doesn't exist yet in econsult in portable form and
  needs to be built for the rota generator specifically.

---

## 2. Dependency Order

Build in this order — each stage depends on the one before it.

### Stage 1 — Database schema
- **[REWRITE]** New Alembic migration (modelled on `0004_password_auth.py`) creating
  `admin_users`, `admin_sessions`, `admin_auth_codes` in the rota generator's database.
  Reference `0002_user_management_cascade.py` too if the rota generator needs
  user-deletion cascade behaviour.
- One-off manual step to seed admin users

### Stage 2 — Core auth logic (backend)
- **[COPY]** `auth_service.py` — password hashing (bcrypt), OTP generation/hashing,
  timing-attack mitigation (`_fixed_delay`, dummy-hash comparison), zxcvbn password
  scoring. Self-contained; lowest risk of the whole plan.
- **[REWRITE]** `auth_repository.py` — same queries/shape, but written against the
  rota generator's own connection pattern (check its `db.py` equivalent once that
  project has one).
- **[NEW]** zxcvbn + bcrypt added to the rota generator's `requirements.txt`, pinned
  to versions compatible with whatever frontend zxcvbn-ts version is chosen (see
  Stage 5). This pairing was flagged as a coordination point in econsult's own
  security doc — same risk applies here.

### Stage 3 — Session handling
- **[REWRITE]** `admin_context.py` equivalent — session cookie validation dependency.
  Needs the rota generator's own `SESSION_COOKIE_NAME`, `SESSION_COOKIE_MAX_AGE`,
  `SESSION_TTL_MINUTES` constants (can reuse econsult's values as defaults).
- **[NEW]** Wiring in the rota generator's own `dependencies.py` — `get_auth_repo`,
  `get_audit_repo` (if audit logging is included, see Stage 6), following the same
  `request.app.state` pattern econsult uses. This has to be built fresh; econsult's
  `dependencies.py` is not importable as-is, it's a pattern to mirror.
- **[NEW]** Startup wiring in the rota generator's `main.py` — instantiate the auth
  repo, store it on `app.state`, and fail-fast if required env vars are missing
  (mirrors econsult's `main.py` startup validation pattern).

### Stage 4 — HTTP endpoints
- **[COPY, with trimming]** `admin_auth_router.py` — `/auth/login`, `/auth/verify`,
  `/auth/request-reset`, `/auth/set-password`, `/auth/logout`. Logic transplants
  almost directly; decide up front whether audit logging (Stage 6) is in scope before
  copying, since several endpoints currently treat a failed audit write as a hard 500. yes audit logging is in scope
- **[COPY]** `rate_limit.py` — SlowAPI setup, in-memory storage, `extract_ip` from
  `http_utils.py`. Easy to port, easy to forget — flagging explicitly so it isn't
  dropped silently.
- **[COPY]** `errors.py` equivalents needed by the router — `APIError`,
  `INVALID_PAYLOAD`, and the `INVALID_CREDENTIALS` / `WEAK_PASSWORD` /
  `INVALID_RESET_TOKEN` error codes.

### Stage 5 — Frontend
- **[COPY]** `LoginView.tsx`, `SetPasswordView.tsx` — close to drop-in, adjust API
  base URL and any econsult-specific branding/copy.
- **[NEW]** Equivalent slice of `api.ts` / `types.ts` for the rota generator's own
  frontend — the auth-related calls (`login`, `verify`, `requestReset`, `setPassword`,
  `logout`) and their response types.
- **[NEW]** zxcvbn-ts added to the rota generator's frontend `package.json`, version
  paired with the backend `zxcvbn` version per Stage 2.

### Stage 6 — Audit logging (decision point, not automatic)
- Econsult treats an audit trail as mandatory for every auth event — this is a Cyber
  Essentials Plus compliance control there, not incidental logging.
- Decide explicitly: does the rota generator need the same compliance posture? If
  yes: **[REWRITE]** `audit_repository.py` and an `admin_audit_router.py` equivalent,
  plus an `audit_log` table in Stage 1's migration. If no: strip audit calls out of
  the copied router in Stage 4 — but note this is a real reduction in security/
  compliance posture versus the source system, not a neutral simplification. Yes we should add audit logging

### Stage 7 — Email delivery
- **[REWRITE]** `AdminDeliveryService` / `MailgunHttpAdminDeliveryService` equivalent.
  You own the Mailgun account, which removes the account-setup step, but decide:
  same sending subdomain/DKIM as econsult, or a separate one for the rota generator.
  Separate is cleaner (keeps bounce/complaint reputation isolated per system) but is
  another piece of one-off setup.
- **[NEW]** Rota-generator-specific email copy for the OTP and invitation emails.

### Stage 8 — Tests
- **[REWRITE]** Port `test_admin_auth_router.py` and `admin_test_helpers.py` patterns.
  Per the project's own standing rule: do not deploy this auth code without a test
  suite alongside it. This is not optional scope — it's where most of the real
  confidence in a security-sensitive port comes from.
- Confirm the rota generator's CI (GitHub Actions) has an equivalent two-database
  rule and integration-test gate before these tests are wired in, per
  `arch_testing.md`'s pattern in this project.

### Stage 9 — Deployment
- **[NEW]** Environment variables on Railway for the rota generator service:
  database URL, `ALLOWED_ADMIN_DOMAINS`, Mailgun credentials, session secret material.
- Confirm domain/cookie strategy: since this is a genuinely separate app (not sharing
  sessions with econsult per the earlier discussion), there's no cross-domain cookie
  concern — each system's cookie is scoped to its own domain.

---

## 3. Explicitly Out of Scope for This Port

- MFA delivery isolation between "admin auth" and "patient/clinical" traffic —
  econsult separates these because clinical data delivery and auth delivery share an
  account; the rota generator likely has no clinical delivery path, so this isolation
  pattern may not apply. Revisit if that assumption changes.
- MESH/NHS-specific integration (`arch_mesh.md`, `arch_security.md` section 8) — not
  applicable to a rota generator, no action needed.
- Single-tenant startup validation ("exactly one practice exists") — econsult-specific
  invariant; rota generator will need its own equivalent tenancy assumption defined,
  not this one copied verbatim.

---

## 4. Open Questions Before Coding Starts (1-3 answered, 4 to be determined)

1. Same admin user list as econsult, or a separate one? (Affects Stage 1.) separate user list
2. Is a compliance-grade audit trail actually needed for the rota generator, or is
   basic logging sufficient? (Affects Stage 4 and Stage 6 scope significantly.) compliance grade audit trail is in scope
3. Same Mailgun sending subdomain as econsult, or a new one? (Affects Stage 7.) separate subdomain
4. Does the rota generator already have any app skeleton (FastAPI app, `main.py`,
   `db.py` connection pattern), or is this port happening into an empty project?
   This changes how much of Stage 3's "[NEW] wiring" already exists.