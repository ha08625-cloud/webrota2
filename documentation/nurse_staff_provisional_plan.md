# Provisional plan: nurse staff administration for `nurse_rota` logins

## Scope

A `nurse_rota: write` login can **add, edit, deactivate and delete nurse staff** — and
nothing else. "Nurse staff" is a `Doctor` row with `doctor_type == NURSE`; there is no
new table. Reaching a non-nurse row through these endpoints must be impossible, not
merely hidden.

Out of scope: preferred rooms, calendar feed tokens, leave, counters, clinic
eligibility. None of them mean anything for a nurse (nurses are inert to the engine,
have no leave entitlement and are rejected from clinic eligibility by
`clinic_types._reject_nurse_doctors`), and each would be a new hole to argue about.
`/doctors` remains the clinical rota administrator's full staff surface, nurses
included.

## The shape this has to take, and why

`main.py` resolves `_AREA[module]` **per router at `include_router` time**, so one
endpoint cannot serve two permission areas. `/doctors` is `clinical`, permanently. The
only way to give a nurse-only login a write is a route on a router registered under
`nurse_rota` — so this is four or five new endpoints on `api/routers/nurse_rota.py`,
not a per-endpoint relaxation of `/doctors`.

That makes this **the second instance of the pattern `architecture.md` already
documents**: two permission areas over one table, partitioned by `Doctor.doctor_type`
rather than by table or module. The session endpoints did it for
`master_rota_sessions`; this does it for `doctors`. The same warning applies verbatim:
*the gate buys a separate lock, not a separate dataset*. What confines the login are
the router's own rules, and nothing structural.

## Design decisions

**1. Three confinement rules, mirroring the two the session endpoints already have.**

- `POST` **sets `doctor_type = NURSE` itself** — it is not a payload field. A nurse-only
  login that could choose the type could mint a Partner and inject staff into the
  clinical rota and the generation engine.
- `PATCH`/`DELETE`/`GET {id}` resolve the target and **404 unless it is a nurse**, reusing
  the existing `_require_nurse` helper verbatim. 404 rather than 403, for the reason
  already given in that module: for a non-nurse row this resource does not contain it,
  and a 403 would confirm that it exists.
- **`doctor_type` is absent from the PATCH schema**, so a nurse cannot be promoted out of
  the partition afterwards. This is the same hole as the first rule, one request later,
  and it is easy to miss.

Demoting a doctor *into* nurse-hood stays a `clinical: write` action on `/doctors`, as
today. The asymmetry is deliberate and matches the session endpoints: `clinical: write`
is the superset, `nurse_rota` the narrower grant.

**2. Editable fields are `code`, `active`, `start_date`, `end_date`. Nothing else.**
New `NurseIn` / `NursePatch` schemas, not `DoctorIn` / `DoctorPatch` — reusing those
would carry `doctor_type` in by default, which is exactly rule 1's hole, and a field
added to `DoctorPatch` later would silently widen the nurse surface.
`sessions_per_week`, `supervision_preference` and `wfh_preference` take their model
defaults: `DoctorsPage` already hides all three for nurses, and they feed engine
mechanisms no nurse is ever considered by.

**3. Creation and deletion reuse `/doctors`' logic; they do not restate it.**
Two invariants hang off doctor creation — one `SystemCounter` row per
`SystemCounterType` (`generate._write_counters` does a strict `.scalar_one()` and 500s
the whole generation if it is violated) and a unique `calendar_token` — and the delete
has `PURGED_MODELS`, a tuple asserted against the metadata by
`tests/test_api/test_doctors.py` so that a future doctor-referencing table cannot be
left un-purged. A second copy of any of that is a second thing to update and a silent
divergence when somebody updates only one.

