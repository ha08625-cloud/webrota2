# Fine-Grained Permissions — Implementation Plan

Status: **implementation plan** (workflow step 2 complete). The provisional
plan was reviewed against every call site named in it; the corrections are
folded in below and the open questions are answered. Tasks are written to be
handed to individual chats one at a time.

## Plan

Replace the single four-value `access_level` tier with a per-user
**permission set**: an access level (`none` / `read` / `write`) for each of
the two rota areas, plus boolean capabilities for the two document tools and
for user administration. Reads become gated for the first time. The role
names survive only as *presets* that pre-fill the permission controls; after
creation nothing consults the role at request time.

The motivation is the signature feature: uploading and applying signatures
is admin work, but it exposes a scanned signature image, and that should be
available to as few logins as possible — independently of whether someone
can edit a rota.

## Scope

**In scope**

- Per-area permissions for clinical rota, reception rota, signatures, study
  EOI, and user administration.
- Read gating, which does not exist today.
- Frontend nav filtering, route guards, section-scoped write gating, and a
  permissions editor in the Users admin page.
- Reworking `backend/tests/test_api/test_authorization.py`'s sweeps.
- Moving `/clinical/users` and `/clinical/audit` to their own `/admin/*`
  section (forced by D8 — see D10).

**Out of scope**

- Per-record permissions ("may edit only their own leave"). The existing
  `linked_doctor` / `linked_reception_staff` machinery covers the "mine"
  cases and is orthogonal.
- Any change to what the pages themselves do.

## Design Decisions

**D1 — Levels per area, not six flat flags.** "Clinical rota" and "clinical
rota, read only" are one permission with two levels, not two permissions.
Modelling them as `none` / `read` / `write` per area halves the number of
controls and makes contradictory states unrepresentable. Signatures and
study EOI stay booleans — there is no meaningful read-only view of a
document generator.

**D2 — Five permissions in total.**

| Permission | Type | Covers |
| --- | --- | --- |
| `clinical` | none / read / write | the whole `/clinical` section |
| `reception` | none / read / write | the whole `/reception` section |
| `signatures` | bool | upload, delete, apply, and **view** signature images |
| `study_eoi` | bool | the EOI autofill tool |
| `user_admin` | bool | user management and the audit log |

For the boolean permissions, `true` grants read *and* write on that area and
`false` denies both, including GETs.

**D3 — Storage: a JSON column on `users`.** A `permissions` JSON column
holding an object, not a boolean column per permission and not an
association table. The set is small and always read whole, and adding a
sixth permission should not be a migration.

Two implementation notes the provisional plan missed:

- Use portable `sqlalchemy.JSON`, not `JSONB`. Tests build SQLite from the
  models via `create_all`; CI and prod run Postgres.
- Wrap it in `MutableDict.as_mutable(JSON)`. A plain `JSON` column is not
  change-tracked: `user.permissions["clinical"] = "write"` would not
  persist, silently. If `MutableDict` is not used, the router must reassign
  the whole dict and a test must pin that.
- The provisional plan's rationale ("never queried across users") is not
  quite true — `_active_manager_count` becomes a cross-user query over this
  column (see D11). One `json_extract` / `->>` query is an acceptable cost;
  it is called on two PATCH paths only.

**D4 — Keep `access_level`, demote it to a decorative label.** The column
and its enum stay: the audit log snapshots it, "Manager" is still a useful
word in the UI, and `AccessLevel` is a native Postgres enum type, so adding
or removing values costs an `ALTER TYPE` migration for no functional gain.
It stops being consulted for authorization anywhere.

**D5 — Gating stays centralised and default-deny, via a dependency
factory.** The provisional plan said `require_access` would "look the
request's router up in a map". It cannot: the dependency receives a
`Request`, and there is no router-module handle at request time — FastAPI
0.139 wraps each `include_router` call in an opaque `_IncludedRouter`, so
`app.routes` yields exactly one `APIRoute` (`/health`).

Instead, `require_access` is a **dependency factory** that closes over the
area at registration time:

```python
_AREA: dict[ModuleType, Area] = { rota: "clinical", ... }

for module in _ALL_ROUTERS:
    if module in _UNGATED:
        dependencies = []
    else:
        dependencies = [Depends(require_access(_AREA[module]))]   # KeyError -> import fails
    app.include_router(module.router, prefix=API_PREFIX, dependencies=dependencies)
```

This is simpler than the map-lookup version *and* gets the completeness
check for free: an unclassified router raises `KeyError` at import, so
adding a router without classifying it is a startup failure rather than a
silent hole. That property is the whole point of the current design and must
survive; with 40 GET paths and 83 non-GET operations, per-endpoint gating is
default-open.

