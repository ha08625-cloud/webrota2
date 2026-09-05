# Implementation Plan — Linking App Users to Rota Staff

**Status:** implementation plan, reviewed and expanded from the provisional
plan. Each task below is written to be pasted into its own chat as the whole
context for that chat.

## Plan

`users` and the two staff tables (`doctors`, `reception_staff`) are entirely
unrelated. `AccessLevel.DOCTOR` is a permission label, documented in
`models/enums.py` as "not linked to any Doctor or ReceptionStaff row". So the
app knows a request came from Charlie, but not that Charlie is `CH` on the
clinical rota.

That gap blocks every per-person feature. This ticket closes it with two
nullable FK columns on `users`, a manager-operated picker on the Users page,
and three read-only frontend defaults that prove the link is shaped right.

## Scope

**In scope:** an optional link from a `User` to at most one `Doctor` and at
most one `ReceptionStaff`; managing that link from the Users page; exposing it
through `/auth/me`; and three read-only frontend behaviours that read it.

**Out of scope:** anything that lets a user *write* on behalf of their linked
staff member. Every feature here reads. Nothing in this ticket changes the
authorization model — reads are already open to all four tiers, so no endpoint
gains or loses a permission dependency, and `require_write_access` /
`require_manager` are untouched.

Also out of scope: changing what `access_level` means; automatic name matching;
creating logins from the Doctors page; notifications; and any new API endpoint
at all (see D6 — the calendar work turned out to need none).

## Design Decisions

### D1. Two nullable FK columns on `users`, each uniquely indexed

`users.doctor_id` and `users.reception_staff_id`, both `nullable=True`, each
under its own unique index.

- **On `users`, not on the staff tables**, because linking is a privilege
  grant: it decides whose rota is "yours" and, in any future ticket, what you
  are allowed to act on. The Users page is manager-only; the Doctors page is
  writable by any admin. Putting the column on `doctors` would let an admin
  grant themselves a clinical identity.
- **Two typed FK columns, not a polymorphic `(kind, ref_id)` pair**, which
  would give up referential integrity to save one column in a schema that has
  exactly two staff types and no prospect of a third.
- **Unique indexes give the 0..1 : 0..1 semantics for free.** Both SQLite and
  Postgres treat NULLs as distinct in a unique index, so any number of users
  may be unlinked while no two users can claim the same staff row.
- **Both columns may be set on the same user.** Not expected to be common, but
  a nurse who also covers reception is real, and allowing it costs nothing.

### D2. The link is manual, chosen by a manager. No name matching.

`Doctor.code` is initials-style, `ReceptionStaff.code` is a human-typed display
name ("Emily M"), and `User.name` is free text. Matching two free-text fields
where a false positive means showing someone another person's rota as their own
is a bad trade for saving a one-off set of dropdown clicks at a practice with a
few dozen staff. Not even a "suggested match" hint in v1 — the suggestion is
what gets clicked through.

### D3. The link is orthogonal to `access_level`. Neither derives the other.

A partner who runs the rota needs `manager` tier *and* a doctor link; a
practice manager needs no link at all; a locum may have a Doctor row and no
login. So:

- Linking does not require or imply `access_level == doctor`.
- Changing `access_level` never changes the link, and vice versa.
- `AccessLevel.DOCTOR` stays exactly what its docstring says it is: a label,
  permission-identical to `NURSE`.

This is the decision most likely to get quietly fudged during implementation,
so Task 2 and Task 3 each carry a test that pins it: a PATCH that sets
`doctor_id` must leave `access_level` untouched, and choosing a doctor in the
form must not move the access-level select.

### D4. Deactivation and deletion null the link; they never delete a user

- `Doctor` DELETE is a soft delete (`active=False`), so a linked doctor row
  never disappears. A link to an inactive doctor is allowed and **shown as
  such** rather than being auto-cleared — clearing it silently would lose the
  record of who that login belonged to.
- `ReceptionStaff` DELETE is a **hard** delete that explicitly purges every
  referencing table. Adding this FK will fail
  `test_purged_models_covers_every_fk_to_reception_staff`, correctly. The fix
  is to null `users.reception_staff_id`, not to add `User` to
  `PURGED_MODELS` — see D7 for why that distinction is load-bearing.
- Deactivating a user leaves the link intact. A deactivated user cannot log in,
  so the link is dormant, and reactivating them should restore what they had.

### D5. The link reaches the frontend through `UserOut`, and the UI reads it from `AuthContext`

