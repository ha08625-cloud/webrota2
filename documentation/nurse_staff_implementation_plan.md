# Implementation plan: nurse staff administration for `nurse_rota` logins

## Plan

Give a `nurse_rota: write` login the ability to add, edit, deactivate and permanently
delete **nurse staff** — `Doctor` rows with `doctor_type == NURSE` — and nothing else.
Five new endpoints on `api/routers/nurse_rota.py`, a shared `_doctors.py` extraction so
the creation and purge invariants have one definition, a second page in the Nurse Rota
shell, and the confinement tests that make the partition real.

The provisional plan was reviewed against the code and is substantially correct. Its
claims were verified: `_AREA[module]` is resolved per router at `include_router` time so
one endpoint cannot serve two areas; `_require_nurse` exists and is reusable verbatim;
`GET /doctors` is one of the two `deps._SHARED_READ` entries and `NurseRotaGrid` does
read it through `useDoctors(false)`; `nurse_rota` is in `LOCKABLE_AREAS` and `main.py`
attaches `require_edit_lock` off the `_AREA` entry with no second table;
`_AREA_FOR_PREFIX` and `_PROFILES` in `test_authorization.py` already cover
`/nurse-rota`; `DoctorsPage` hides sessions/supervision/WFH for `Nurse`;
`clinic_types._reject_nurse_doctors` rejects nurses from clinic eligibility; the
`PURGED_MODELS` FK-coverage tripwire is `tests/test_api/test_doctors.py:337`.

What changed in review is in "Design decisions" below. The substantive corrections are
decision 4 (the widening is to `rota_admin`, not only to a nurse-only login), decision 6
(`DoctorUsageOut` is reused, `NurseUsageOut` is dropped), and the wiring checklist
(the authorization floors and `models/permissions.py`'s lock comment do need edits; the
provisional plan said neither did).

## Scope

In: `GET`/`POST` `/nurse-rota/nurses`, `PATCH`/`DELETE` `/nurse-rota/nurses/{id}`,
`GET /nurse-rota/nurses/{id}/usage`; the `_doctors.py` extraction; a `/nurse-rota/staff`
page with a nav on `NurseRotaShell`; `NurseRotaGrid` switched onto the section's own
nurse list.

Out: preferred rooms, calendar feed tokens, leave, counters, clinic eligibility.
None of them mean anything for a nurse and each would be a new hole to argue about.
`/doctors` remains the clinical rota administrator's full staff surface, nurses included,
and demoting an existing doctor *into* nurse-hood stays a `clinical: write` action there.

Not in scope and not implied: any change to `_SHARED_READ`, to the permission model, to
`DoctorIn`/`DoctorPatch`, or to `GET /nurse-rota/active`.

## Design decisions

**1. Three confinement rules, mirroring the two the session endpoints already have.**

- `POST` **sets `doctor_type = NURSE` itself**; it is not a payload field. A nurse-only
  login that could choose the type could mint a Partner and inject staff into the
  clinical rota and the generation engine.
- `PATCH` / `DELETE` / `GET {id}` resolve the target and **404 unless it is a nurse**,
  reusing `nurse_rota._require_nurse` verbatim. 404 rather than 403, for the reason the
  module already gives: for a non-nurse row this resource does not contain it, and a 403
  would confirm it exists.
- **`doctor_type` is absent from the PATCH schema**, so a nurse cannot be promoted out of
  the partition one request later.

On that third rule, precisely: **nothing in this codebase sets `extra="forbid"`** on a
Pydantic model, so a `doctor_type` key in a PATCH body is *silently ignored*, not
rejected. That is safe, and adding `extra="forbid"` here alone would be a one-model
deviation from a repo-wide convention. The consequence is for the test, not the code: the
confinement test asserts the row's `doctor_type` is **unchanged** after such a PATCH, not
that the request 422s (see Task 3).

**2. Editable fields, split by verb.** The provisional plan listed "code, active,
start_date, end_date" for both verbs; `active` belongs on one of them only, matching
`DoctorIn`/`DoctorPatch`:

- `NurseIn` (POST): `code`, `start_date`, `end_date`. No `active` — the router sets
  `active=True`, exactly as `create_doctor` does.
- `NursePatch` (PATCH): `code`, `active`, `start_date`, `end_date`, all optional.

