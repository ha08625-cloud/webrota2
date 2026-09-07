# Provisional Plan — Self-Service Password Reset via Mailgun

**Status: provisional.** Output of the discussion phase. To be reviewed,
corrected and expanded into an implementation plan in a fresh chat before
any code is written.

## Scope

Add self-service password reset: a "Forgot password?" link on the login
form, an emailed single-use link, and a page to set a new password.

**In scope:** a `password_reset_tokens` table, two unauthenticated `/auth`
endpoints, a Mailgun sender module, the frontend flows, tests.

**Out of scope:** email for anything else (no welcome emails, no
notifications); a general-purpose outbound email queue with retries;
account lockout after failed logins; changing the existing admin reset path
(`PATCH /users/{id}`), which stays as the fallback.

## Why

Reset is already possible today — any `user_admin` can set another user's
password via `PATCH /users/{id}` (`backend/app/api/routers/users.py:261`),
and that correctly deletes the target's sessions. The gap this closes is
the **lockout case**: the last remaining user administrator forgets their
password and nobody can let them back in. Convenience for ordinary staff is
a secondary benefit, not the justification.

## Design Decisions

### Email transport

- **Mailgun HTTP API**, not SMTP. One authenticated POST; no connection
  handling, no SMTP ports to get blocked on Railway.
- **EU region** — base URL is `https://api.eu.mailgun.net/v3/{domain}/messages`.
  The US URL (`api.mailgun.net`) returns a 401 that reads like a bad API
  key, so this is worth a comment in the code.
- **Reuse the existing verified domain** rather than adding a `rota.`
  subdomain. The domain already delivers to NHSmail from the practice's
  other project; a new subdomain would need fresh DNS and would restart the
  deliverability question from zero.
