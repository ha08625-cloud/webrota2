# Plan: Role-Based Auth (Manager / Admin / Doctor / Nurse)

Replaces the current single-role trust model — any authenticated user can do
anything (see the header comment in `app/api/routers/users.py`) — with four
role labels over three real permission tiers.

| Role    | User mgmt | Reference + rota writes | Reads |
| ------- | --------- | ----------------------- | ----- |
| Manager | yes       | yes                     | yes   |
| Admin   | no        | yes                     | yes   |
| Doctor  | no        | no                      | yes   |
| Nurse   | no        | no                      | yes   |

Doctor and Nurse are permission-identical: pure labels, not linked to any
`Doctor` or `ReceptionStaff` row. This is a 3-tier system (manager > admin >
viewer) wearing 4 labels.

# Scope

**In scope**

- `access_level` column on `User`, exposed through `/auth/login`, `/auth/me`,
  and the `/users` CRUD surface.
- A single method-aware write gate applied globally at router-inclusion time.
- `/users` restricted to Manager, plus a new self-service `PATCH /users/me`.
- Lock-out guard rewritten from "last active user" to "last active Manager",
  covering both deactivation and demotion.
- Frontend: role on the auth context, nav and write controls gated by tier.

**Out of scope (deliberate)**

- Per-person scoping ("a doctor sees only their own leave"). That needs a
  nullable `doctor_id` / `reception_staff_id` FK on `User`; the role label
  alone gets you no closer to it. Do not add the FK speculatively.
- Differentiating Doctor from Nurse in permissions.
- Any change to session/token mechanics (`deps.py::get_current_user`,
  `routers/auth.py`) beyond reading the new column.

**Size**: three implementation chats, listed as Tasks 1–3 below.

# Design Decisions

**1. The column is `access_level`, not `role`.** The rota domain already owns
the word "role" — `POST /rota/{id}/swap-roles`, `POST
/rota/{id}/sessions/{sid}/set-role`, `SetRoleOut`, session roles on doctors.
A `User.role` would be permanently ambiguous in conversation and in grep.
Values are lowercase strings: `manager` | `admin` | `doctor` | `nurse`.

**2. The write gate is method-aware and applied globally, not per-endpoint.**
There are ~78 non-GET endpoints across 22 routers, and every one of them
already carries an explicit `user: User = Depends(get_current_user)`. Swapping
each of those for a write-tier dependency would be 78 edits and — the real
problem — **default-open**: the next POST anyone adds is world-writable until
someone remembers to add the dependency, and no test catches it.

Instead, one dependency inspects `request.method` and is attached once in the
`include_router` loop in `app/api/main.py:61`. Adding a router or an endpoint
is then default-**deny** for viewers. Router-level `dependencies=[...]` on the
`APIRouter` objects themselves cannot work here: every router mixes GETs and
writes, so the discrimination has to happen inside the dependency.

**3. `POST /signatures/{doctor_id}/apply` is gated as a write even though it
writes nothing.** It splices a stored signature into an uploaded document and
returns a PDF (`routers/signatures.py:195`) — the only endpoint in the codebase
where HTTP method is a poor proxy for "mutates state". It is gated at
admin tier anyway: producing an officially signed document is not obviously a
viewer action, and an exception list is a permanent hole in Decision 2's
default-deny for a single endpoint. **This is reversible in one line** if it
turns out doctors need to generate their own signed certificates — add an
exempt `(method, path)` set to the gate. Flagging it because it is the one
behaviour change here that a user might notice without understanding why.

Verified as safe otherwise: no GET endpoint in the codebase mutates, and no
other non-GET endpoint is read-only.

**4. Manager-only `/users` would strand everyone else's password, so
`PATCH /users/me` is part of this work, not a follow-up.** Today any user can
PATCH themselves. Restricting `/users` to Manager means a Doctor cannot change
their own password without asking a Manager for a reset — and the reset path
deletes all their sessions. `/users/me` accepts `name` and `password` only;
`email`, `active`, and `access_level` are not settable there, so it cannot be
used for self-promotion.

**5. Lock-out guard covers demotion as well as deactivation.** `active=False`
on the last active Manager and `access_level != manager` on the last active
Manager are both 409. Guarding only deactivation leaves an identical
lock-out reachable by a one-field PATCH. The count check stays inside the
same transaction as the update, as `_active_user_count` does today.