New schemas rather than reuse of `DoctorIn`/`DoctorPatch`: those carry `doctor_type`,
which is rule 1's hole, and a field added to `DoctorPatch` later would silently widen the
nurse surface. `sessions_per_week`, `supervision_preference` and `wfh_preference` take
their model defaults — `DoctorsPage` already hides all three for nurses and they feed
engine mechanisms no nurse is ever considered by.

**3. Creation and deletion reuse `/doctors`' logic in a new `api/routers/_doctors.py`.**
Two invariants hang off doctor creation — one `SystemCounter` row per `SystemCounterType`
(`generate._write_counters` does a strict `.scalar_one()` and 500s the whole generation if
it is violated) and a unique `calendar_token` — and the delete has `PURGED_MODELS`, a
tuple asserted against the metadata so a future doctor-referencing table cannot be left
un-purged. A second copy of any of it is a second thing to update and a silent divergence
when somebody updates only one.

`_doctor_ids.py` and `_uploads.py` are the precedent for an underscore-prefixed shared
module inside `routers/`; the underscore is what keeps `main.py` from mistaking it for a
router.

**Correction to the provisional plan's extraction list: `_validate_window` moves too.**
It was omitted. `NurseIn`/`NursePatch` both carry `start_date`/`end_date`, and the PATCH
case needs the check run against the *merged* post-update values — which is precisely why
that helper lives in the router rather than in a schema validator. Duplicating it would
be a second copy of a rule that already had to be placed carefully once.

**4. `DELETE` requires `nurse_rota: write` and an already-inactive nurse — not
`user_admin`. State the cost accurately.** The provisional plan framed this as weakening
a rule for a nurse-only login. It is wider than that, and the wider statement is the one
that belongs in the docstring and the architecture note:

- `DELETE /doctors/{id}` and `DELETE /reception/staff/{id}` both carry
  `require_capability("user_admin")` on top of their area gate, so the effective rule is a
  conjunction. Both are in `_ALSO_NEEDS_USER_ADMIN` in `test_authorization.py`.
- Keeping that here would mean a nurse-only login cannot delete, which is the feature.
- **The login this actually widens is `rota_admin`.** That preset holds
  `clinical: write` + `nurse_rota: write` + `user_admin: false`. Today it can permanently
  purge nobody. After this change it can permanently purge any nurse, through the nurse
  router, while still being refused on `DELETE /doctors/{id}` for the same row. A
  nurse-only login is the *narrower* new caller, not the only one.
- **The purge is genuinely destructive for a nurse.** Phase 2 builds grid slots for nurse
  rows like anyone else's and `generate.py` persists them, so a nurse accumulates
  `rota_sessions` rows in committed rotas; purging one rewrites a rota that was printed
  and handed out. And nothing rejects a nurse from `/leave`, `/duty` or `/extra-sessions`
  — those routers have no `doctor_type` check at all — so a nurse's footprint is thinner
  than a partner's but it is not structurally empty.
- The mitigations are the ones `/doctors` already relies on and they stay: **409 unless
  the nurse is already inactive** (a deliberate two-step, and unlike a has-history guard
  it never makes a nurse who has actually worked permanently undeletable), a **usage
  endpoint feeding a confirm dialog** that states what will be destroyed, and the **audit
  log**, which records who deleted which id after the rows are gone.

This makes `DELETE /nurse-rota/nurses/{id}` the first permanent staff purge in the API
that is not in `_ALSO_NEEDS_USER_ADMIN`. That tuple's comment currently reads "the two
permanent staff purges, which are deliberately the same shape as each other"; it is
rewritten to say there are now three and why one differs.

**5. Staff writes stay behind the nurse rota edit lock.** `nurse_rota` is in
`LOCKABLE_AREAS`, and `main.py` adds `require_edit_lock` off the area already recorded in
`_AREA` — deliberately, so a new router in a lockable section cannot be permission-gated
but lock-free. Adding a nurse therefore requires holding the Nurse Rota lock. Accepted: it
falls out with no code, it matches reception staff CRUD sitting behind the reception lock,
and the alternative is a per-endpoint escape hatch `main.py` is designed not to have.
Reads are unaffected — `require_edit_lock` only covers unsafe methods.