**D5a — Two per-endpoint exceptions, deliberately.** The provisional plan
said "no per-endpoint permission decorators", which contradicts its own Task
2. There are exactly two reasons for one:

1. `users` stays in `_UNGATED` and gates itself, because `PATCH /users/me`
   must stay open to every permission set.
2. The endpoints that today carry `require_manager` **on top of** the global
   gate keep a narrower guard (D12).

**D6 — Reads become gated, with a two-entry shared-read allowlist.** The
cross-area reads were swept. There are exactly two, and both are list
endpoints used to populate pickers:

| Caller | Reads | Why |
| --- | --- | --- |
| `routes/SignaturesPage.tsx:222` (`useDoctors(true)`) | `GET /doctors` | Partner/Salaried picker |
| `components/UserFormDialog.tsx:62-63` | `GET /doctors` **and** `GET /reception/staff` | linked-staff pickers |

The second one is the important find and was missing from the provisional
plan: without it a `user_admin`-only login — exactly the tightly scoped
login this feature exists to make possible — cannot create or edit a user.

Both payloads are innocuous. `DoctorOut` (`schemas/doctor.py:58`) is
id/code/doctor_type/sessions_per_week/active/start_date/end_date;
`ReceptionStaffOut` (`schemas/reception.py:45`) is id/code/active. Neither
carries a token or personal data; the calendar-feed token lives on a
separate endpoint. So option (a) from the provisional plan — classify them
as shared-read — is correct and option (b) buys nothing.

Reception's frontend was swept and is otherwise self-contained:
`api/reception.ts` calls only `/reception/*`. `closures` and
`school_holidays` are read by the *backend* during reception generation,
which is irrelevant to HTTP gating.

**D6a — The allowlist is per-endpoint, and that is a real cost.** It cannot
live in the router→area map, because `GET /doctors/{id}/calendar-feed` must
stay clinical while `GET /doctors` does not. So `require_access` checks an
explicit `_SHARED_READ: frozenset[tuple[str, str]]` of `(method,
templated_path)` pairs before applying the area rule. This is the
"permanent hole in the default-deny property" that
`require_write_access`'s docstring warns about, so: exactly two entries,
a comment per entry saying which caller needs it, and Task 3's sweep asserts
the set's contents rather than skipping over it.

**D7 — Frontend: the section provides the area, so call sites do not
change.** A `<PermissionAreaProvider area="clinical">` in each shell lets
`useCanWrite()` resolve the area from context, so the 31 existing
`useCanWrite` / `useWriteGate` call sites need no edit. Verified: no
component is genuinely cross-area for *write* purposes.

**D8 — Route guards, not just hidden nav.** Hiding a nav item is not enough
once reads are gated: a bookmarked `/reception/leave` would otherwise render
a page full of failed queries. Each shell redirects to the landing page when
the user cannot read that area, and the landing page shows only enterable
sections. Frontend gating remains UX only — the API 403 is the boundary.

**D9 — Fix the signature-image hole first and separately.** `GET
/signatures` (`routers/signatures.py:107`) and `GET
/signatures/{doctor_id}/image` (`:118`) carry only `get_current_user`. The
global gate is method-aware, so both are readable by every authenticated
user, nurse tier included. That is the exact exposure this work exists to
close and it does not need the permission model. See Task 0.

**D10 — Users and Audit move to their own `/admin/*` section.** New. They
are currently routes *inside* `ClinicalShell` (`App.tsx:86-87, 198-199`), so
D8's shell-level guard on `clinical !== "none"` would lock a
`user_admin`-only user out of the two pages `user_admin` grants. Rather than
special-casing the clinical guard, give the permission its own shell:
`/admin/users` and `/admin/audit`, guarded on `user_admin`, with a fourth
landing tile. `/clinical/users` and `/clinical/audit` keep working as
redirects. Nothing is live, so the URL change costs nothing.

**D11 — `_active_manager_count` becomes `_active_user_admin_count`.**
`routers/users.py:120` currently counts `User.access_level == MANAGER`.
Under D4 that guard would silently stop protecting anything real. It becomes
a count of active users whose `permissions["user_admin"]` is true, and the
409 message changes to "cannot remove the last active user administrator".

**D12 — The `require_manager` extras keep a narrower guard.**
`require_manager` is applied per-endpoint in **four** places, not the three
the provisional plan listed:

| Endpoint | File | Replacement |
| --- | --- | --- |
| `GET/POST /users`, `PATCH /users/{id}` | `routers/users.py:134,143,205` | `user_admin` |
| whole `audit` router | `routers/audit.py:51` | `user_admin` (via the area map) |
| `POST /doctors/{id}/calendar-feed/rotate` | `routers/doctors.py:245` | `clinical: write` **and** `user_admin` |
| `DELETE /reception/staff/{id}` | `routers/reception_staff.py:209` | `reception: write` **and** `user_admin` |

The last two are conjunctions on purpose. Both are today's *narrowest*
permission because of what they do, not because they are user
administration: deleting reception staff is irreversible and
history-destroying (`routers/reception_staff.py:15-33`), and rotating a
calendar token invalidates someone's live subscription. Mapping either to
plain `area: write` would widen it to every rota editor. The conjunction
preserves exactly today's behaviour and is the only place two permissions
combine. *Confirm this in review — the alternative is accepting the
widening, which is one line each.*

**D13 — The audit log gains a permissions snapshot.** Q6 is cheaper than the
provisional plan assumed: `audit_log.user_access_level` is a nullable
`String` (`models/audit.py:70`), not an enum column. Rather than rename it,
**add** a nullable `user_permissions` String column holding the compact JSON
of the acting user's permission set. `user_access_level` stays as the label
snapshot. Additive, no rename, and "why was this allowed" becomes
answerable.

**D14 — Presets are frontend-only, and there are five of them.** The role
select (`access_level`) stays exactly as it is and feeds the label column. A
separate "Start from preset" control fills the permission widgets:

| Preset | clinical | reception | signatures | study_eoi | user_admin |
| --- | --- | --- | --- | --- | --- |
| Manager | write | write | ✓ | ✓ | ✓ |
| Rota admin | write | write | ✗ | ✗ | ✗ |
| Reception admin | **read** | write | ✗ | ✗ | ✗ |
| Documents | none | none | ✓ | ✓ | ✗ |
| Read-only | read | read | ✗ | ✗ | ✗ |

"Reception admin" answers Q3: a reception-only user gets `clinical: read` by
default. It is a preset rather than a fifth `AccessLevel` value because
`AccessLevel` is a native Postgres enum (`models/enums.py:121`) and adding a
value would cost an `ALTER TYPE` migration for a label.

Note what "Rota admin" does: today's `admin` tier **can** upload and apply
signatures. Under this preset it cannot. That narrowing is the feature, not
a regression — but it means existing admin logins lose signature access when
their permissions are set, and that should be said out loud when it ships.

**D15 — An empty permission set is invalid.** Q4: the form refuses to save
it. Enforced in **both** places — a `model_validator` on the permissions
schema so `POST /users` and `PATCH /users/{id}` both 422, and a mirrored
Zod refinement so the form says so before it submits. "Empty" means
`clinical == none` and `reception == none` and all three booleans false.

## Answers to the provisional plan's open questions

1. **Cross-area reads** — swept; exactly two endpoints (D6).
2. **Do signatures / study_eoi imply other reads** — no, beyond D6's two.
3. **Reception user sees the clinical rota** — yes; `clinical: read` in the
   Reception admin preset (D14).
4. **Empty permission set** — invalid, refused on save (D15).
5. **Last active manager guard** — yes, becomes last active `user_admin`
   (D11).
6. **Audit snapshot** — add a `user_permissions` column, keep
   `user_access_level` (D13).

---

# Task 0 — Close the signature-image read hole

**A. State of the world.** Nothing in this plan is built yet. This task is
independent of every other one and can ship on its own, ahead of the
permission model. `GET /signatures` and `GET /signatures/{doctor_id}/image`
are readable by every authenticated user because the global gate
(`require_write_access`) only acts on non-GET methods.

**B. Files and deliverables.**

- `backend/app/api/routers/signatures.py` — both GET endpoints gated.
- `backend/tests/test_api/test_signatures.py` — regression tests.
- `backend/tests/test_api/test_authorization.py` — the GET sweep gains
  these two paths as expected-403-for-a-viewer.

**C. Instructions.**

1. In `routers/signatures.py`, change the `user: dict =
   Depends(get_current_user)` on `list_signatures` (line ~107) and
   `get_signature_image` (line ~118) to `user: User =
   Depends(require_write_access)`. That dependency already resolves
   `get_current_user`, and on a GET it currently returns unconditionally —
   so it is not enough on its own. Add an explicit tier check instead: the
   cleanest minimal form is a new `require_admin` in `deps.py`
   (`_tier(user) < _WRITE_TIER -> 403`) applied to both endpoints, which is
   the *existing* tier model's "admin or manager" and matches who can
   already upload.