- **`MAILGUN_DOMAIN` and `MAILGUN_FROM` are separate env vars.** The
  sending domain (as listed in Mailgun's Sending → Domains) is not
  necessarily the From address's domain part. **Open item:** confirm from
  the dashboard whether the sending domain is
  `summertownhealthcentrechat.co.uk` or `mail.summertownhealthcentrechat.co.uk`.
- **Use a distinct From local-part** (e.g. `rota@…`) rather than the other
  project's `mail@…`, so the two projects are separable in Mailgun's logs
  and the email is recognisable to staff.
- **Accepted risk:** Mailgun's suppression list is per-domain and now
  shared with the other project. A staff member who bounces or reports spam
  there would be silently suppressed for rota resets too. Volume is tiny,
  and the admin reset path remains as the fallback. If someone reports
  never receiving a reset email, check the suppression list first.
- **Free tier: 3,000 emails/month.** Reset volume is negligible against
  that. If eligibility changes, switch to the lowest paid tier.

### Token model

- New table `password_reset_tokens`, following the `sessions` table's
  conventions exactly (`backend/app/models/user.py`): **only the SHA-256
  digest is stored**, never the raw token. `secrets.token_urlsafe(32)`,
  generated the same way as a session token. Reuse `new_session_token()`
  and `hash_token()` from `api/auth_utils.py` rather than writing new ones.
- **One hour expiry.** Long enough for someone to get to their inbox,
  short enough that a forwarded or logged link goes stale.
- **Single use — deleted on redemption**, along with every other
  outstanding reset token for that user.
- **Redeeming deletes all of the user's sessions**, matching what a
  password change already does. Someone resetting because they suspect
  compromise must get the attacker logged out.
- **Expired rows are swept lazily** on the next request for that user,
  the same idiom `login` already uses — no cron job.
- ORM-level cascade from `User` (`cascade="all, delete-orphan"`), no
  DB-level `ON DELETE CASCADE`, consistent with the rest of the schema.

### No enumeration, and the rate limit

- `POST /auth/forgot-password` **always returns 204** — unknown email,
  inactive user, throttled, or Mailgun failure alike. Anything else lets an
  unauthenticated caller test whether an address has an account, which
  would undo the care already taken in `routers/auth.py` to make login's
  two failure modes indistinguishable.
- **Throttle: one token per user per 3 minutes.** This endpoint is
  unauthenticated and sends email on demand, so without a limit anyone
  knowing a staff address can bomb their inbox and burn the monthly quota.
  No separate table is needed — since tokens are only deleted on redemption
  or expiry, the throttle is "does an unexpired unused token exist for this
  user, created less than 3 minutes ago". A throttled request returns 204
  and sends nothing.
- **Mailgun failure returns 204 too**, but logs at ERROR with the status
  and response body. The user sees "if that address is registered, we've
  sent a link" and, when nothing arrives, falls back to asking an admin.
  Surfacing the failure would leak that the address exists.
- **Missing `MAILGUN_API_KEY` logs a warning and no-ops**, so local dev and
  CI need no configuration. This is deliberately silent-but-loud: a
  production deploy missing the variable will look like emails vanishing,
  which is why it is WARNING and not DEBUG.

### Audit

- The audit middleware captures every non-GET request body with a
  redaction list (`backend/app/api/audit.py:67`). **`token` must be added
  to `_REDACTED_KEYS`** — otherwise every reset lands a live, unredeemed
  reset token in the audit log in plaintext, readable by any `user_admin`.
  `password` is already covered.
- No `record_audit_actor` call on `forgot-password`: there is no
  authenticated actor, and recording the resolved user would put "this
  address has an account" into the audit row for a request that
  deliberately refuses to say so. `reset-password` records the actor on
  success only, matching what `login` does and why.

### Frontend: why the reset page cannot be a route

`main.tsx` renders `QueryClientProvider > LoginGate > App`, and
`BrowserRouter` lives inside `App`. `LoginGate` renders the login form
*instead of* its children when there is no stored token. So a
`<Route path="reset-password/:token">` added to `App.tsx` **would never
render for the logged-out user it exists for** — they would get the login
form at that URL.

**`LoginGate` therefore owns all three views itself** (`login` | `forgot` |
`reset`), switching on local state, with the initial view chosen by reading
`window.location.pathname` on mount. After a successful reset it calls
`history.replaceState` back to `/` and shows the login form with an
explanatory message via the existing `signedOutReason` mechanism — which
already exists for exactly this shape of "you are back here on purpose".

Restructuring the app so the gate sits below the router would be the
cleaner long-term answer, but it touches the authentication boundary that
every page depends on, for one page's benefit. Not worth it here.

### Authorization tests

**No change needed.** `test_authorization.py` exempts the whole `/auth`
prefix (`_EXEMPT_PREFIXES`, line 87), and the `auth` router is already in
`main.py`'s `_UNGATED`. New POSTs there are covered without touching the
720-case sweep or its allowlists. Worth confirming on the first run rather
than assuming.

---

## Task 1: Data model and migration

**A.** Nothing done yet. This task adds the storage for reset tokens.

**B. Files:**
- `backend/app/models/user.py` — new `PasswordResetToken` model, plus the
  relationship on `User`
- `backend/app/models/__init__.py` — export it
- `backend/alembic/versions/011_password_reset_tokens.py` — new migration
- `backend/app/api/audit.py` — add `token` to `_REDACTED_KEYS`
- `backend/tests/test_models.py`, `backend/tests/test_auth_models.py` —
  coverage for the model and the cascade

**C.** Mirror `UserSession` closely: `id`, `token_hash` (unique
constraint, named `uq_password_reset_tokens_token_hash`), `user_id` (FK,
indexed), `created_at`, `expires_at`, all timezone-aware. Follow the
docstring conventions of the surrounding models — this codebase documents
*why* at module level, and a new model that doesn't will look foreign.
Migration must have a working downgrade; check the numbering is still `011`
before writing.

## Task 2: Mailgun sender

**A.** The token table exists. This task adds the ability to send an email;
nothing calls it yet.

**B. Files:**
- `backend/app/email.py` (new) — the sender
- `backend/pyproject.toml` — promote `httpx` from `[dev]` to main
  dependencies
- `backend/tests/test_email.py` (new)

**C.** One public function, roughly
`send_password_reset(to_email, name, reset_url) -> bool`. Read env vars at
call time, not import time, so tests can monkeypatch. Env:
`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM`, `APP_BASE_URL`
(= `https://webrota2-webrota2.up.railway.app`), and `MAILGUN_API_BASE`
defaulting to the EU URL. Auth is HTTP Basic with username `api`. Send both
`text` and `html` parts. Short timeout (~10s) — this runs inside a request.
Never raise: catch, log, return `False`. Tests stub the transport; **CI
must never make a network call.**

## Task 3: Backend endpoints

**A.** The table and the sender exist. This task wires them into the API.

**B. Files:**
- `backend/app/api/routers/auth.py` — the two endpoints
- `backend/app/api/schemas/auth.py` — `ForgotPasswordIn`, `ResetPasswordIn`
- `backend/tests/test_api/test_auth.py` — extend
- `backend/tests/test_api/test_authorization.py` — verify no change needed

**C.** `POST /auth/forgot-password` and `POST /auth/reset-password` per the
design decisions above. `ResetPasswordIn.password` must use the same
`min_length=8, max_length=72` constraint as the existing schemas — the
72-byte cap is a bcrypt truncation limit, not a style choice. The sender is
injected in a way tests can override, following the `set_session_factory`
precedent in `main.py` rather than monkeypatching a module global.

Tests must cover: unknown email → 204 and no send; inactive user → 204 and
no send; throttled → 204 and no second send; valid token → password
changed, all sessions deleted, token gone; expired token → 400; already-used
token → 400; a second reset attempt with the same token → 400; Mailgun
failure → still 204.

## Task 4: Frontend

**A.** The backend is complete and tested. This task adds the UI.

**B. Files:**
- `frontend/src/api/auth.ts` — `useForgotPassword`, `useResetPassword`
- `frontend/src/api/types.ts` — request types
- `frontend/src/auth/LoginGate.tsx` — the three views
- `frontend/src/auth/LoginGate.test.tsx` — extend
- `frontend/src/test/msw/handlers.ts` — handlers for both endpoints

**C.** Per "why the reset page cannot be a route" above. The forgot view's
success message must be identical whether or not the address exists —
mirroring the backend's non-enumeration, which is defeated if the UI says
"no account found". Match the existing form markup and Tailwind classes in
`LoginGate.tsx` rather than introducing a new style.

## Task 5: Review and documentation

**A.** Tasks 1–4 are complete and the feature is live. Review and document.

**C.** Update `documentation/architecture.md`: extend the "Authentication
Boundary" section with the reset flow and the LoginGate-owns-the-view
decision; add the new env vars. Record the accepted risks (shared
suppression list, silent Mailgun failure) so they are not rediscovered as
bugs. Then **delete this file**.

## Deployment checklist

Railway variables to set before the first deploy: `MAILGUN_API_KEY`,
`MAILGUN_DOMAIN`, `MAILGUN_FROM`, `APP_BASE_URL`. Confirm the sending
domain from the Mailgun dashboard first (see the open item above). Verify
end to end against a real NHSmail address before telling staff the feature
exists.