So: extract `create_doctor_row(db, ...)` and `purge_doctor(db, doctor)` into
**`api/routers/_doctors.py`**, and have both routers call them. `_doctor_ids.py` and
`_uploads.py` are the existing precedent for an underscore-prefixed shared module
inside `routers/` (the underscore is what keeps `main.py` from mistaking it for a
router). `PURGED_MODELS`, `NULLED_TABLES` and the counter/token seeding move there;
`doctors.py` re-exports or imports them so the existing tripwire test keeps pointing at
one definition.

**4. DELETE requires `nurse_rota: write` and an already-inactive nurse — not
`user_admin`.** This is the one place the plan deliberately weakens an existing rule,
and it should be recorded as such rather than discovered later:

- `DELETE /doctors/{id}` carries `require_capability("user_admin")` on top of its area
  gate, on the argument that an irreversible, history-destroying purge should be the
  narrower permission. `DELETE /reception/staff/{id}` does the same. Both are in
  `_ALSO_NEEDS_USER_ADMIN` in `test_authorization.py`.
- Keeping that here would mean a nurse-only login cannot delete, which is the feature.
- **The purge is genuinely destructive for a nurse too.** Phase 2 builds grid slots for
  nurse rows like anyone else's and `generate.py` persists them, so a nurse accumulates
  `rota_sessions` rows in committed rotas; purging one rewrites a rota that was printed
  and handed out. Nurses have no leave entitlement, no duty and no clinic eligibility,
  so their footprint is thinner than a partner's — but it is not empty, and this plan
  should not pretend it is.
- The mitigations are the ones `/doctors` already relies on and they stay: **409 unless
  the nurse is already inactive** (deliberate two-step, and unlike a has-history guard
  it never makes a nurse who has actually worked permanently undeletable), a **usage
  endpoint feeding a confirm dialog** that states what will be destroyed, and the
  **audit log**, which records who deleted which id after the rows are gone.

This makes `DELETE /nurse-rota/nurses/{id}` the first permanent staff purge in the API
that is *not* in `_ALSO_NEEDS_USER_ADMIN`. That tuple's comment currently reads "the
two permanent staff purges, which are deliberately the same shape as each other" — it
has to be rewritten to say that there are now three, and why one of them differs.

**5. Staff writes stay behind the nurse rota edit lock.** `nurse_rota` is in
`LOCKABLE_AREAS`, and `main.py` adds `require_edit_lock` off the area already recorded
in `_AREA` — deliberately, so that a new router in a lockable section cannot be
permission-gated but lock-free. Adding a nurse will therefore require holding the Nurse
Rota lock. Accepted: it falls out with no code, it matches reception staff CRUD sitting
behind the reception lock, and the alternative is a per-endpoint escape hatch `main.py`
is designed not to have.

**6. One nurse list, from `/nurse-rota/nurses` — and `NurseRotaGrid` switches to it.**
The grid's rows currently come from `useDoctors(false)`, which works only because
`GET /doctors` is one of the two entries in `deps._SHARED_READ` — a named, deliberate
hole in default-deny that exists for `UserFormDialog`'s linked-doctor picker, not for
this section. With CRUD arriving, the section needs its own list anyway (a create must
invalidate a key the grid reads), and two endpoints both answering "who are the
nurses?" would drift. So `GET /nurse-rota/nurses?include_inactive=` becomes the
section's list, both surfaces read it under `nurseRotaKeys`, and the section stops
depending on the shared-read hole for its primary data. `_SHARED_READ` is untouched —
`/doctors` still serves the clinical page and the user-admin pickers.

**7. `GET /nurse-rota/active` is not changed.** It keeps returning sessions, rooms and
occupancy. The nurse list is a separate call with a separate cache lifetime — the staff
page needs it without the grid payload, and the grid re-reads it after a create.

## Frontend

A second page in the section: `/nurse-rota/staff`, with a small nav added to
`NurseRotaShell` (which has none today, being a one-page shell — `ReceptionShell` is the
precedent for adding one). `features/nurseRota/NurseStaffPage.tsx` plus a form dialog
and a delete dialog, modelled on `ReceptionStaffPage` rather than on `DoctorsPage`:
active/inactive sections, Add / Edit / Deactivate / Delete, no sessions-per-week
steppers, no preference selects, no preferred-rooms editor.