**6. One nurse list, from `GET /nurse-rota/nurses` — and `NurseRotaGrid` switches to it.**
The grid's rows come from `useDoctors(false)` today, which works only because
`GET /doctors` is one of the two entries in `deps._SHARED_READ` — a named, deliberate hole
in default-deny that exists for `UserFormDialog`'s linked-doctor picker, not for this
section. With CRUD arriving the section needs its own list anyway (a create must
invalidate a key the grid reads), and two endpoints both answering "who are the nurses?"
would drift. `_SHARED_READ` is untouched: `/doctors` still serves the clinical page and
the user-admin pickers.

**`GET /nurse-rota/nurses/{id}/usage` returns `DoctorUsageOut`, reused verbatim — no
`NurseUsageOut`.** The provisional plan proposed a new schema. Two reasons not to. First,
`DoctorUsageOut` is eight plain integers; it carries no `code`, no `doctor_type` and
nothing else about the row, so reusing it widens the nurse surface by nothing. Second, the
obvious trim — dropping `leave_entries`, `duty_assignments`, `extra_sessions` and
`blocked_entries` as structurally zero for a nurse — is **wrong**: none of those routers
has a `doctor_type` check, so a clinical administrator can and may record any of them
against a nurse. A confirm dialog that silently omits a count that turns out to be
non-zero is worse than one that shows four zeroes.

**7. `GET /nurse-rota/active` is not changed.** It keeps returning sessions, rooms and
occupancy. The nurse list is a separate call with a separate cache lifetime — the staff
page needs it without the grid payload, and the grid re-reads it after a create. The cost
is that the rota page now makes two fetches instead of one; it must not render the grid
until both resolve.

