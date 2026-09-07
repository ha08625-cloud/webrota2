# Implementation Plan — Self-Service Password Reset via Mailgun

**Status: implementation plan.** The provisional plan has been reviewed
against the code; the corrections and additions from that review are folded
in below and flagged **[review]** where they change what was previously
written. Ready to be broken into per-task chats.

## Scope

Add self-service password reset: a "Forgot password?" link on the login
form, an emailed single-use link, and a page to set a new password.

**In scope:** a `password_reset_tokens` table, two unauthenticated `/auth`
endpoints, a Mailgun sender module, invalidation of outstanding reset
tokens from the two existing password-change paths, the frontend flows,
tests.

**Out of scope:** email for anything else (no welcome emails, no
notifications); a general-purpose outbound email queue with retries;
account lockout after failed logins; changing the existing admin reset path
(`PATCH /users/{id}`), which stays as the fallback.

## Why

Reset is already possible today — any `user_admin` can set another user's
password via `PATCH /users/{id}` (`backend/app/api/routers/users.py:230`),
and that correctly deletes the target's sessions. The gap this closes is
the **lockout case**: the last remaining user administrator forgets their
password and nobody can let them back in. Convenience for ordinary staff is
a secondary benefit, not the justification.

---

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
  necessarily the From address's domain part.
- **Use a distinct From local-part** (e.g. `rota@…`) rather than the other
  project's `mail@…`, so the two projects are separable in Mailgun's logs
  and the email is recognisable to staff.
- **Accepted risk:** Mailgun's suppression list is per-domain and now
  shared with the other project. A staff member who bounces or reports spam
  there would be silently suppressed for rota resets too. Volume is tiny,
  and the admin reset path remains as the fallback. If someone reports
  never receiving a reset email, check the suppression list first.
- **Free tier: 3,000 emails/month.** See "the rate limits" below for what
  actually protects that quota — the per-user throttle alone does not.

### The reset URL: why `APP_BASE_URL` is an env var **[review]**

The link is built from the `APP_BASE_URL` environment variable, **never
from the request's `Host` header**. Deriving it from the request would be a
host-header injection: an attacker sends `Host: attacker.example` with a
`forgot-password` request for a victim's address, and the victim receives a
genuine-looking email whose link posts their new password — and the token —
to the attacker's server. The env var costs one Railway variable and closes
that outright. Strip any trailing slash before joining the path.

### Token model

- New table `password_reset_tokens`, following the `sessions` table's
  conventions exactly (`backend/app/models/user.py`): **only the SHA-256
  digest is stored**, never the raw token. `secrets.token_urlsafe(32)`,
  generated the same way as a session token. Reuse `new_session_token()`
  and `hash_token()` from `api/auth_utils.py` rather than writing new ones.
  (`models/doctor.py:57` already reuses `new_session_token` for the
  calendar token, so this is the established idiom.)
- **One hour expiry.** Long enough for someone to get to their inbox,
  short enough that a forwarded or logged link goes stale.
- **Single use — deleted on redemption**, along with every other
  outstanding reset token for that user.
- **Redeeming deletes all of the user's sessions**, matching what a
  password change already does. Someone resetting because they suspect
  compromise must get the attacker logged out.
- **Every other password-change path also deletes the user's outstanding
  reset tokens** — see the next section. **[review]**
- **Expired rows are swept lazily** on the next request for that user,
  the same idiom `login` already uses — no cron job.
- ORM-level cascade from `User` (`cascade="all, delete-orphan"`), no
  DB-level `ON DELETE CASCADE`, consistent with the rest of the schema.

### A password change must invalidate outstanding reset tokens **[review]**

`patch_user` (`routers/users.py:269`) and `patch_me`
(`routers/users.py:222`) each delete the user's sessions when the
password changes. Neither would touch `password_reset_tokens`, and that is
a real hole in the flow this feature adds:

> An attacker requests a reset for a compromised account. The account
> holder notices something is wrong and an admin resets their password.
> The attacker's emailed token is still live for up to an hour and
> re-takes the account.

Both handlers therefore gain a
`delete(PasswordResetToken).where(PasswordResetToken.user_id == target.id)`
alongside the existing session delete, on exactly the same condition. This
is the reason `routers/users.py` appears in Task 3's file list.

### No enumeration, and the timing side-channel **[review]**

- `POST /auth/forgot-password` **always returns 204** — unknown email,
  inactive user, throttled, or Mailgun failure alike. Anything else lets an
  unauthenticated caller test whether an address has an account, which
  would undo the care already taken in `routers/auth.py` to make login's
  two failure modes indistinguishable.
- **The email is sent from a `BackgroundTasks` task, not inline.** A 204
  returned identically on every path still leaks which addresses exist if
  the "exists" path first makes a synchronous HTTP POST to Mailgun:
  hundreds of milliseconds typically, up to the 10s timeout at worst,
  against single-digit milliseconds for the unknown / inactive / throttled
  paths. That is trivially measurable with a stopwatch and defeats the
  whole 204 design. Deferring the send to a background task makes every
  path return at the same speed, and takes the worst case off a
  user-facing request as a bonus.
  The task runs **after** the request's DB session has been closed, so it
  must be handed plain values (`to_email`, `name`, `reset_url`) — never the
  `Session` or the `User` object.
- **Mailgun failure is invisible to the caller** (the response has already
  been sent), but logs at ERROR with the status and response body. The user
  sees "if that address is registered, we've sent a link" and, when nothing
  arrives, falls back to asking an admin.
- **Missing `MAILGUN_API_KEY` logs a warning and no-ops**, so local dev and
  CI need no configuration. This is deliberately silent-but-loud: a
  production deploy missing the variable will look like emails vanishing,
  which is why it is WARNING and not DEBUG. Missing `MAILGUN_DOMAIN` or
  `MAILGUN_FROM` takes the same path — a half-configured deploy must not
  raise inside a background task. **[review]**

### The rate limits **[review]**

Two limits, because they defend different things and the per-user one does
not do both:

- **Per user: one token per 3 minutes.** This defends staff inboxes. No
  separate table is needed — since tokens are only deleted on redemption or
  expiry, the throttle is "does an unexpired unused token exist for this
  user, created less than 3 minutes ago". A throttled request returns 204
  and sends nothing.
- **Global: at most 40 reset emails per hour, across all users.** The
  per-user limit allows ~20 emails/hour *per address*; with ~50 staff
  addresses that is ~1,000/hour, and the 3,000/month free tier is gone in
  three hours. The per-user throttle protects inboxes, not the quota, and
  the provisional plan's rationale conflated the two. The global cap is a
  `COUNT` of rows in `password_reset_tokens` with
  `created_at > now - 1 hour`; over the cap, return 204 and send nothing,
  and log at WARNING (this is either an attack or a genuine outage that
  needs a human). Same table, no new state.

Both refusals are indistinguishable from success to the caller.

### Audit

- The audit middleware captures every non-GET request body with a
  redaction list. **`token` is already in `_REDACTED_KEYS`**
  (`backend/app/api/audit.py:67-73`, alongside `password`,
  `new_password`, `current_password` and `password_hash`), so no change to
  `audit.py` is needed — the provisional plan was wrong about this.
  Instead, Task 3 adds a test pinning that a `reset-password` body lands in
  the audit log with the token redacted, so the behaviour is protected
  rather than merely inherited. **[review]**
- The token travels in the **request body**, never as a path parameter. The
  redaction list only reaches the body; a token in the URL would be
  recorded verbatim on the audit row (and in Railway's access logs, and in
  any `Referer` a third-party asset would carry).
- No `record_audit_actor` call on `forgot-password`: there is no
  authenticated actor, and recording the resolved user would put "this
  address has an account" into the audit row for a request that
  deliberately refuses to say so. `reset-password` records the actor on
  success only, matching what `login` does and why.