2. Do **not** touch the router's `include_router` registration — the global
   write gate still covers its non-GET endpoints.
3. Update the router module docstring to say the signature image is
   admin-and-above and why.
4. Tests in `test_signatures.py`: a `viewer_client` gets 403 from
   `GET /signatures` and from `GET /signatures/1/image`; an `admin_client`
   gets 200/404 as appropriate. Assert `== 403`, never "not 2xx" — a broken
   gate would answer 404 here and "not 2xx" would accept it.
5. In `test_authorization.py`, `test_get_requires_authentication` is
   unaffected (it tests 401, not 403). But the *tier* GET sweep, if one
   exists by then, must learn these are no longer open; check
   `_MIN_SWEPT_GET_ROUTES` still holds and add a comment naming the two
   paths as deliberately not-readable-by-all.
6. Frontend: `routes/SignaturesPage.tsx` already spreads `useWriteGate()`;
   a viewer now also gets a failed list query. Add the same no-access state
   the Users page uses (`routes/UsersPage.tsx:23`) rather than leaving an
   error banner. This is a stopgap — Task 4 replaces it with the real
   permission check.

**Do not** start the permission model in this task. It ships alone.

---

# Task 1 — Data model

**A. State of the world.** Task 0 is complete; the signature images are no
longer world-readable under the old tier model. Nothing else has changed.
This task adds the `permissions` column and everything that reads or writes
it as *data*. No authorization decision consults it yet — the column is
written, validated and returned, and the gates still use `access_level`.

**B. Files and deliverables.**

- `backend/app/models/user.py` — `permissions` column.
- `backend/app/models/permissions.py` (new) — the permission types, the
  default set, and the preset table.
- `backend/app/models/audit.py` — `user_permissions` column (D13).
- `backend/alembic/versions/010_user_permissions.py` (new) — both columns.
- `backend/app/api/schemas/auth.py` — `PermissionSet` schema with the
  non-empty validator; `UserOut`, `UserIn`, `UserPatch`.
- `backend/app/api/deps.py` — `record_audit_actor` snapshots permissions.
- `backend/app/api/audit.py` — carry `user_permissions` through the context
  and the write.
- `backend/app/api/routers/users.py` — accept and persist `permissions`.
- `backend/seed/seed_users.py` — seed the manager preset.
- `backend/tests/test_api/conftest.py` — `_StubUser` gains `permissions`.
- `backend/tests/test_api/test_users.py`, `test_audit.py` — coverage.
- `frontend/src/api/types.ts` — `Permissions`, `AuthUser.permissions`,
  `UserIn`/`UserPatch`.
- `frontend/src/test/fixtures/reference.ts` — `makeAuthUser` default.

**C. Instructions.**

1. `app/models/permissions.py`: define `AccessArea = Literal["none",
   "read", "write"]`, a `PERMISSION_KEYS` tuple, `DEFAULT_PERMISSIONS`
   (everything denied), and `PRESETS` keyed by the five preset names from
   D14. Keep this module free of FastAPI and SQLAlchemy imports so both the
   schema layer and the seed script can use it.
2. `User.permissions`: `mapped_column(MutableDict.as_mutable(JSON),
   nullable=False, default=lambda: dict(DEFAULT_PERMISSIONS),
   server_default=...)`. Use `sqlalchemy.JSON`, **not** `JSONB` — the test
   suite builds SQLite from the models. Read D3's note on
   change-tracking; if you deviate from `MutableDict`, pin whole-dict
   reassignment with a test that mutates a key and re-reads after a commit.
   The `server_default` should be the deny-everything object so a row
   inserted outside the app is safe by default, matching why `access_level`
   server-defaults to `nurse`.
3. Migration `010`: add `users.permissions` and
   `audit_log.user_permissions`. Follow `009_user_staff_links.py`'s
   conventions exactly — `batch_alter_table`, named constraints, a
   docstring explaining what it does and why, and a working downgrade. It
   needs a **backfill**: every existing row gets the preset matching its
   current `access_level` (manager -> Manager preset, admin -> Rota admin,
   doctor/nurse -> Read-only). Nothing is live, but the migration must be
   correct against the seeded dev database and CI runs `upgrade head` /
   `downgrade base` against Postgres.