**6. Reads stay open to all four tiers.** This preserves today's "everyone
sees everything" behaviour and keeps the diff to what it claims to be.

**7. Migration adds the column with `server_default="nurse"`.** "Non-nullable,
no backfill" fails in Alembic against a table with rows, and the Railway DB
has rows. The default is `nurse`, not `manager` — an accidental viewer is
recoverable, an accidental fleet of managers is a silent security hole. The
bootstrap manager comes from re-running `seed_users.py`.

**8. Frontend gating is UX only.** Hidden buttons are a courtesy; the 403 is
the security boundary. No frontend check may be the only thing standing
between a viewer and a write.

---

# Task 1: Data model, schemas, migration, seed

## A. State of the world

Nothing in this plan is implemented yet. `User`
(`backend/app/models/user.py`) has `id`, `email`, `name`, `password_hash`,
`active`, `created_at` and no notion of permission. This task adds the column
and everything that reads or writes it at the data layer, with no enforcement
anywhere — after this task the API behaves exactly as it does today, but every
user carries an `access_level`.

## B. Files and deliverables

| File | Deliverable |
| --- | --- |
| `backend/app/models/enums.py` | New `AccessLevel(str, enum.Enum)`: `MANAGER = "manager"`, `ADMIN = "admin"`, `DOCTOR = "doctor"`, `NURSE = "nurse"` |
| `backend/app/models/user.py` | `access_level` column on `User`, `nullable=False`, using `enum_col(AccessLevel)` |
| `backend/app/api/schemas/auth.py` | `access_level` on `UserOut` (required) and `UserIn` (required); `access_level: AccessLevel \| None` on `UserPatch` |
| `backend/alembic/versions/028_user_access_level.py` | New migration, `revision = "028"`, `down_revision = "027"` |
| `backend/seed/seed_users.py` | `SEED_USER_ACCESS_LEVEL` env var, default `"manager"` |
| `backend/tests/test_api/conftest.py` | `_StubUser` gains `access_level = AccessLevel.MANAGER` |
| `backend/tests/test_seed.py` | Seed default + explicit-override coverage |

## C. Instructions

1. Add `AccessLevel` to `enums.py` alongside the existing str-enums. Follow the
   file's convention: the enum *value* is what lands in the database.

2. Add the column to `User`. `enum_col()` caches one shared `SAEnum` instance
   per Python enum and emits a native `CREATE TYPE` on Postgres — read its
   docstring (`enums.py:104`) before writing the migration.

3. Write migration `028`. Because of the native Postgres enum type, create the
   type explicitly before `add_column` rather than relying on `add_column` to
   do it:

   ```python
   access_level = sa.Enum("manager", "admin", "doctor", "nurse", name="accesslevel")
   access_level.create(op.get_bind(), checkfirst=True)
   op.add_column("users", sa.Column(
       "access_level", access_level, nullable=False, server_default="nurse",
   ))
   ```

   Keep the `server_default` in place — it costs nothing and means a direct
   `INSERT` cannot produce a null. `downgrade()` drops the column and the type.
   Document in the migration docstring *why* the default is `nurse` (Design
   Decision 7), since it will look like an odd choice otherwise.

4. `seed_users.py`: read `SEED_USER_ACCESS_LEVEL` with a `"manager"` default —
   unlike the other three vars this one is **not** added to `_REQUIRED_VARS`,
   because the bootstrap user is a manager in essentially every case. Validate
   the value against `AccessLevel` and raise a clear `RuntimeError` on a typo
   rather than letting SQLAlchemy fail on the enum. Update the module docstring's
   usage example.

5. `tests/test_api/conftest.py`: add `self.access_level = AccessLevel.MANAGER`
   to `_StubUser.__init__`. **This one line keeps all ~30 existing API test
   files passing once Task 2 lands the gate** — the fixture overrides
   `get_current_user`, so the gate will read the stub's attribute. Doing it in
   Task 1 keeps Task 2's diff to genuinely new behaviour.

6. Do not touch any router in this task. Do not touch the frontend.

**Verify**: `uv run pytest tests/test_seed.py tests/test_auth_models.py tests/test_api/test_users.py`,
plus `uv run alembic upgrade head` and `downgrade -1` against a scratch DB.