**8. The code-collision 409 (the provisional plan's open question), resolved.**
`doctors.code` is unique over the whole table, so a nurse-only login creating a nurse with
a code a doctor already holds gets a 409. There is nothing to conceal: `GET /doctors` is
shared-read for *every* authenticated login, so the same caller can already list every
doctor code, and the response echoes only the code the caller themselves supplied. The
problem is wording, not disclosure — "Doctor code 'AB' already exists" is the wrong noun
in a section whose users do not think of themselves as administering doctors. The nurse
endpoints raise `f"Staff code '{code}' is already in use"` instead. No behaviour change,
no new concealment, and `/doctors`' own message is untouched.

**9. Frontend clones, not generalisations.** `DoctorFormDialog` (428 lines) and
`DeleteDoctorDialog` (159) live in the shared `src/components/` tree and are built around
the full doctor shape — type select, preference selects, preferred-rooms list, sessions
stepper. Conditioning all of it away for nurses would mean editing live clinical
components for a rule that belongs to this section, and `architecture.md` puts a section's
own components in `src/features/<section>/`. The models to copy are
`ReceptionStaffPage` (185), `ReceptionStaffFormDialog` (116) and
`DeleteReceptionStaffDialog` (144), which are already the right size and shape. This is
the fourth clone-not-generalise call in the repo and is recorded as one.

One difference from `ReceptionStaffPage` that must not be copied by reflex: it gates its
Delete button on `useCanAdminUsers()`. The nurse staff page gates Delete on **write
only**, per decision 4. Copying the `useCanAdminUsers` line would silently disable the
feature for the login it exists for.

## Task 1: Backend — extract `api/routers/_doctors.py`

**A. State of the world.** Nothing has been done yet. `api/routers/doctors.py` (516
lines) holds the doctor creation invariants and the purge inline. This task moves them to
a shared module with no behaviour change, so Task 2 can call them rather than restate
them.

**B. Files and deliverables.**

- New: `backend/app/api/routers/_doctors.py`
- Edit: `backend/app/api/routers/doctors.py`
- Edit: `backend/tests/test_api/test_doctors.py` (one import line and one message)
- Edit: `backend/pyproject.toml` (one line)

**C. Instructions.**

1. Create `backend/app/api/routers/_doctors.py`. Move into it, unchanged:
   - `PURGED_MODELS` and `NULLED_TABLES`, with their existing comments.
   - `_validate_window` (rename to `validate_window` — it is now a cross-module helper,
     not a module-private one).
   - A new `create_doctor_row(db, *, code, doctor_type, active=True, start_date=None,
     end_date=None, **model_defaults) -> Doctor`. It builds the `Doctor`, sets
     `calendar_token=new_session_token()`, `db.flush()`es to assign the id, seeds one
     `SystemCounter` per `SystemCounterType`, and **lets `IntegrityError` propagate** —
     the caller decides the 409 wording (decision 8), so this helper must not raise
     `HTTPException` itself. Carry over the comment explaining why the flush precedes the
     counter rows.
   - A new `purge_doctor(db, doctor) -> dict[str, int]`. It nulls `users.doctor_id`, loops
     `PURGED_MODELS` collecting rowcounts, `db.delete(doctor)`s and returns the counts
     dict. It does **not** commit, does **not** check `active`, and does **not** raise:
     the 409-unless-inactive guard stays in each router's endpoint, because the message
     differs ("Doctor 'AB' is active" vs the nurse wording) and it is a policy decision
     each surface makes for itself.
   - The module docstring carries the counter invariant, calendar-token invariant and
     `PURGED_MODELS`/`NULLED_TABLES` paragraphs across from `doctors.py`'s docstring,
     since that is where a reader will now look for them. Leave a one-line pointer in
     `doctors.py`'s docstring rather than deleting the prose outright — it still owns the
     *policy* (why DELETE means delete, the two guards); `_doctors.py` owns the mechanics.
2. Rewrite `create_doctor` and `delete_doctor` in `doctors.py` to call the two helpers.
   `create_doctor` keeps its own `try/except IntegrityError` and its existing
   `f"Doctor code '{payload.code}' already exists"` message. `delete_doctor` keeps its
   `active` check, its docstring and its `DoctorDeleteOut(deleted=counts)` return.
   Replace `_validate_window` calls with `validate_window`.
3. `test_doctors.py:6` imports `NULLED_TABLES, PURGED_MODELS` from
   `app.api.routers.doctors`. Change it to import from `app.api.routers._doctors`, and
   update the failure message at ~line 341 to name `app/api/routers/_doctors.py`. **Do
   not add a re-export to `doctors.py` to avoid this edit** — after the extraction
   `doctors.py` has no use for either name, so a re-export would be a dead import kept
   alive only to preserve a test's import path, and it would rot.
4. `backend/pyproject.toml`: add `"app.api.routers._doctors",` to contract 2's
   `source_modules`, immediately after `"app.api.routers._doctor_ids",` (line ~188).
   **This is the only import-linter edit needed** — verified: the other contracts ban
   clinical *models and schemas* longhand and the shared-kernel contract bans
   `app.api.routers` wholesale, so no mutual-ban lists mention individual clinical
   routers.
5. No behaviour change. `uv run pytest tests/test_api/test_doctors.py` and
   `uv run lint-imports` both pass, and no other test file is touched.

## Task 2: Backend — nurse staff endpoints

**A. State of the world.** Task 1 is complete: `_doctors.py` holds `PURGED_MODELS`,
`NULLED_TABLES`, `validate_window`, `create_doctor_row` and `purge_doctor`, and
`doctors.py` calls them. This task adds the five endpoints. Tests are Task 3.

**B. Files and deliverables.**

- Edit: `backend/app/api/schemas/nurse_rota.py` — `NurseIn`, `NursePatch`
- Edit: `backend/app/api/schemas/__init__.py` — export them
- Edit: `backend/app/api/routers/nurse_rota.py` — five endpoints
- Edit: `backend/app/api/audit_descriptions.py` — three entries

**C. Instructions.**

1. Schemas, in `api/schemas/nurse_rota.py` (not `doctor.py` — they are this section's
   wire types). Per decision 2:
   - `NurseIn`: `code: str = Field(min_length=1)`, `start_date: date | None = None`,
     `end_date: date | None = None`.
   - `NursePatch`: all four of `code` (`min_length=1`), `active: bool | None`,
     `start_date`, `end_date`, each defaulting to `None`.
   - A docstring on each saying why `doctor_type` and `sessions_per_week` are absent, and
     that a stray `doctor_type` key is ignored rather than rejected (decision 1).
   - Reuse `DoctorOut` for responses. It is already this section's shape — the grid
     reads `doctor_type` off it — and it exposes no `calendar_token`.
2. Endpoints in `api/routers/nurse_rota.py`, under a new "Nurse staff" heading comment
   below the session endpoints. All five reuse the existing `_require_nurse`.
   - `GET /nurse-rota/nurses?include_inactive=false` → `list[DoctorOut]`, filtered to
     `doctor_type == NURSE`, ordered by `code`. The flag matches
     `GET /reception/staff`'s, and for the same reason: this is the section's only
     management surface, so a deactivation needs a visible way back.
   - `POST /nurse-rota/nurses` → `DoctorOut`, 201. `validate_window`, then
     `create_doctor_row(db, code=..., doctor_type=DoctorType.NURSE, start_date=...,
     end_date=...)` inside a `try/except IntegrityError` raising 409 with the decision-8
     wording. `db.commit()`, `db.refresh()`.
   - `GET /nurse-rota/nurses/{doctor_id}` → `DoctorOut`, via `_require_nurse`.
   - `PATCH /nurse-rota/nurses/{doctor_id}` → `DoctorOut`. `_require_nurse`, then
     `payload.model_dump(exclude_unset=True)`, then `validate_window` against the merged
     values exactly as `patch_doctor` does, then `setattr` each field, then commit inside
     `try/except IntegrityError` with the same 409 wording.
   - `GET /nurse-rota/nurses/{doctor_id}/usage` → `DoctorUsageOut`. `_require_nurse`,
     then the same eight counts `doctor_usage` computes. Extract that body into a
     `doctor_usage_counts(db, doctor) -> DoctorUsageOut` helper in `_doctors.py` and have
     both routers call it, rather than copying the aggregate query — same argument as the
     purge.
   - `DELETE /nurse-rota/nurses/{doctor_id}` → `DoctorDeleteOut`. `_require_nurse`, then
     409 if `nurse.active` (`f"Nurse '{nurse.code}' is active -- deactivate before
     deleting"`), then `purge_doctor`, then commit. **No `require_capability("user_admin")`
     dependency** — that is decision 4 and the docstring must say so, naming `rota_admin`
     as the login this widens and pointing at the three mitigations.
3. `audit_descriptions.py`, in the existing "Nurse rota" block, keeping it alphabetical
   within the group: `("POST", "/nurse-rota/nurses")` → "Added a nurse";
   `("PATCH", "/nurse-rota/nurses/{doctor_id}")` → "Changed a nurse's details";
   `("DELETE", "/nurse-rota/nurses/{doctor_id}")` → "Permanently deleted a nurse".
   The two GETs need no entry. Missing any of the three fails
   `test_audit_descriptions.py` by name.
4. Extend the router's module docstring: it currently says the partition is over
   `master_rota_sessions`. It is now over `doctors` as well, and the same three rules do
   the confining.
5. Run `uv run pytest tests/test_api/test_audit_descriptions.py
   tests/test_api/test_authorization.py` — the latter picks the new routes up with no
   edit to `_AREA_FOR_PREFIX` or `_PROFILES`.

## Task 3: Backend — the confinement tests

**A. State of the world.** Tasks 1 and 2 are complete: `_doctors.py` is extracted and the
five nurse staff endpoints are live and audited. This task is the deliverable that makes
the boundary real rather than incidental.

**B. Files and deliverables.**

- New: `backend/tests/test_api/test_nurse_staff.py`
- Edit: `backend/tests/test_api/test_authorization.py` —
  `_ALSO_NEEDS_USER_ADMIN`'s comment, and the two floor tuples plus their comments

**C. Instructions.**

1. `test_nurse_staff.py`, using a client authenticated with `preset(NURSE_ROTA_PRESET)`
   (the fixtures in `test_authorization.py` show the shape). Assert:
   - `POST` with a `doctor_type` key in the body creates a **Nurse** — the key is ignored
     (decision 1), and this is the test that pins that. Assert on the created row's
     `doctor_type`, not on a status code.
   - `PATCH` with `{"doctor_type": "Partner"}` returns 200 and leaves `doctor_type`
     unchanged. Same reason. **Do not assert 422**: no model in this codebase sets
     `extra="forbid"`.
   - `PATCH` and `DELETE` and `GET {id}` against a **Partner's** id all return **404**,
     not 403.
   - `GET /nurse-rota/nurses` contains no non-nurse row, with at least one non-nurse in
     the fixture.
   - `DELETE` on an **active** nurse returns 409; on an inactive one it returns 200 and
     the row and its `master_rota_sessions` are gone.
   - A `nurse_rota`-only client gets 403 on every `/doctors` write and on
     `GET /doctors/{id}` — while `GET /doctors` itself still succeeds, because it is in
     `_SHARED_READ`. Assert that asymmetry explicitly; it is surprising and it is
     deliberate.
   - A `clinical`-write-only client (`nurse_rota: none`) gets 403 on every
     `/nurse-rota/nurses` route, and is unaffected on `/doctors`.
   - Creating a nurse whose code collides with an existing doctor's returns 409 with the
     decision-8 wording.
   - Creating a nurse seeds one `SystemCounter` per `SystemCounterType` and a non-null
     unique `calendar_token` — the invariant `generate._write_counters` 500s on. Assert it
     here as well as in `test_doctors.py`: the point of Task 1 is that both paths share
     one implementation, and this is what would catch a future divergence.
2. `test_authorization.py`:
   - Rewrite `_ALSO_NEEDS_USER_ADMIN`'s comment. It says "the two permanent staff purges,
     which are deliberately the same shape as each other". There are now three purges and
     one is deliberately *not* here; say which, and why (decision 4).
   - **Bump `_NON_GET_FLOORS["nurse_rota"]` and `_GET_FLOORS["nurse_rota"]` and rewrite
     their comments.** The provisional plan said no edit was needed. Strictly the tests
     still pass — the tuples are floors — but both comments enumerate exactly which routes
     make up the number ("The three /nurse-rota writes, plus the ungated /locks pair";
     "GET /nurse-rota/active, plus the two _SHARED_READ pickers and the three ungated
     reads"), and leaving them stale turns a tripwire into decoration. Recompute both
     numbers from the actual sweep and rewrite the comments to match. Check the other
     profiles' *blocked* floors while you are there: they only rise.

## Task 4: Frontend — nav and the nurse staff page

**A. State of the world.** The backend is complete and tested: five endpoints under
`/nurse-rota/nurses`, confined to nurse rows, behind `nurse_rota` and the nurse rota edit
lock. The section has one page today and `NurseRotaShell` has no nav.

**B. Files and deliverables.**

- Edit: `frontend/src/App.tsx` — a nav on `NurseRotaShell`, a `staff` route
- Edit: `frontend/src/features/nurseRota/api.ts` — list/create/patch/delete hooks
- Edit: `frontend/src/features/nurseRota/types.ts` — the wire types
- New: `frontend/src/features/nurseRota/NurseStaffPage.tsx` (+ test)
- New: `frontend/src/features/nurseRota/NurseFormDialog.tsx` (+ test)
- New: `frontend/src/features/nurseRota/DeleteNurseDialog.tsx` (+ test)

**C. Instructions.**

1. `NurseRotaShell` gains the two-column nav layout `ReceptionShell` uses (`w-48`
   sidebar, `NavLink` list). Two items: "Rota" (index, `end`) and "Staff"
   (`/nurse-rota/staff`). Add the `staff` route inside the existing
   `PermissionAreaProvider`; the catch-all `Navigate` stays last. `EditLockBanner` and
   `EditLockDialog` stay where they are, above the split — the lock covers the whole
   section, staff writes included (decision 5).
2. `api.ts`: extend `nurseRotaKeys` with `nurses: (includeInactive: boolean) => [...]`.
   Add `useNurses(includeInactive)`, `useCreateNurse`, `useUpdateNurse`, `useDeleteNurse`.
   Follow the file's existing convention where it applies, but note these are **not**
   splice-in-place writes like the session hooks: they invalidate. Specifically —
   - create / patch → invalidate `nurseRotaKeys.nurses(...)` (both flag variants; key off
     `nurseRotaKeys.all` if that is simpler).
   - **delete → invalidate `nurseRotaKeys.active()` as well.** `MasterRotaSession` is in
     `PURGED_MODELS`, so purging a nurse deletes their template rows and the grid's
     cached `/active` payload is stale the moment the purge returns. The provisional plan
     missed this; a staff page that leaves ghost rows on the rota grid is the visible bug.
3. `NurseStaffPage`: modelled on `ReceptionStaffPage`. Always fetches with
   `include_inactive=true`; Active and Inactive sections; Add / Edit / Deactivate /
   Delete. Deactivate is `PATCH {active: false}` behind a `window.confirm`, matching that
   page. **Delete is gated on write only, not on `useCanAdminUsers()`** (decision 9) —
   copying that line from `ReceptionStaffPage` would disable the feature for exactly the
   login it exists for. Everything writable goes through `useWriteGate`.
4. `NurseFormDialog`: code, start date, end date. No type select, no preference selects,
   no sessions stepper, no preferred-rooms editor. Surface the 409 `detail` verbatim — it
   is the decision-8 message and it is written to be read.
5. `DeleteNurseDialog`: modelled on `DeleteReceptionStaffDialog`. Reads
   `GET /nurse-rota/nurses/{id}/usage` and states what will be destroyed before asking,
   including the zeroes (decision 6).
6. No new permission plumbing: `nurse_rota` is already in `permissionPresets.ts`,
   `userSchema.ts`, `AuthContext.tsx` and `api/types.ts`.
7. Run `npm run test -- src/features/nurseRota` and `npx tsc --noEmit`.

## Task 5: Frontend — switch `NurseRotaGrid` onto the section's nurse list

**A. State of the world.** Tasks 1–4 are complete and the staff page is live.
`NurseRotaGrid` still gets its rows from `useDoctors(false)` — i.e. through the
`deps._SHARED_READ` hole, which exists for `UserFormDialog`'s picker and not for this
section. This task is the last dependency to remove.

**B. Files and deliverables.**

- Edit: `frontend/src/features/nurseRota/NurseRotaGrid.tsx`
- Edit: `frontend/src/features/nurseRota/NurseRotaGrid.test.tsx`
- Edit: `frontend/src/features/nurseRota/NurseRotaPage.tsx` if the loading state moves up

**C. Instructions.**

1. Replace `useDoctors(false)` + the client-side `doctor_type === "Nurse"` filter with
   `useNurses(true)`. `include_inactive=true` preserves today's rule exactly: an active
   nurse with zero sessions still gets a row, and an inactive nurse who still holds
   sessions is badged rather than silently dropped.
2. The page now makes two fetches (`/active` and `/nurses`). Do not render the grid until
   both have resolved — a grid rendered against an empty nurse list drops every row for a
   frame. Handle it wherever `doctorsLoading` is handled today.
3. Remove the `@/api/doctors` and `Doctor` imports from the file. Update the
   component's docstring: rows no longer come from `/doctors`, and the reason they no
   longer do (default-deny, not convenience) is worth the sentence.
4. Update the tests' mocks and the shell test if the nav changed what it renders.
5. **`deps._SHARED_READ` is not touched.** `/doctors` still serves the clinical page and
   the two user-admin pickers, and shrinking it is a separate decision with its own
   argument.

## Task 6: Review and documentation

**A. State of the world.** Tasks 1–5 are complete and the feature is live. This step is
review and documentation only; no behaviour changes.

**B. Files and deliverables.**

- Edit: `documentation/architecture.md`
- Edit: `documentation/architecture-clinical.md`
- Edit: `backend/app/models/permissions.py` (a comment)
- Edit: `documentation/planned_updates.md`
- Delete: `documentation/nurse_staff_implementation_plan.md`

**C. Instructions.**

1. `architecture.md`, "A permission area is not always a module, and it is not always a
   table": it currently says "**two permission areas now write to the same table**,
   `master_rota_sessions`". That is now two tables — `master_rota_sessions` and `doctors`
   — partitioned by the same `Doctor.doctor_type` predicate, with the same warning: the
   gate buys a separate lock, not a separate dataset. Add the third confinement rule
   (`doctor_type` is set by the server on POST and absent from the PATCH schema), and add
   the `_ALSO_NEEDS_USER_ADMIN` exception with decision 4's `rota_admin` framing — that is
   the part a future reader is most likely to trip over.
2. `architecture.md`, the "What these contracts do not catch" bullet on clinical routers
   being listed longhand: `_doctors.py` is the case that proves it, and a one-clause
   mention costs nothing.
3. **`backend/app/models/permissions.py`, the `LOCKABLE_AREAS` comment.** It says
   `nurse_rota` "is the first case of two locks over ONE table" and names
   `master_rota_sessions`. Same widening as item 1 — the nurse lock now also covers writes
   to `doctors`. The provisional plan missed this file; it is the one place the lock
   argument is written down in the code.
4. `architecture-clinical.md`, "Nurse Rota": a new subsection for the staff surface —
   what a `nurse_rota` login may and may not do to a `Doctor` row, why the delete drops
   `user_admin` and who that widens it to, why `DoctorUsageOut` is reused rather than
   trimmed, and why `NurseRotaGrid` stopped reading `/doctors`. Update the `/nurse-rota`
   row in the API table at line ~289 to mention nurse staff CRUD.
5. `planned_updates.md`: remove the "nurse edit only users can add or remove nurse staff
   only" bullet (line 1).
6. Delete this file.