4. `schemas/auth.py`: a `PermissionSet` model with the five fields and a
   `model_validator(mode="after")` implementing D15 (reject the
   all-denied set) with a message the form can show verbatim. Add
   `permissions: PermissionSet` to `UserOut` and `UserIn` (required, no
   default — same reasoning as `access_level` on `UserIn`) and
   `permissions: PermissionSet | None = None` to `UserPatch`. Do **not**
   add it to `UserSelfPatch`: nobody edits their own permissions.
5. `deps.py` / `audit.py`: `record_audit_actor` sets
   `ctx.user_permissions = json.dumps(user.permissions, sort_keys=True)`;
   `AuditContext` gains the field; the middleware writes it. Keep it a
   compact string — the column is a `String`, matching
   `user_access_level`'s existing treatment.
6. `routers/users.py`: `create_user` and `update_user` persist
   `permissions`. `update_user` already loops `updates.items()` via
   `setattr`; confirm a `PermissionSet` arrives as a plain dict there
   (`model_dump()`) and not as a Pydantic object, or the column gets an
   unserialisable value.
7. `seed/seed_users.py`: the seeded user gets the Manager preset. It reads
   `SEED_USER_ACCESS_LEVEL` today; do not add a second env var — derive the
   permissions from the preset matching that level, and print them in the
   confirmation line.
8. `tests/test_api/conftest.py`: **`_StubUser` (line 81) has no
   `permissions` attribute and defaults to `MANAGER`.** Give it a
   `permissions` argument defaulting to the Manager preset, so the whole
   existing suite keeps exercising the full surface once Task 2 lands. This
   is load-bearing: without it every API test file breaks at once in Task 2
   and the failure will look like a gating bug.
9. Frontend types and `makeAuthUser`: add `permissions`, defaulting to the
   Manager preset for the same reason `access_level` defaults to
   `"manager"` there.

**Explicitly not in this task:** no gate reads `permissions` yet, and no UI
renders it. A test asserting the column round-trips and the validator
rejects the empty set is the deliverable.

---

# Task 2 — Backend gate rework

**A. State of the world.** Tasks 0 and 1 are complete: the `permissions`
column exists, is validated, is persisted, is snapshotted into the audit
log, and reaches the frontend on `UserOut` — but nothing reads it for an
authorization decision. `require_write_access` and `require_manager` still
run off `access_level`. This task switches the gates over. After it,
`access_level` is decorative.

**B. Files and deliverables.**

- `backend/app/api/deps.py` — `require_access` factory, `require_capability`,
  the shared-read allowlist; delete `require_write_access` / `require_manager`
  and the `_TIER` table.
- `backend/app/api/main.py` — the router→area map and the completeness check.
- `backend/app/api/routers/users.py` — per-endpoint `user_admin`;
  `_active_user_admin_count`.
- `backend/app/api/routers/doctors.py` — the rotate endpoint (D12).
- `backend/app/api/routers/reception_staff.py` — the delete endpoint (D12).
- `backend/app/api/routers/audit.py` — drop its own `require_manager`; the
  area map covers it.
- `backend/app/api/routers/signatures.py` — drop Task 0's stopgap gate; the
  area map covers it.

**C. Instructions.**

1. `deps.py`: `require_access(area: Area)` returns a dependency closure.
   Inside it: if `(request.method, request.scope["route"].path)` is in
   `_SHARED_READ`, allow. Otherwise, for a level area, allow safe methods
   at `read` or `write` and non-safe at `write` only; for a boolean area,
   allow everything if the flag is true. 403 in every other case, with an
   area-specific detail string. Keep `_SAFE_METHODS` as it is, and keep the
   existing docstring's reasoning about `POST /signatures/{id}/apply` being
   gated as a write — that argument is unchanged.
2. `_SHARED_READ` is a `frozenset` of exactly two entries (D6), each with a
   comment naming its caller. Resist adding a third without the same kind
   of justification `_UNGATED` demands.
3. `require_capability(name)` for the per-endpoint cases: method-agnostic,
   403 if the boolean is false. Used by `users.py` and, in conjunction with
   the router's own area gate, by the two D12 endpoints.
4. `main.py`: `_AREA: dict[ModuleType, str]` covering every module in
   `_ALL_ROUTERS` except the three in `_UNGATED`. Assignment:
   - `clinical`: rota, clinic_types, doctors, leave, leave_entitlement,
     leave_planning, extra_sessions, duty, rooms, counters, master_rota,
     staging, closures, school_holidays, recurring_notes
   - `reception`: reception_staff, reception_master, reception_rota,
     reception_leave, reception_counters
   - `signatures`: signatures
   - `study_eoi`: eoi
   - `user_admin`: audit_router
   The include loop does `_AREA[module]` directly so an unclassified router
   raises `KeyError` at import (D5). Add a module-level assertion that
   `set(_AREA) | set(_UNGATED) == set(_ALL_ROUTERS)` so the reverse mistake
   — a stale entry for a deleted router — is caught too.