- Accepted: `forgot-password` writes an audit row per request with the
  submitted `email` intact, from any unauthenticated caller. That is the
  same exposure `login` already has, and the global cap bounds the volume
  of *email*, not of rows. Noise in the audit table is the accepted cost of
  auditing the endpoint at all.

### `reset-password` returns 400, never 401 **[review]**

An expired, unknown, or already-redeemed token is a **400**. This is
load-bearing and must not be "tidied" to a 401 later:
`frontend/src/api/client.ts:70-72` fires the global `onUnauthorized`
listener on *any* 401 response, which clears the stored token and resets
`LoginGate` to the login form. A 401 here would yank the reset view out
from under the user the instant they submitted a stale link, replacing the
"this link has expired, request a new one" message with a bare login form.

`reset-password` also **refuses a token belonging to an inactive user**,
with the same 400. `forgot-password` already declines to email an inactive
user; a user deactivated inside the token's one-hour window must not be
able to complete the flow either. **[review]**

### Address matching: exact, and the UI says so **[review]**

`login` matches the email exactly and case-sensitively
(`routers/auth.py:44`). `forgot-password` does the same, deliberately:
normalising here and not there would create an asymmetry where an address
can request a reset it could never log in with.

The cost is that a mistyped or differently-cased address gets the same
cheerful 204 as a real one, which is indistinguishable from success. This
is not fixed in the backend — it is handled in the forget view's copy,
which must tell the user to enter **the address they log in with**. Note
this explicitly in Task 4 so the copy is not softened later into something
that hides the trap.

### Frontend: why the reset page cannot be a route

`main.tsx:32-34` renders `QueryClientProvider > LoginGate > App`, and
`BrowserRouter` lives inside `App` (`App.tsx:387`). `LoginGate` renders the
login form *instead of* its children when there is no valid token
(`LoginGate.tsx:108-116`). So a `<Route path="reset-password/:token">`
added to `App.tsx` **would never render for the logged-out user it exists
for** — they would get the login form at that URL.

**`LoginGate` therefore owns all three views itself** (`login` | `forgot` |
`reset`), switching on local state, with the initial view chosen by reading
`window.location.pathname` on mount. After a successful reset it calls
`history.replaceState` back to `/` and shows the login form with an
explanatory message via the existing `signedOutReason` state — which
already exists for exactly this shape of "you are back here on purpose".

**The pathname check must take precedence over the stored-token check.**
**[review]** Sessions last 30 days, so the overwhelmingly common case is
that the user is *still logged in on this browser* and has forgotten the
password they need for another device — or is on the machine where the
session never expired. As written, `LoginGate` renders children as soon as
`/auth/me` succeeds, so clicking the reset link would drop them into the
app and the reset view would never appear. On mount, a
`/reset-password/...` pathname must therefore win: skip the `/auth/me`
check entirely, clear any stored token, and show the reset view. Cover this
with a test — it is the case most likely to be missed.

Restructuring the app so the gate sits below the router would be the
cleaner long-term answer, but it touches the authentication boundary that
every page depends on, for one page's benefit. Not worth it here.

### The deep link works in production because of the SPA fallback

`SPAStaticFiles.get_response` (`backend/app/api/main.py`) serves
`index.html` for any unmatched **non-`/api`** path, so a cold
`GET /reset-password/<token>` from an email client returns the app rather
than a 404. Nothing needs adding — but it is a prerequisite of this
feature, so it is recorded here and in the architecture doc, to stop the
fallback being simplified away later.

### Authorization tests

**No change needed.** `test_authorization.py` exempts the whole `/auth`
prefix (`_EXEMPT_PREFIXES`, line 87), and the `auth` router is already in
`main.py`'s `_UNGATED`. New POSTs there are covered without touching the
sweep or its allowlists. Worth confirming on the first run rather than
assuming.

---

## Task 1: Data model and migration

**A.** Nothing done yet. This task adds the storage for reset tokens.