---

# Task 2: Backend enforcement

## A. State of the world

Task 1 is complete: `User.access_level` exists, is in the schemas, is seeded,
and the test stub is a manager. Nothing enforces it yet — this task is the
whole security boundary.

## B. Files and deliverables

| File | Deliverable |
| --- | --- |
| `backend/app/api/deps.py` | Tier ordering, `require_write_access`, `require_manager` |
| `backend/app/api/main.py` | Gate attached in the `include_router` loop; `auth` and `users` excluded |
| `backend/app/api/routers/users.py` | Manager gate on all four endpoints; new `PATCH /users/me`; lock-out guard rewrite |
| `backend/app/api/schemas/auth.py` | New `UserSelfPatch` (name + password only) |
| `backend/tests/test_api/test_authorization.py` | New: route-sweep + tier tests |
| `backend/tests/test_api/test_users.py` | Manager gating, `/users/me`, new lock-out cases |
| `backend/tests/test_api/conftest.py` | Helper for building a client authenticated as a given tier |

## C. Instructions

1. **`deps.py`** — add an explicit ordering and two dependencies:

   ```python
   _TIER = {AccessLevel.NURSE: 0, AccessLevel.DOCTOR: 0,
            AccessLevel.ADMIN: 1, AccessLevel.MANAGER: 2}
   _SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
   ```

   `require_write_access(request, user = Depends(get_current_user))` returns
   the user unchanged for safe methods, else 403 unless the user's tier is
   >= 1. `require_manager(user = Depends(get_current_user))` 403s below tier 2
   regardless of method. Both raise 403 with a plain detail string — 403, not
   404: the resource exists and hiding that buys nothing here.

   `OPTIONS` is in the safe set for correctness even though `CORSMiddleware`
   answers preflight before routing.

   Extend the module docstring. It currently documents "every router endpoint
   requires a valid session" as the whole authorization story; that is no
   longer true and the file is the first place anyone will look.

2. **`main.py`** — split the `include_router` loop at line 61:

   - `auth`: included with **no** gate. `POST /auth/login` and `POST
     /auth/logout` must stay reachable, and login has no authenticated user by
     definition.
   - `users`: included with no global gate; it gates itself per-endpoint
     (step 3), because `PATCH /users/me` must stay open to all tiers.
   - Everything else: `dependencies=[Depends(require_write_access)]`.

   Structure it so adding a router to the wrong list is visibly wrong — e.g. a
   named `_UNGATED = (auth, users)` tuple with a comment pointing here — rather
   than two anonymous loops.

3. **`routers/users.py`** — add `Depends(require_manager)` to `list_users`,
   `create_user`, and `patch_user`. `list_users` is manager-only too: the user
   list is not something viewers need.

   Add `PATCH /users/me`, declared **above** `PATCH /{user_id}` so the literal
   path wins the match. Body is `UserSelfPatch` (`name`, `password`; both
   optional). It updates the caller's own row only, reusing the existing
   password-reset semantics — re-hash and `delete(UserSession)` for that user,
   which signs them out everywhere including the current session. That is the
   existing behaviour of a password change and is correct; the frontend must
   handle the subsequent 401 (Task 3).

   Rewrite `_active_user_count` into something like
   `_active_manager_count(db, exclude_id=None)` — same shape, plus
   `.where(User.access_level == AccessLevel.MANAGER)`. Fire the 409 when a
   PATCH would leave zero active managers, via **either** path:

   - `active` going `True -> False` on a manager, or
   - `access_level` moving off `manager` on an active manager.

   Both checks belong before the mutation, in the same transaction, exactly
   where the current guard sits. Update the module docstring — the "single-role
   trust model" paragraph is now the opposite of the truth.

4. **`tests/test_api/test_authorization.py`** — the important test is a sweep,
   not a per-router enumeration:

   ```python
   @pytest.mark.parametrize("method,path", _all_non_get_routes())
   def test_viewer_cannot_write(viewer_client, method, path): ...
   ```

   Walk `app.routes`, take every non-GET route outside `/auth` and
   `/users/me`, substitute a dummy value for each path param, and assert the
   response is 403. This covers all ~78 endpoints and — the point — every
   endpoint anyone adds later, with no new test needed. Assert 403 specifically,
   not "not 2xx": a 422 from an empty body would otherwise pass a broken gate.
   Guard against the sweep silently collapsing to nothing by asserting the
   collected route count is above a floor (say 60).

   Then targeted tests: admin can write but gets 403 on `/users`; manager can
   do both; all four tiers can GET; `/auth/login` works unauthenticated.