5. Rewrite `main.py`'s and `deps.py`'s module docstrings. They currently
   describe the tier model in detail and are the first thing anyone reads;
   a stale docstring here is worse than none. Carry over the *reasoning*
   (why registration-time, why not router-level `dependencies=`, why 403
   not 404) and update the mechanics.
6. `routers/users.py`: swap `Depends(require_manager)` for
   `Depends(require_capability("user_admin"))` on the three admin
   endpoints; leave `PATCH /users/me` alone. Rename
   `_active_manager_count` to `_active_user_admin_count` and query the JSON
   column (D11) — on SQLite that is `json_extract(users.permissions,
   '$.user_admin')`; use SQLAlchemy's dialect-neutral
   `User.permissions["user_admin"].as_boolean()` and verify it emits
   working SQL on both backends, because this is the one place the JSON
   column is queried rather than read whole.
7. `routers/doctors.py:245` and `routers/reception_staff.py:209`: replace
   `Depends(require_manager)` with `Depends(require_capability("user_admin"))`.
   The router's area gate already runs alongside, so the effect is the
   conjunction D12 specifies. Update both docstrings — each explains *why*
   it is manager-only, and that reasoning now needs to name the permission.
8. `routers/audit.py`: delete the router-level `Depends(require_manager)`.
   The area map covers it, and leaving both would be the per-endpoint
   pattern D5 exists to avoid. Keep the module docstring's explanation of
   why the whole router is admin-only.
9. `routers/signatures.py`: remove Task 0's explicit gate from the two GETs
   — the `signatures` area now covers them.
10. Grep for `require_write_access`, `require_manager`, `_TIER`,
    `_WRITE_TIER`, `_MANAGER_TIER` and confirm zero remaining references
    outside tests before finishing.

---

# Task 3 — Authorization test rework

**A. State of the world.** Tasks 0–2 are complete: the backend is gated on
the permission set and `access_level` is decorative. The test suite has not
been updated, so `test_authorization.py` is asserting the old model and much
of it is failing. This task is what keeps the system default-deny; it is not
a cleanup pass. **Do not trim the sweeps.**

**B. Files and deliverables.**

- `backend/tests/test_api/conftest.py` — replace the tier client fixtures
  with permission-profile ones.
- `backend/tests/test_api/test_authorization.py` — rewrite both sweeps.
- Any test file that requests `viewer_client` / `admin_client` /
  `manager_client` — mechanical update.

**C. Instructions.**

1. `conftest.py`: replace `client_at_tier(AccessLevel)` with
   `client_with_permissions(permissions_dict)`, keeping the single-use
   guard and its docstring verbatim — the "one shared
   `app.dependency_overrides` dict" trap is unchanged and is the single most
   important thing in that file. Provide named fixtures for the D14 presets
   (`manager_client`, `rota_admin_client`, `reception_admin_client`,
   `documents_client`, `readonly_client`) plus a `no_access_client` for the
   otherwise-invalid all-denied set, which is exactly what the gate must
   handle.
2. Keep `_all_non_get_routes()` / `_all_get_routes()` and their docstrings
   as they are. The OpenAPI-schema enumeration is correct and its reasoning
   (FastAPI 0.139's `_IncludedRouter`, why path params are filled with "1",
   why sub-dependencies resolve before validation) still holds.
3. Both sweeps become **per-profile**, parameterised over the profiles.
   Build one expectation table: for each profile, the set of route prefixes
   it may reach. For every route, assert `== 403` when the profile cannot
   reach it and `!= 403` when it can. Never assert "not 2xx" — most sweep
   requests send empty bodies and would 422, and "not 2xx" accepts that.
4. `_MIN_SWEPT_ROUTES` (60) and `_MIN_SWEPT_GET_ROUTES` (30) become
   **per-profile floors**, re-derived from the actual assignment. A single
   global floor cannot catch a profile whose own sweep silently collapses to
   nothing, which is precisely the failure the tripwires exist for. Current
   totals are 40 GET paths and 83 non-GET operations; the provisional plan's
   39/78 were stale.
5. Add a test asserting `_SHARED_READ`'s exact contents (D6a) — two entries,
   both GET, both list endpoints. It should fail if anyone adds a third, so
   that widening the hole is a decision rather than a test fix. Model the
   comment on `_UNAUTHENTICATED_GET_PATHS`, which does the same job.