`DoctorFormDialog` and `DeleteDoctorDialog` are **not** reused. Both live in the shared
`src/components/` tree and are built around the full doctor shape (type select,
preference selects, preferred-rooms list, sessions stepper); conditioning all of it away
for nurses would mean editing live clinical components for a rule that belongs to this
section, and `architecture.md` puts a section's own components in
`src/features/<section>/`. This is the fourth clone-not-generalise call in the repo and
should be recorded as one.

Everything the new page writes is gated by the existing `useWriteGate` / `useCanWrite`
helpers and the edit-lock banner already on the shell — no new permission plumbing on
the frontend, since `nurse_rota` is already in `permissionPresets.ts`, `userSchema.ts`,
`AuthContext.tsx` and `api/types.ts`.

## Wiring checklist (the parts that fail loudly, and the parts that fail silently)

- `audit_descriptions.py` — one sentence per new non-GET route, or
  `test_audit_descriptions.py` fails naming the missing keys. **Fails loudly.**
- `test_authorization.py` — `_AREA_FOR_PREFIX` already maps `/nurse-rota`, and the
  `nurse_rota` profile is already in `_PROFILES`, so the sweeps pick the new routes up
  with no edit. The edit needed is to `_ALSO_NEEDS_USER_ADMIN`'s comment, per decision 4.
- No permission-model change: no new area key, no preset edit, no migration. This
  feature is entirely inside the existing `nurse_rota` area.
- No import-linter change: `nurse_rota.py` and `_doctors.py` are both flat modules in
  the clinical tree, already covered by contract 2's longhand list. Worth confirming
  `_doctors.py` is added to that list — a new flat clinical module is exactly the case
  `architecture.md` warns is not covered until hand-added.

## Provisional task breakdown

1. **Backend: extract `_doctors.py`.** Move `PURGED_MODELS`, `NULLED_TABLES`, the
   counter/token creation and the purge out of `doctors.py`; `doctors.py` calls them.
   No behaviour change, existing `test_doctors.py` unchanged and passing.
2. **Backend: nurse staff endpoints.** `NurseIn`/`NursePatch`/`NurseUsageOut` schemas,
   `GET`/`POST` `/nurse-rota/nurses`, `PATCH`/`DELETE` `/nurse-rota/nurses/{id}`,
   `GET /nurse-rota/nurses/{id}/usage`. Audit descriptions.
3. **Backend: the confinement tests.** A `nurse_rota`-only client cannot create a
   non-nurse, cannot PATCH or DELETE a non-nurse (404), cannot promote a nurse, and
   cannot reach `/doctors` at all; a clinical login is unaffected. These are the tests
   that make the boundary real, and they are the deliverable of this task.
4. **Frontend: nav + staff page.** `NurseRotaShell` nav, `NurseStaffPage`, its form and
   delete dialogs, the section's list hook.
5. **Frontend: switch `NurseRotaGrid` to the section's nurse list** and invalidate it on
   create/patch/delete.
6. **Review and documentation.** Update `architecture.md` ("A permission area is not
   always a module" — now two tables partitioned by `doctor_type`, and the
   `_ALSO_NEEDS_USER_ADMIN` exception), `architecture-clinical.md`'s "Nurse Rota"
   section, remove the `planned_updates.md` bullet, delete the implementation plan.

## Open question for the implementation-plan pass

**Nurse code uniqueness leaks across the partition.** `doctors.code` is unique over the
whole table, so a nurse-only login creating a nurse with a code a doctor already holds
gets a 409 that reveals that doctor's code exists. `GET /doctors` is already shared-read
so nothing is *newly* leaked, but the error wording should be checked rather than
inherited from `doctors.py` verbatim.