**B. Files:**
- `backend/app/models/user.py` — new `PasswordResetToken` model, plus the
  relationship on `User`
- `backend/app/models/__init__.py` — export it (both the import block and
  `__all__`)
- `backend/alembic/versions/011_password_reset_tokens.py` — new migration
- `backend/tests/test_models.py`, `backend/tests/test_auth_models.py` —
  coverage for the model and the cascade

**C.** Mirror `UserSession` closely: `id`, `token_hash` (unique
constraint, named `uq_password_reset_tokens_token_hash`), `user_id` (FK,
indexed), `created_at`, `expires_at`, all timezone-aware. `created_at` is
indexed as well — the global hourly cap counts on it. Follow the docstring
conventions of the surrounding models: this codebase documents *why* at
module level, and a new model that doesn't will look foreign. Extend the
`models/user.py` module docstring rather than only writing a class
docstring.

Migration: `down_revision = "010"` (010 is head — confirm before writing),
with a working downgrade that drops the index and the table.

**Do not** touch `app/api/audit.py`. `token` is already in
`_REDACTED_KEYS`; the provisional plan's instruction to add it was based on
a misreading.

## Task 2: Mailgun sender

**A.** The token table exists. This task adds the ability to send an email;
nothing calls it yet.

**B. Files:**
- `backend/app/email.py` (new) — the sender
- `backend/pyproject.toml` — promote `httpx` from `[project.optional-dependencies].dev`
  to `[project].dependencies`
- `backend/tests/test_email.py` (new)

**C.** One public function,
`send_password_reset(to_email: str, name: str, reset_url: str) -> bool`.

Read env vars at call time, not import time, so tests can monkeypatch:
`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM`, and `MAILGUN_API_BASE`
defaulting to `https://api.eu.mailgun.net/v3`. (`APP_BASE_URL` is read by
the router, not here — this function receives a finished URL.) Auth is HTTP
Basic with username `api`. Send both `text` and `html` parts. Timeout ~10s.

The promotion of `httpx` is genuinely required, not tidying: `nixpacks.toml`
installs the backend with `pip install .`, which does not pull the `dev`
extra, so a production import of a dev-only dependency is an
`ImportError` at startup.

**The contract, spelled out so it can be tested:** **[review]**

| condition | returns | logs |
|---|---|---|
| 2xx from Mailgun | `True` | nothing |
| non-2xx from Mailgun | `False` | ERROR, with status and response body |
| `httpx.HTTPError` (timeout, connection, etc.) | `False` | ERROR, with the exception |
| any of `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` / `MAILGUN_FROM` unset or empty | `False` | WARNING, naming which are missing |

It **never raises** — it is called from a background task where an
exception has nowhere useful to go. Tests stub the transport; **CI must
never make a network call**, and a test should assert that the unconfigured
path makes no request object at all.

## Task 3: Backend endpoints

**A.** The table and the sender exist. This task wires them into the API,
and closes the reset-token hole in the existing password-change paths.

**B. Files:**
- `backend/app/api/routers/auth.py` — the two endpoints
- `backend/app/api/schemas/auth.py` — `ForgotPasswordIn`, `ResetPasswordIn`
- `backend/app/api/routers/users.py` — delete outstanding reset tokens in
  `patch_me` and `patch_user` **[review]**
- `backend/app/api/deps.py` — `get_email_sender` dependency
- `backend/tests/test_api/test_auth.py` — extend
- `backend/tests/test_api/test_users.py` — extend (the two new deletes)
- `backend/tests/test_api/test_audit.py` — token-redaction test
- `backend/tests/test_api/test_authorization.py` — verify no change needed

**C.** `POST /auth/forgot-password` and `POST /auth/reset-password` per the
design decisions above: always-204 with the send deferred to
`BackgroundTasks`, both rate limits, 400 (never 401) for a bad, expired,
redeemed or inactive-user token, token in the body.