`UserOut` gains `linked_doctor` and `linked_reception_staff`, each nullable and
carrying `{id, code, active}`. `UserOut` is the response model for `GET
/auth/me`, `POST /auth/login`, `GET /users`, `POST /users` and both PATCHes, so
one schema change serves both consumers: the logged-in user's own link, and the
manager's view of who is already claimed. **No new endpoint is needed for
either.**

`active` is on the nested object so the Users page can render "AB (inactive)"
without a second lookup — cheap, and D4 makes an inactive link a state the UI
must be able to show.

`AuthContext` derives `linkedDoctorId` / `linkedReceptionStaffId` alongside
`canWrite` / `isManager`, exposed as `useLinkedDoctorId()` /
`useLinkedReceptionStaffId()`. Components call the hook rather than reading
`user.linked_doctor?.id`, for the same reason they call `useCanWrite()` —
the shape of the link lives in one file. Consumers read the hook directly
rather than being handed a prop, so no page has to prop-drill identity into
`RotaGrid`.

### D6. The calendar feature is a default, not an endpoint

The provisional plan proposed `GET /doctors/me/calendar-feed`. Reviewing the
code, that endpoint would add nothing: `GET /doctors/{doctor_id}/calendar-feed`
is already readable at every tier (its docstring says so deliberately), and
`frontend/src/routes/CalendarFeedPage.tsx` already exists and asks the user to
pick themselves from a dropdown. A `/me` variant would be a second route
returning the same payload for a doctor id the client already knows.

So the calendar work here is: **default that dropdown to the linked doctor and
label it as you**. That removes the page's one real failure mode — picking the
wrong person and putting a colleague's rota in your calendar — which is exactly
what the page's own comment says it is exposed to. The page keeps the picker, so
a manager can still fetch anyone's URL, and the unauthenticated `.ics` route and
the manager-only rotate endpoint are both untouched.

### D7. `users` is nulled by the reception delete, not purged by it

`PURGED_MODELS` in `routers/reception_staff.py` drives three things at once: the
delete loop (which does `delete(model).where(model.staff_id == staff.id)`), the
`ReceptionStaffDeletedCounts` response fields, and the FK-coverage tripwire
test. `users` fits none of them — it has no `staff_id` column, deleting the row
would be catastrophic rather than merely wrong, and a fourth count field for a
number that is always 0 or 1 is noise in a schema whose purpose is reporting
destroyed history.

So the delete gains an explicit `UPDATE users SET reception_staff_id = NULL`
step before the purge loop, a module-level `NULLED_TABLES = ("users",)` next to
`PURGED_MODELS`, and the tripwire test asserts
`referencing == purged | set(NULLED_TABLES)`. The tripwire still fires for a
genuinely new staff-referencing table; it just now has two correct answers
instead of one. The null-out is **not** reported in the delete response.

### D8. Reads stay open to every tier. Confirmed, not overlooked.

Every rota and leave surface remains readable by all four tiers after this
ticket, exactly as before. The link says who you are; it does not say what you
may see. This was reviewed explicitly rather than defaulted into: restricting a
doctor tier to their own data would touch nearly every GET in the app, change
what the grids can render, and needs its own discussion chat. Task 5 records it
in `architecture.md` as a decision so the next person finds an answer rather
than an omission.

### D9. The Users page (clinical shell) reads reception data

`UsersPage` lives under the clinical shell, and the reception staff hook lives
in `frontend/src/api/reception.ts`. The picker therefore imports across a domain
boundary. This is accepted: the shell rule in `architecture.md` is about routes,
components and nav items, not about which query hooks a page may call, and user
management is genuinely cross-domain — it is the one page that administers
people for both rotas. No hook is moved or duplicated.

## Task 1: Data model and migration

**A.** Nothing is built yet. This task adds the two FK columns to `User` and the
Alembic revision for them. No API, schema or frontend change belongs here.

**B. Files and deliverables**

- `backend/app/models/user.py` — the two columns and two relationships.
- `backend/alembic/versions/009_user_staff_links.py` — new file.
- `backend/tests/test_auth_models.py` — model-level tests.