6. Add a test that `_AREA` covers every gated router — the import-time check
   from Task 2 already enforces it, but a test states the property where
   someone will read it.
7. `_UNAUTHENTICATED_GET_PATHS` and `test_get_requires_authentication` are
   about 401, not 403, and are unchanged. Leave them alone.
8. Keep the two "sweep is not empty" tripwires, one per sweep, per profile.

---

# Task 4 — Frontend permission model

**A. State of the world.** Tasks 0–3 are complete: the backend is fully
gated on permissions and the test suite proves it. The frontend still
derives `canWrite` / `isManager` from `access_level`, so it shows controls
that now 403 and hides none of the sections a user cannot read. This task
makes the UI match. Frontend gating stays UX only.

**B. Files and deliverables.**

- `frontend/src/auth/AuthContext.tsx` — permission set, area context, hooks.
- `frontend/src/App.tsx` — nav predicates, the new `AdminShell`, area
  providers, route guards, `/clinical/users|audit` redirects.
- `frontend/src/routes/LandingPage.tsx` — filtered tiles, fourth tile.
- `frontend/src/routes/AuditLogPage.tsx`, `UsersPage.tsx`,
  `CalendarFeedPage.tsx`, `ReceptionStaffPage.tsx` — the four
  `useIsManager()` call sites.
- `frontend/src/test/renderWithProviders.tsx` — a `permissions` option.
- `frontend/src/auth/AuthContext.test.tsx` and the affected page tests.

**C. Instructions.**

1. `AuthContext.tsx`: `AuthState` carries `permissions` instead of
   `canWrite` / `isManager`. Keep the deny-by-default context value — a
   component outside a provider must still get nothing, and the existing
   docstring explains why.
2. Add `PermissionAreaContext` and `<PermissionAreaProvider area="...">`.
   `useCanWrite()` reads the area from that context and returns
   `level === "write"` (or the boolean, for capability areas); with no area
   in context it returns `false`. `useCanRead(area?)` likewise.
   **`useCanWrite()` and `useWriteGate()` keep their exact signatures** so
   the 31 existing call sites are untouched (D7) — verify that by grepping
   after the change, not by assumption.
3. Replace `useIsManager()` with `useCanAdminUsers()` and update the four
   call sites listed above. `ReceptionStaffPage.tsx:22` and
   `CalendarFeedPage.tsx:83` gate the two D12 endpoints and must ask for
   `user_admin`, matching the backend conjunction — not for `reception` /
   `clinical` write.
4. `App.tsx`: generalise `NavItem.managerOnly` into an optional
   `requires?: (p: Permissions) => boolean` predicate. Rewrite the
   `managerOnly` docstring — it currently explains that every page is worth
   reading at any tier, which stops being true.
5. Add `AdminShell` at `/admin/*` holding Users and Audit Log (D10), guarded
   on `user_admin`. Add `<Navigate>` redirects from `/clinical/users` and
   `/clinical/audit`. Remove both from `CLINICAL_NAV_ITEMS`.
6. Wrap each shell's content in the matching `PermissionAreaProvider`
   (`clinical`, `reception`, `user_admin`). `SignaturesShell` holds two
   different capabilities — Signatures and Study EOI — so put the provider
   on each route inside it, not on the shell.
7. Route guards: each shell redirects to `/` when the user cannot read its
   area. `SignaturesShell` is reachable if *either* capability is held, and
   its sub-tab bar (`SignaturesLayout`) filters to the ones held.
8. `LandingPage.tsx`: render only enterable tiles, plus a fourth
   "Administration" tile for `user_admin`. If no tile is enterable, show an
   explanatory message rather than an empty grid — D15 makes that state
   unreachable through the form, but a deactivated-then-reactivated edge or
   a hand-edited row should not render a blank page.
9. `renderWithProviders.tsx` / `authWrapper()`: add a `permissions` option
   defaulting to the Manager preset, and an `area` option so a test can
   render a section-scoped component. Keep the `accessLevel` option — it
   still feeds the label — and update its docstring, which currently claims
   the level is what the gating reads.
10. `AuthContext.test.tsx` must pin the deny-outside-a-provider property for
    both the permission set and the missing-area case.

---

# Task 5 — Users admin UI

**A. State of the world.** Tasks 0–4 are complete and the feature works
end to end for users whose permissions were set by seed or by hand. The one
missing piece is the editor: the Users page still shows only the four-value
access level, so there is no way to grant or revoke a permission through the
UI.