`ResetPasswordIn.password` must use the same `min_length=8, max_length=72`
constraint as `UserIn`/`UserPatch` — the 72-byte cap is a bcrypt truncation
limit, not a style choice.

**Injecting the sender** — the provisional plan pointed at
`set_session_factory` as the precedent, which was the wrong reference:
that is a module-global setter in `api/audit.py`, and it exists only
because middleware runs outside the dependency system and cannot use
`get_db`. An endpoint has no such constraint, and this codebase already
overrides dependencies extensively in tests
(`tests/test_api/conftest.py:187-194`). Add a trivial `get_email_sender`
dependency in `deps.py` returning `app.email.send_password_reset`, and let
tests swap it through `app.dependency_overrides` like everything else.
**[review]**

**Tests must cover:**
- unknown email → 204, no send
- inactive user → 204, no send
- per-user throttle → 204, no second send
- global hourly cap reached → 204, no send
- valid token → password changed, all sessions deleted, all of that user's
  reset tokens deleted
- expired token → 400
- already-redeemed token → 400; a second attempt with the same token → 400
- token for a user deactivated after the token was issued → 400 **[review]**
- Mailgun failure → still 204 (assert on the ERROR log, not the response)
- `PATCH /users/{id}` with a password → the target's outstanding reset
  tokens are gone **[review]**
- `PATCH /users/me` with a password → the same **[review]**
- an audit row for `reset-password` has `token` redacted **[review]**

Note that `BackgroundTasks` run to completion inside FastAPI's
`TestClient` before the response is returned to the test, so asserting "no
send happened" works without extra synchronisation.

## Task 4: Frontend

**A.** The backend is complete and tested. This task adds the UI.

**B. Files:**
- `frontend/src/api/auth.ts` — `useForgotPassword`, `useResetPassword`
- `frontend/src/api/types.ts` — request types
- `frontend/src/auth/LoginGate.tsx` — the three views
- `frontend/src/auth/LoginGate.test.tsx` — extend
- `frontend/src/test/msw/handlers.ts` — handlers for both endpoints

**C.** Per "why the reset page cannot be a route" above, including the
precedence rule: a `/reset-password/...` pathname on mount wins over a
stored token — skip `/auth/me`, clear the token, show the reset view.

The forgot view's success message must be identical whether or not the
address exists — mirroring the backend's non-enumeration, which is
defeated if the UI says "no account found" — and must tell the user to
enter the address they log in with (see "address matching" above).

Match the existing form markup and Tailwind classes in `LoginGate.tsx`
rather than introducing a new style.

**Tests must cover:** the pathname-wins-over-stored-token case; the forgot
view showing the same message for a known and an unknown address; a 400
from `reset-password` rendering the expiry message and **not** dropping to
the login form.

## Task 5: Review and documentation

**A.** Tasks 1–4 are complete and the feature is live. Review and document.

**C.** Update `documentation/architecture.md`: extend the "Authentication
Boundary" section (line 39) with the reset flow, the LoginGate-owns-the-view
decision and its pathname-precedence rule, and the dependency on the SPA
`index.html` fallback; add the new env vars to the Deployment section.
Record the accepted risks (shared suppression list, invisible Mailgun
failure, unauthenticated audit rows carrying submitted addresses) so they
are not rediscovered as bugs. Then **delete this file**.

## Deployment checklist

- Confirm from the Mailgun dashboard (Sending → Domains) whether the
  sending domain is `summertownhealthcentrechat.co.uk` or
  `mail.summertownhealthcentrechat.co.uk`. This is deploy-time config only —
  nothing in the code depends on the answer, so it does not block Task 2.
- Railway variables to set before the first deploy: `MAILGUN_API_KEY`,
  `MAILGUN_DOMAIN`, `MAILGUN_FROM`, `APP_BASE_URL`
  (`https://webrota2-webrota2.up.railway.app`, no trailing slash).
- Verify end to end against a real NHSmail address before telling staff the
  feature exists.