Read first: `backend/app/models/user.py` (its module docstring is the house
style for explaining *why* a column exists),
`backend/alembic/versions/007_doctor_calendar_token.py` (the migration house
style, including the `batch_alter_table` rule and the "only Postgres runs
this" note), and `backend/app/models/doctor.py` / `reception.py` for the two
target tables.

**C. Instructions**

1. On `User`, add:

   ```python
   doctor_id: Mapped[int | None] = mapped_column(
       ForeignKey("doctors.id"), nullable=True
   )
   reception_staff_id: Mapped[int | None] = mapped_column(
       ForeignKey("reception_staff.id"), nullable=True
   )
   ```

   plus `__table_args__` entries `Index("uq_users_doctor_id", "doctor_id",
   unique=True)` and `Index("uq_users_reception_staff_id",
   "reception_staff_id", unique=True)`. Name them explicitly — the downgrade
   drops them by name on Postgres. Note `__table_args__` is currently a
   one-element tuple holding the email `UniqueConstraint`; extend it.

2. Add `doctor: Mapped["Doctor" | None]` and
   `reception_staff: Mapped["ReceptionStaff" | None]` relationships, **with no
   `back_populates`** — nothing on the staff side needs to navigate to a user,
   and a back-reference would put a user-shaped attribute on `Doctor`, which
   D1 exists to avoid. Import the two models under `TYPE_CHECKING` if a runtime
   import would cycle; check `backend/app/models/__init__.py` import order
   first.

3. Extend the module docstring with the D1 reasoning: why the columns are here
   rather than on the staff tables, why two typed columns rather than a
   polymorphic pair, and that the unique index is what makes the relationship
   0..1 on both sides because NULLs are distinct in a unique index on both
   engines. Do not cite this plan file — write the reasoning itself
   (`architecture.md`, "Document Index", explains that rule).

4. Migration `009`, `down_revision = "008"`. Two `op.add_column` calls and two
   `op.create_index(..., unique=True)` calls; downgrade drops both indexes then
   both columns. No backfill — every existing row is legitimately unlinked, and
   the columns are nullable, so no `batch_alter_table` is needed here (that
   rule applies to *altering* a column). It must survive CI's Postgres
   upgrade/downgrade/upgrade round trip.

5. Tests in `test_auth_models.py`: a user can be created with both links null;
   with a doctor link only; with both links set (D1's nurse-on-reception case);
   two users cannot share one doctor (`IntegrityError`); two users cannot share
   one reception staff member; **many users can have both links null**, which is
   the case a naive unique constraint would break and is the whole reason the
   NULL-distinctness argument is in the docstring. `PRAGMA foreign_keys=ON` is
   already set by `tests/conftest.py`, so an FK to a nonexistent row raises
   here too — add that case.

## Task 2: API — reading and setting the link

**A.** Task 1 is done: `users.doctor_id` and `users.reception_staff_id` exist
with unique indexes, relationships and a migration. Nothing reads or writes them
yet. This task exposes them on `UserOut` and makes them settable by a manager.

**B. Files and deliverables**

- `backend/app/api/schemas/auth.py` — `StaffLinkOut`, and the new fields on
  `UserOut` / `UserIn` / `UserPatch`.
- `backend/app/api/routers/users.py` — validation on create and patch.
- `backend/app/api/routers/reception_staff.py` — the null-out in the delete.
- `backend/tests/test_api/test_users.py`, `backend/tests/test_api/test_auth.py`,
  `backend/tests/test_api/test_reception_staff.py`.

Read first: all of `routers/users.py` (its docstring documents the per-endpoint
gating trap and the lock-out guard), `schemas/auth.py`, and the module docstring
plus `PURGED_MODELS` block of `routers/reception_staff.py`.

**C. Instructions**

1. In `schemas/auth.py` add:

   ```python
   class StaffLinkOut(BaseModel):
       id: int
       code: str
       active: bool
       model_config = {"from_attributes": True}
   ```

   and on `UserOut`: `linked_doctor: StaffLinkOut | None = None` and
   `linked_reception_staff: StaffLinkOut | None = None`. These are **not** the
   ORM attribute names (`doctor` / `reception_staff`), so give each a
   `validation_alias`/`serialization_alias` pair or, more simply, populate
   `UserOut` via an explicit helper in the router. Prefer whichever the file's
   existing style supports without adding a Pydantic feature it does not
   already use; if in doubt, name the ORM relationships `linked_doctor` /
   `linked_reception_staff` in Task 1 instead and keep `from_attributes`
   working with no aliasing at all. **Check what Task 1 actually named them
   before writing this.**

2. `UserIn` and `UserPatch` each gain `doctor_id: int | None = None` and
   `reception_staff_id: int | None = None`. `UserSelfPatch` does **not** —
   self-linking is self-promotion, and its docstring already explains the
   omit-by-design pattern; add the two fields to that explanation.

3. `create_user` currently ignores everything except the four fields it names.
   Pass the two ids through, after validation.

4. `patch_user` loops `setattr(target, field, value)` over
   `model_dump(exclude_unset=True)`, so the new fields would flow through
   **unvalidated**. That is a real bug, not a nicety: with
   `PRAGMA foreign_keys=ON` in tests and real FKs in Postgres, a bad id raises
   `IntegrityError`, which this function's existing `except IntegrityError`
   converts to `409 "Email already exists"` — a 409 with a wrong, actively
   misleading message. So:

   - Add a shared helper (e.g. `_validate_staff_links(db, updates,
     exclude_user_id)`) called **before** the mutation, in both `create_user`
     and `patch_user`.
   - Unknown id → `404`, message in the style of the file's existing
     `f"User {user_id} not found"`.
   - Already claimed by another user → `409`, matching the email-conflict
     precedent. On PATCH, exclude the target user's own id, so re-saving a form
     that has not changed the link is not a conflict with itself.
   - Explicit `None` clears the link. `exclude_unset=True` already
     distinguishes "sent null" from "not sent", so unlinking works and an
     unrelated PATCH does not clobber the link.
   - Leave the `IntegrityError` handler in place as the race-condition
     backstop, but make its detail cover both causes rather than naming email
     only.

5. `patch_user`'s lock-out guard is unaffected — the link cannot create or
   remove a manager (D3). Do not touch it.

6. In `routers/reception_staff.py`, implement D7: add `NULLED_TABLES =
   ("users",)` beside `PURGED_MODELS` with a comment explaining why `users` is
   nulled and not purged, and in `delete_staff` run

   ```python
   db.execute(
       update(User)
       .where(User.reception_staff_id == staff.id)
       .values(reception_staff_id=None)
       .execution_options(synchronize_session=False)
   )
   ```

   before the purge loop (before, so the FK is clear whichever order the engine
   checks in). The response schema is unchanged. Extend the module docstring —
   it currently claims the delete purges "every row that references them", which
   stops being the whole truth here.

7. `test_purged_models_covers_every_fk_to_reception_staff` currently asserts
   exact set equality against `PURGED_MODELS` and will now fail. Change the
   expectation to `{m.__tablename__ for m in PURGED_MODELS} |
   set(NULLED_TABLES)` and update the failure message to say a new table must
   be added to one list or the other. Do not weaken it to a subset check.

8. Tests:

   - `test_users.py`: create with a link; create with an unknown doctor id →
     404; create with an already-claimed id → 409; PATCH to set, to change, to
     clear (`null`), and re-PATCH the same link on the same user → 200 not 409;
     PATCH `access_level` alone leaves the link intact and PATCH `doctor_id`
     alone leaves `access_level` intact (D3); `GET /users` includes
     `linked_doctor` for a linked user and `null` for an unlinked one; a
     soft-deleted doctor still serialises, with `active: false` (D4).
   - `test_users.py`: `PATCH /users/me` with `doctor_id` in the body is
     **silently ignored** and the link is unchanged — the same shape as the
     existing access-level test on `UserSelfPatch`.
   - `test_auth.py`: `GET /auth/me` carries the link for a linked user. Note
     the trap in `test_api/conftest.py`'s docstring — `get_current_user` is
     dependency-overridden by most fixtures, so this test must go through a
     real seeded user and a real login to assert anything.
   - `test_reception_staff.py`: deleting a staff member nulls a linked user's
     `reception_staff_id` and leaves the user row present and active.
   - Authorization: a viewer and an admin both get 403 from `PATCH
     /users/{id}`. This is already covered by the existing manager-only tests
     on the route; confirm rather than duplicate.

## Task 3: Frontend — wire types, auth context, and the picker

**A.** Tasks 1–2 are done: the link exists in the database, `UserOut` carries
`linked_doctor` / `linked_reception_staff`, and `POST`/`PATCH /users` accept
`doctor_id` / `reception_staff_id` with 404/409 validation. The frontend knows
nothing about any of it. This task adds the wire types, the context hooks, and
the manager-facing picker. No feature reads the link yet — that is Task 4.

**B. Files and deliverables**

- `frontend/src/api/types.ts` — `StaffLink`, and the new fields on `AuthUser`,
  `UserIn`, `UserPatch`.
- `frontend/src/auth/AuthContext.tsx` — the two derived ids and their hooks.
- `frontend/src/lib/userSchema.ts` — form values, zod fields, and both payload
  mappers. **The dialog does not build payloads itself; this file does.**
- `frontend/src/components/UserFormDialog.tsx` — the two selects.
- `frontend/src/routes/UsersPage.tsx` — a "Linked to" column.
- `frontend/src/test/fixtures/reference.ts` — `makeAuthUser` gains the fields.
- Tests: `frontend/src/components/UserFormDialog.test.tsx` (create if absent),
  `frontend/src/routes/UsersPage.test.tsx`, plus an `AuthContext` test
  wherever the existing `canWrite`/`isManager` tests live.

Read first: `frontend/src/auth/AuthContext.tsx`, `frontend/src/lib/userSchema.ts`
and `frontend/src/components/UserFormDialog.tsx` in full; `frontend/src/api/doctors.ts`
(`useDoctors(activeOnly = false)`) and `frontend/src/api/reception.ts`
(`useReceptionStaff`, which takes an `includeInactive` flag).

**C. Instructions**

1. `types.ts` is hand-mirrored by convention — add
   `export interface StaffLink { id: number; code: string; active: boolean }`
   and the two nullable fields on `AuthUser`, plus the two optional nullable id
   fields on `UserIn` and `UserPatch`. Match the backend field names exactly;
   these mirrors drift silently until `tsc` catches them.

2. `AuthContext`: add `linkedDoctorId: number | null` and
   `linkedReceptionStaffId: number | null` to `AuthState`, derive them in the
   `useMemo`, default them to `null` in the deny-by-default context value, and
   export `useLinkedDoctorId()` / `useLinkedReceptionStaffId()`. Extend the
   file's docstring: it currently says "the two booleans everything else in the
   UI actually asks about", which is about to be four things.

3. `makeAuthUser` in `test/fixtures/reference.ts` must default both new fields
   to `null` (they are non-optional on the wire type, so every existing caller
   would otherwise fail typecheck). Overrides let a test supply a link.

4. `userSchema.ts`: add `doctor_id` and `reception_staff_id` to
   `UserFormValues` as `number | ""` (`""` = the "Not linked" option, matching
   how `LeavePage` models an empty doctor select), default them to `""` in
   `emptyFormValues`, read them from `user.linked_doctor?.id ?? ""` in
   `formValuesFromUser`, and map `""` → `null` in **both** `toCreatePayload`
   and `toPatchPayload`. `null` rather than omitted is deliberate: the backend
   distinguishes "sent null" (clear the link) from "not sent" (leave it), and
   the edit form must be able to clear.

5. `UserFormDialog`: two selects below Access level, labelled "Linked doctor"
   and "Linked reception staff", each with a first `<option value="">Not
   linked</option>`. Populate from `useDoctors(false)` and
   `useReceptionStaff(true)` — **inactive included in both**, so a link made
   under D4 to a since-deactivated person still renders its own current value
   rather than silently falling back to "Not linked". Suffix inactive entries
   with " (inactive)". Exclude staff already claimed by a *different* user,
   computed from `useUsers()`, which the page already fetches; never exclude the
   user's own current link. Add a one-line hint under the pair: linking is what
   makes "my rota" and the calendar page know who you are, and it is
   independent of access level (D3). Do not touch the access-level select from
   these handlers.

6. `UsersPage`: one "Linked to" column showing the doctor code, the reception
   code, both, or "—", with inactive ones marked. Read-only; editing is the
   dialog's job.

7. Tests: the form pre-fills an existing link; choosing a doctor and saving
   sends `doctor_id`; choosing "Not linked" on a linked user sends `null`; a
   doctor already claimed by another user is absent from the options while the
   user's own current link is present; picking a link does not change the
   access-level select (D3); the server's 409 surfaces as `formError` like any
   other save failure; `AuthContext` yields the ids for a linked user, `null`
   for an unlinked one, and `null` outside a provider.

## Task 4: The three read-only self-service defaults

**A.** Tasks 1–3 are done: the link is stored, served on `UserOut`, settable
from the Users page, and readable through `useLinkedDoctorId()` /
`useLinkedReceptionStaffId()`. Nothing consumes it. This task adds the three
agreed consumers. All three are frontend-only — **no backend file changes at
all**, because every endpoint involved already returns every doctor to every
tier.

**B. Files and deliverables**

- `frontend/src/routes/CalendarFeedPage.tsx` (+ its test) — default the picker.
- `frontend/src/components/RotaGrid.tsx` (+ its test) — highlight your own row.
- `frontend/src/routes/LeavePlanningPage.tsx` (+ its test) — default the
  selected doctor.
- `frontend/src/routes/LeavePage.tsx` (+ its test) — default the filter.

Read first: each file's existing state declarations —
`CalendarFeedPage`'s `doctorId`, `LeavePlanningPage`'s `selectedDoctorId`,
`LeavePage`'s `filterDoctorId`, and `RotaGrid`'s props block (it takes no
doctor identity today and should not gain one — read the hook, per D5).

**C. Instructions**

1. **Every default must be an initial value, not an effect.** Use the lazy
   `useState(() => linkedDoctorId ?? initialToday)` form, so the user's own
   later choice is never overwritten by a re-render, and a user with no link
   gets exactly today's behaviour. A `useEffect` that re-applies the default
   is the bug to avoid here.

2. `CalendarFeedPage` (D6): initialise `doctorId` from `useLinkedDoctorId()`.
   When the selected doctor is the linked one, mark the option and the
   surrounding copy as you (e.g. "AB (you)"). The page's own comment says
   there is no link between a User and a Doctor row and that picking the wrong
   one puts the wrong rota in your calendar — replace that paragraph with what
   is now true, keeping the warning for the unlinked case. Do not remove the
   picker, and do not touch the rotate control or its manager gating.

3. `RotaGrid`: highlight the row whose doctor id equals `useLinkedDoctorId()`.
   This is presentation only — no change to `editable`, to the drag sources,
   or to the popovers, and it must not interact with the existing cell
   colouring in a way that makes a state unreadable. Prefer a left border or
   a row-header treatment over a background fill, which the cell colours
   already own. A user with no link, or one whose doctor is not in this rota,
   sees the grid exactly as today.

4. `LeavePlanningPage`: initialise `selectedDoctorId` from the hook. Its
   existing `handleSelectDoctor` toggles the selection off when the same doctor
   is clicked again, and that must keep working — the default is a starting
   value, not a floor.

5. `LeavePage`: initialise `filterDoctorId` from the hook so the entitlement
   summary and the calendar open on your own leave. Leave `formDoctorId` (the
   add/remove form) at `""`: defaulting the *write* form to yourself is one
   mis-click from booking leave for the wrong person, and this ticket's scope
   is reads.

6. Reception has no equivalent default in this task.
   `useLinkedReceptionStaffId()` ships unused by design — it is half of the
   data model and the reception pages are a separate, smaller surface. Say so
   in the Task 5 documentation rather than leaving a reader to wonder.

7. Tests: each page renders its default for a linked user (via
   `renderWithProviders`, whose `makeAuthUser` now takes link overrides),
   renders today's behaviour for an unlinked user, and — for at least
   `CalendarFeedPage` and `LeavePlanningPage` — lets the user change the
   selection away from the default and keeps it changed across a re-render.

## Task 5: Review and documentation

**A.** Tasks 1–4 are complete and the feature is live: users can be linked to a
doctor and/or a reception staff member from the Users page, the link is served
on `UserOut`, and four frontend surfaces read it. This step is review and
documentation only — no behaviour changes.

**B. Files and deliverables**

- `documentation/architecture.md` — the link itself.
- `documentation/architecture-reception.md` — the delete interaction.
- `documentation/user_staff_linking_plan.md` — deleted.

**C. Instructions**

1. In `architecture.md`, under the Authentication Boundary (this is shared auth
   infrastructure, not a rota domain), record: the two nullable uniquely-indexed
   FK columns and why they live on `users` (D1); that the link is manual (D2);
   that it is orthogonal to `access_level` and neither derives the other (D3);
   that it reaches the UI through `UserOut` and is read via `AuthContext`,
   with no `/me`-style endpoint anywhere (D5, D6); and D8 — reads remain open
   to every tier, as a reviewed decision, with a one-line note that per-person
   read scoping would be a large separate ticket.

2. Update the `Auth` row of the Tech Stack table, which currently describes
   `users`/`sessions` with no mention of staff identity.

3. In `architecture-reception.md`, note that a hard staff delete nulls
   `users.reception_staff_id` rather than purging the user, and that the
   FK-coverage tripwire now checks `PURGED_MODELS` plus `NULLED_TABLES` (D7).

4. Check the shipped code for citations of this plan file or of "Task N" —
   `architecture.md` forbids them, and delete-then-dangle is exactly the
   failure mode. Replace any with the reasoning itself.

5. Delete this file.