5. **`conftest.py`** — add a way to build a `TestClient` whose
   `get_current_user` override returns a stub at a chosen tier. Respect the
   existing `client` / `client_no_auth` mutual-exclusion warning in that file's
   docstring — `app.dependency_overrides` is one dict on a shared `app`, so a
   per-tier fixture must follow the same single-client-per-test rule, and the
   docstring should say so.

**Verify**: `uv run pytest tests/test_api/` in full for this task — the gate
touches every router, so the usual "only what you changed" rule does not apply.

---

# Task 3: Frontend role plumbing and gating

## A. State of the world

Tasks 1 and 2 are complete. The backend returns `access_level` on
`/auth/login` and `/auth/me` and enforces all three tiers with 403s. The
frontend is unchanged and therefore currently shows every viewer a full set of
buttons that all fail — this task makes the UI honest. It is *not* the security
boundary (Design Decision 8).

## B. Files and deliverables

| File | Deliverable |
| --- | --- |
| `frontend/src/api/types.ts` | `AccessLevel` union type; `access_level` on `AuthUser` and `UserIn`; `UserSelfPatch` |
| `frontend/src/auth/` | Current user exposed app-wide (new context module) |
| `frontend/src/auth/LoginGate.tsx` | Provides the `/auth/me` user to that context |
| `frontend/src/App.tsx` | `Users` nav entry manager-only; viewer-hidden nav entries |
| `frontend/src/routes/UsersPage.tsx` | Manager-only; `access_level` column and control |
| `frontend/src/components/UserFormDialog.tsx` | Access-level selector |
| Write-bearing pages/components under `routes/` and `components/` | Write controls hidden or disabled for viewers |
| Co-located `*.test.tsx` | Per-tier rendering assertions |

## C. Instructions

1. `types.ts`: `export type AccessLevel = "manager" | "admin" | "doctor" |
   "nurse";` mirroring the backend enum values, following the file's existing
   convention of commenting which backend schema each block mirrors. Add the
   field to `AuthUser` (so it flows through `LoginOut` and the Users list for
   free) and `UserIn`.

2. Add a small auth context exposing the current `AuthUser` plus derived
   `canWrite` / `isManager` booleans. `LoginGate` already fetches `/auth/me`
   and holds the result (`useMe`) — it should provide the context rather than a
   second component re-fetching. Derive the booleans in one place; do not let
   `user.access_level === "manager"` comparisons spread through components.

3. `App.tsx`: drop the `Users` nav item for non-managers. Decide per nav entry
   whether a viewer should see the page at all — a viewer can legitimately
   *view* the rota, master rota, and staff lists, so most entries stay; the
   judgement call is whether pages that are purely write tools (Staging,
   Generate new rotas, Counters) are worth showing read-only. Default to
   showing them with controls disabled, so a viewer's mental model of the app
   matches a manager's.

4. `UsersPage.tsx`: render a "you do not have access" state for non-managers
   rather than a broken empty list (the route stays registered; only the nav
   entry disappears, and deep links must not explode). Add the access-level
   column and a way to change it, surfacing the backend's 409 through the
   existing `showToast` path — the same way the last-active-user 409 is handled
   today. Update the component comment that cites "Design Decision 8: a
   teammate resets you via this page"; that is no longer how recovery works.

5. Write controls elsewhere: prefer **disabled with a title/tooltip** over
   removed, so a viewer can see the app has the capability. Whatever you pick,
   apply it consistently across the clinical and reception pages.

6. If `PATCH /users/me` gets a UI in this task, it must handle its own
   password-change 401: the backend deletes every session for that user,
   including the current one, so a successful password change logs you out. Do
   that explicitly (clear token, show the login form with a message) rather
   than letting the global 401 handler bounce the user with no explanation.

7. Do not remove any backend call on the grounds that the UI now hides it.

**Verify**: `npm run test -- src/routes/UsersPage.test.tsx src/auth src/App.test.tsx`
plus the tests co-located with any component you gate.