**B. Files and deliverables.**

- `frontend/src/lib/permissions.ts` (new) — labels, the preset table, the
  non-empty check.
- `frontend/src/lib/userSchema.ts` — permissions in the form values, the
  Zod refinement for D15.
- `frontend/src/components/UserFormDialog.tsx` — the editor.
- `frontend/src/routes/UsersPage.tsx` — effective permissions in the table.
- `frontend/src/lib/accessLevels.ts` — updated descriptions.
- The matching `.test.tsx` / `.test.ts` files.

**C. Instructions.**

1. `lib/permissions.ts`: mirror `app/models/permissions.py` — the five keys,
   their display labels, the D14 preset table, and an `isEmptyPermissionSet`
   helper. Add a comment naming the backend file as the source of truth, the
   way `userSchema.ts` already names `schemas/auth.py`.
2. `userSchema.ts`: add `permissions` to `UserFormValues`, to
   `emptyFormValues()` (Read-only preset, matching the existing "an
   accidental viewer is recoverable, an accidental manager is a silent hole"
   rationale), to `formValuesFromUser()`, and to both payload builders. Add
   a `.superRefine` implementing D15 with the same message the backend
   validator returns.
3. `UserFormDialog.tsx`: a "Start from preset" button row that fills the
   controls, then two radio groups (clinical, reception:
   None / Read only / Can edit) and three checkboxes. The preset is a
   starting point, not a stored value — once a control is touched, no preset
   is selected. Keep the existing access-level select as the label field and
   relabel it so it does not read as the permission control.
4. The dialog already calls `useDoctors(false)` and `useReceptionStaff(true)`
   (lines 62-63). Those work for a `user_admin`-only login because of D6's
   shared-read allowlist. Add a test rendering the dialog with a
   user_admin-only permission set that asserts both pickers populate — that
   test is the regression guard for the allowlist and should say so.
5. `UsersPage.tsx`: add a permissions column. A compact summary
   ("Clinical: edit · Reception: read · Signatures") beats five icons.
   `handleAccessLevelChange` (line 97) currently patches the level inline
   from the table — decide whether inline permission editing is worth it or
   whether the dialog is the only editor; the dialog alone is simpler and is
   the recommendation.
6. `accessLevels.ts`: the descriptions ("Full access, including managing
   users", "Read-only") describe permissions that the level no longer
   grants. Rewrite them as what they now are — labels, with the permissions
   shown separately.

---

# Task 6 — Review and documentation

**A. State of the world.** Tasks 0–5 are complete and the feature is live.
This step is review and documentation only; make no behavioural change
unless the review finds a defect.

**C. Instructions.**

1. Run the full backend and frontend suites. Confirm the per-profile sweeps
   in `test_authorization.py` actually run over a non-trivial number of
   routes per profile — read the collected counts, do not just watch it go
   green.
2. Manually verify the three profiles that matter, against a real login:
   a `user_admin`-only user can create a user (both pickers populate); a
   Reception admin sees the clinical rota read-only and cannot open
   Documents; a Documents user sees only that tile.
3. Update `documentation/architecture.md`:
   - Line 41 (the enforcement sentence), line 46 (`canWrite`/`isManager`),
     line 47 ("Users and Audit Log are the only nav entries hidden below
     manager" — no longer true), line 49 (ChangePasswordDialog's "all four
     tiers"), line 61 ("reads stay open to every tier" — no longer true),
     line 98 (the Auth row of the capability table), and line 129
     (seed_users).
   - Add the permission model, the router→area map and its import-time
     completeness check, the shared-read allowlist and why it has exactly
     two entries, and the D12 conjunctions.
   - Keep the "gating is centralised and default-deny" property stated as a
     property, with the reason per-endpoint gating was rejected. That is the
     single most important thing for anyone adding a router later.
   - Delete the stale four-tier description.
4. Note in the architecture doc that `access_level` is now decorative, and
   what still reads it (display labels, presets, the audit snapshot) so
   nobody re-derives authorization from it.
5. Delete this file.

## Effort

Task 0 is under an hour and ships alone. Tasks 1–2 are the backend day.
Task 3 is a half-day of careful test work and is the task most likely to be
under-estimated — it is a rewrite of the property that keeps the system
default-deny, not a fixup. Tasks 4–5 are the frontend day. Task 6 is an
hour plus whatever the review turns up.

The riskiest part is still read gating (D6), because it is the only part
with no existing equivalent to generalise from — and the `UserFormDialog`
find suggests the sweep should be re-run against the finished UI in Task 6
rather than trusted from the plan.
