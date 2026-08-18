# Plan — Permanently delete reception staff (as well as deactivate)

Implementation plan. Expanded from the provisional plan after review against
the code; every claim below was checked against the files it names. Three
tasks, each self-contained enough to be a single chat. Task 3 deletes this
file.

## Scope

Reception only. Adds a permanent-delete path for `reception_staff` alongside
the existing deactivate, and separates the two verbs, which currently do the
same thing. Nothing in the clinical rota is touched — `doctors.py` keeps its
soft-delete-with-409 shape, and the divergence is deliberate (Design
Decision 2).

Out of scope: bulk delete, an undo/restore path, and any change to how leave,
the master template or generation behave for staff who remain.

## State of the world (verified)

- `ReceptionStaff` is `id`/`code`/`name`/`active` and nothing else
  (`backend/app/models/reception.py:98`).
- `DELETE /reception/staff/{id}` is an unconditional soft delete — it sets
  `active = False`, exactly what `PATCH {"active": false}` does
  (`backend/app/api/routers/reception_staff.py:88` vs `:66`). Two endpoints,
  one behaviour.
- Exactly three tables carry a plain (non-cascading) FK to
  `reception_staff`: `reception_master_sessions`, `reception_rota_sessions`,
  `reception_leave_entries` (`models/reception.py:129`, `:211`, `:249`).
  Nothing else references staff, by FK or by a bare `staff_id` column;
  reception counters are derived at read time from `reception_rota_sessions`
  (`app/reception_counters.py`) and have no stored table, and there is no
  engine.
- `MANAGER` is tier 2 and `ADMIN` tier 1 (`app/api/deps.py:82`), so
  `require_manager` genuinely narrows rather than widens. It is currently
  used by `routers/users.py` and `routers/audit.py`.
- `ReceptionStaffPage` already loads inactive staff (`useReceptionStaff(true)`,
  `routes/ReceptionStaffPage.tsx:19`) and offers Reactivate, so the
  deactivate half of the requirement already works.
- Every non-GET request is audited automatically by the ASGI middleware
  (`app/api/audit.py`) — method, templated route, path params, status.
- `apiClient.delete` parses a JSON response body; only 204 is special-cased
  (`frontend/src/api/client.ts:107`), so returning 200 with a body needs no
  client change.

## Design Decisions

1. **Delete purges history; it does not refuse to run.** A hard delete
   removes the staff member's rows from every already-generated day, so a day
   rota printed last March will no longer match what the app shows, and the
   counters window loses that person entirely (`compute_role_counters`
   currently shows deactivated staff, `app/reception_counters.py:173` — a
   deleted one simply is not there). There is no way around this:
   `reception_rota_sessions.staff_id` is non-nullable, and an orphaned row
   with no name attached is worse than no row. The considered alternative —
   block deletion for anyone with generated-day rows — was rejected because
   anyone who has actually worked a day would then be undeletable, which is
   precisely the retiring-staff case the feature exists for. The mitigations
   are informed consent in the UI (Design Decision 7 and the confirm dialog)
   and the audit log, which records who deleted which staff id even though
   the rows themselves are gone.

2. **`DELETE` means delete; deactivate is `PATCH {"active": false}`.** The
   frontend already reactivates via PATCH, so the pair is symmetric after
   this change and the duplicate endpoint goes away. This diverges from
   `routers/doctors.py`, where DELETE is a soft delete — the reception staff
   router's docstring states the divergence and why, so a reader moving
   between the two is not misled.

3. **Manager-only, unlike every other reception write.** Reception routers
   are write-gated globally at `include_router` time (admin and manager).
   This one endpoint additionally carries `Depends(require_manager)`, the
   same per-endpoint pattern `routers/users.py` and `routers/audit.py` use.
   An irreversible, history-destroying action should be the narrower
   permission; deactivate stays open to admins. Consequence to handle in
   Task 1: this is the **first manager-only non-GET route outside
   `/users`**, and `tests/test_api/test_authorization.py:96` hardcodes
   `/api/v1/users` as the only path where an admin may legitimately see a
   403 — see Task 1(C).

4. **Explicit deletes in the router, not `ondelete="CASCADE"` on the FKs.**
   No migration, and the destruction is visible at the point it is decided
   rather than as a property of the schema that some unrelated future code
   path could trigger. The known cost is that a table added later with a
   staff FK would not be purged, so Task 1 adds a metadata-driven test that
   enumerates FKs targeting `reception_staff` and fails if one is not
   covered.

5. **Empty `reception_rotas` headers are left behind.** A header with no
   sessions already has a documented meaning — "generated, then every row
   deleted", as distinct from "never generated" (`models/reception.py:148`)
   — so deleting a header that the purge happened to empty would destroy
   that distinction and change what the day page offers.

6. **A separate usage endpoint, not counts on the list.** The confirm dialog
   needs real numbers to be worth reading, and the frontend holds no rota
   sessions. Folding the counts into `GET /reception/staff` would mean N+1
   aggregate queries on every page load for data that matters on one click.

7. **Delete requires the staff member to be inactive already (409
   otherwise).** New since the provisional plan. It makes the destructive
   path a deliberate two-step, matches the retiring-staff workflow the
   feature exists for, and removes the "deleted someone who is on today's
   rota" case entirely. Unlike the has-history guard rejected in Design
   Decision 1, it never makes anyone permanently undeletable — deactivate is
   always available, so the guard costs one extra click and nothing else. It
   also gives the two verbs a natural order (deactivate, then later delete)
   rather than presenting them as alternatives.

8. **The confirm dialog gates on typing the staff *code*, not a fixed
   literal.** `ForceDeleteRotaDialog` (`components/ForceDeleteRotaDialog.tsx`)
   is the existing precedent for a typed-confirmation destructive action and
   uses the literal `"DELETE"`. Typing the code is stricter in the way that
   matters here: this dialog is opened from one row of a table of similar
   rows, so the check should prove the user knows *which* record they are
   destroying, not merely that they read a word. Exact match — no trimming,
   no case folding — same as the precedent.

---

## Task 1: Backend — separate the two verbs

### A. State of the world

Nothing has been done yet; this is the first task. `DELETE
/reception/staff/{id}` is currently an unconditional soft delete identical
to `PATCH {"active": false}`. This task makes DELETE a permanent purge,
adds a usage endpoint for the confirm dialog to read, gates DELETE behind
`require_manager`, and covers all of it with backend tests. The frontend is
Task 2 and still calls the old endpoint until then — that is expected and
temporarily leaves the page's Deactivate button hard-deleting nothing (it
will 409 on an active member, per Design Decision 7), which Task 2 fixes.

### B. Files and deliverables

- `backend/app/api/routers/reception_staff.py` — rewrite DELETE, add
  `GET /{staff_id}/usage`, rewrite the module docstring.
- `backend/app/api/schemas/reception.py` — `ReceptionStaffUsageOut`,
  `ReceptionStaffDeleteOut` (staff schemas live at `:30-48`).
- `backend/tests/test_api/test_reception_staff.py` — rewrite the existing
  `test_soft_delete_then_list` (`:37`), add the purge tests.
- `backend/tests/test_api/test_authorization.py` — extend the admin sweep's
  exemption so the new manager-only route does not fail it.

No migration: nothing about the schema changes.

### C. Instructions

**DELETE `/reception/staff/{staff_id}`**

- Signature gains `manager: User = Depends(require_manager)` alongside the
  existing `get_db`/`get_current_user` dependencies. Import `require_manager`
  from `..deps`.
- 404 on an unknown id, via the existing `_get_or_404`.
- **409 if `staff.active` is true**, detail naming the code and saying to
  deactivate first, e.g. `f"Reception staff '{staff.code}' is active —
  deactivate before deleting"`. This is Design Decision 7 and the reason the
  frontend only offers Delete on an inactive row.
- Otherwise, in one transaction, delete the member's `ReceptionLeaveEntry`,
  `ReceptionMasterSession` and `ReceptionRotaSession` rows, then the
  `ReceptionStaff` row, then commit once.
- Use Core `delete()` statements with `.execution_options(
  synchronize_session=False)` and read the counts off `result.rowcount`,
  rather than loading rows and `db.delete()`-ing them one at a time.
  `ReceptionRota.sessions` carries `cascade="all, delete-orphan"`
  (`models/reception.py:157`), so a bulk delete that tried to synchronise a
  loaded parent's collection is a footgun worth avoiding explicitly.
- Leave `reception_rotas` headers alone (Design Decision 5).
- Return **200** with `ReceptionStaffDeleteOut`:
  `{"deleted": {"master_sessions": n, "rota_sessions": n,
  "leave_entries": n}}`. The page reports these numbers, not the ones it
  pre-fetched from `/usage`, since the two can differ if a day was
  generated while the dialog was open.
- Keep the table list in a module-level constant the FK-coverage test can
  import, e.g.:

  ```python
  # Every table that must be purged when a ReceptionStaff row is deleted.
  # test_reception_staff.py asserts this covers every FK targeting
  # reception_staff -- see the module docstring, decision 4.
  PURGED_MODELS = (ReceptionLeaveEntry, ReceptionMasterSession,
                   ReceptionRotaSession)
  ```

  Delete in that order and derive the response keys from it, so adding a
  model to the tuple is the only edit a future table needs.

**GET `/reception/staff/{staff_id}/usage`**

- Readable by anyone, like every other GET — no `require_manager`, no
  write gate (GET is a safe method).
- 404 on an unknown id, via `_get_or_404`.
- Returns `ReceptionStaffUsageOut`:
  `{"master_sessions": n, "rota_sessions": n, "generated_days": n,
  "leave_entries": n}`.
- `generated_days` is `select(func.count(distinct(ReceptionRota.date)))`
  joined through `ReceptionRotaSession` on the member. Document in the
  schema docstring that it is **not** the counters page's `days_present`:
  this counts every generated date the member has a row on, with no leave
  anti-join and no window, whereas `compute_role_counters` excludes leave
  dates and only looks at the rolling window
  (`app/reception_counters.py:163`). Without that note the two numbers look
  like a bug.
- Four small aggregates, one endpoint, called on dialog open only.

**Module docstring**

It currently states DELETE is a soft delete and explains why there is no
409 guard — both now wrong. Replace it with Design Decisions 1, 2, 3, 4 and
7 above, stated as reasoning in this file's voice rather than as a pointer
to this plan (which Task 3 deletes). Keep the existing paragraph about
`include_inactive` on GET, which is still accurate.

**Tests — `tests/test_api/test_reception_staff.py`**

The default `client` fixture is MANAGER (`tests/test_api/conftest.py:92`),
so existing tests pass the new gate unchanged.

- Rewrite `test_soft_delete_then_list` (`:37`): it currently asserts 204 and
  an inactive-but-present row. Deactivation is now `PATCH {"active": false}`
  — the assertion it was making still belongs, under a name like
  `test_patch_deactivates_then_list`.
- Purge: seed a member with master sessions, rota sessions on two generated
  dates, and leave entries; deactivate; DELETE; assert 200, the returned
  counts, and that all three child tables have no rows for that staff id.
- Other staff untouched: a second member's rows on the same generated day
  survive.
- Emptied `reception_rotas` headers survive: delete the only staff member
  with rows on a date, then assert the header still exists and
  `GET /reception/rota?date=` still returns it (not a 404).
- Leave entries specifically: they are the easiest of the three to forget,
  so assert them separately rather than only inside the purge test.
- 409 when the member is still active; the row is untouched afterwards.
- 404 on an unknown id.
- 403 for `admin_client` (write-tier but not manager) and for
  `viewer_client`; 200 for `manager_client`.
- `GET /{id}/usage`: the four counts on a seeded member, zeroes on a fresh
  one, 404 on an unknown id, and readable by `viewer_client`.
- FK coverage (Design Decision 4): walk `Base.metadata.tables` for any
  `ForeignKey` whose `column.table.name == "reception_staff"`, collect the
  referencing table names, and assert that set equals
  `{m.__tablename__ for m in PURGED_MODELS}`. Failure message should say
  that a new table references reception_staff and must be added to
  `PURGED_MODELS`.

**Tests — `tests/test_api/test_authorization.py`**

`test_admin_is_not_blocked_by_the_write_gate` (`:96`) parametrises every
non-GET route from the OpenAPI schema and asserts an admin does *not* get
403, with `path.startswith("/api/v1/users")` as the one documented
exception. `DELETE /reception/staff/{id}` breaks that.

Do not add a second path-prefix branch. Replace the prefix check with an
explicit set, since manager-only routes are now a category rather than one
router:

```python
# (method, concrete path) pairs where an admin is SUPPOSED to 403 -- these
# carry require_manager on top of the global write gate, so the sweep's
# "an admin gets past the gate" assertion inverts for them.
_MANAGER_ONLY = {
    ("POST", "/api/v1/users"),
    ("PATCH", "/api/v1/users/1"),
    ("DELETE", "/api/v1/reception/staff/1"),
}
```

Assert `== 403` for members of the set and `!= 403` otherwise, and update
the test's docstring, which names the `/users` exception by hand. Note the
sweep substitutes `"1"` for every path param, so the concrete paths above
are what it generates. Keep the targeted manager/admin tests in
`test_reception_staff.py` — the sweep proves the gate is attached, not that
it behaves.

---

## Task 2: Frontend

### A. State of the world

Task 1 is done: `DELETE /reception/staff/{id}` is a manager-only permanent
purge returning 200 with deleted-row counts, it 409s on an active member,
and `GET /reception/staff/{id}/usage` returns
`{master_sessions, rota_sessions, generated_days, leave_entries}`. The
frontend still calls DELETE to deactivate, which now 409s — this task fixes
that and adds the delete path.

### B. Files and deliverables

- `frontend/src/api/types.ts` — `ReceptionStaffUsage`,
  `ReceptionStaffDeleteResult`.
- `frontend/src/api/reception.ts` — drop `useDeactivateReceptionStaff`
  (`:86`), add `useReceptionStaffUsage`, `useDeleteReceptionStaff`, and a
  `staffUsage` query key.
- `frontend/src/components/DeleteReceptionStaffDialog.tsx` — new.
- `frontend/src/components/DeleteReceptionStaffDialog.test.tsx` — new.
- `frontend/src/routes/ReceptionStaffPage.tsx` — deactivate via PATCH, new
  Delete action.
- `frontend/src/routes/ReceptionStaffPage.test.tsx` — rewrite the existing
  deactivate test (`:94`), add the delete tests.

### C. Instructions

**`api/reception.ts`**

- Delete `useDeactivateReceptionStaff` entirely. Its only caller is
  `ReceptionStaffPage` (verified — no other import exists), which switches to
  the `useUpdateReceptionStaff` it already holds.
- Add to `receptionKeys`, keeping the flat shape the file's docstring
  insists on: `staffUsage: (staffId: number) => ["reception", "staff",
  "usage", staffId] as const`. It sits under `staffAll`, so a staff write
  already invalidates it.
- `useReceptionStaffUsage(staffId: number | null)`: `useQuery` on
  `staffUsage`, `enabled: staffId !== null`, hitting
  `/reception/staff/${staffId}/usage`. The dialog mounts only when a row is
  chosen, so this fetches on open.
- `useDeleteReceptionStaff()`: `apiClient.delete<ReceptionStaffDeleteResult>(
  \`/reception/staff/${id}\`)`. On success invalidate **four** roots —
  `staffAll`, `rotaAll`, `countersAll`, **and `leaveAll`**. The leave one is
  easy to miss and matters: the purge deletes leave entries, and
  `useReceptionLeave` caches them per staff (`api/reception.ts:328`), so
  `ReceptionLeavePage` would otherwise show rows for someone who no longer
  exists. Adding `countersAll` here is exactly the case the comment at
  `api/reception.ts:385` anticipated — update that comment to say a purge is
  now a second reason counters are invalidated.

**`components/DeleteReceptionStaffDialog.tsx`**

Model it on `ForceDeleteRotaDialog` (Radix `Dialog`, own open state, reset on
close, typed confirmation, `mutation.reset()` in `handleOpenChange`) but
driven by props rather than owning its trigger, since the page's table row
decides which member is being deleted — the same split
`ReceptionStaffFormDialog` already uses.

- Props: `{ staff: ReceptionStaff; open: boolean; onOpenChange: (open:
  boolean) => void; onDeleted?: () => void }`.
- Renders the usage counts from `useReceptionStaffUsage(staff.id)`, with a
  loading line while pending. Do not block the confirm button on the query
  failing — the counts are information, the delete is the action; if the
  query errors, say the counts are unavailable and let the delete proceed.
- Plain-words warning, not jargon: this permanently removes *n* rows from
  *m* already-generated days, so those days will no longer show what they
  showed before; their leave records go; and they disappear from the
  counters page entirely. Say that it cannot be undone.
- Confirmation: a text input that must exactly equal `staff.code` before the
  destructive button enables (Design Decision 8). No trim, no case fold.
  Label it so the required text is visible — "Type `RA` to confirm".
- On success close the dialog and call `onDeleted`; on error render the
  API detail inline, including the 409 (which should be unreachable through
  the UI, since the button is only offered on inactive rows — render it
  rather than special-case it).
- Docstring: why this dialog exists rather than `window.confirm` (it has to
  render the counts), and why it gates on the code where
  `ForceDeleteRotaDialog` gates on a literal (Design Decision 8).

**`routes/ReceptionStaffPage.tsx`**

- `handleToggleActive` becomes symmetric: both directions go through
  `updateStaff.mutate({ id, payload: { active: … } })`. Keep the existing
  `window.confirm` on deactivate and the existing `onError` banner.
  `isToggling` becomes just `updateStaff.isPending`.
- Row actions: **Edit** | **Deactivate**/**Reactivate** | **Delete**, where
  Delete renders only when `!s.active` (Design Decision 7 — there is nothing
  to click on an active row) **and** `useIsManager()` is true
  (`auth/AuthContext.tsx:86`). Hiding it below manager is a UX courtesy
  matching how `Users`/`Audit Log` are hidden in `App.tsx:129`; the 403 is
  the real boundary.
- Delete opens `DeleteReceptionStaffDialog` for that row, keyed by staff id
  so state resets between rows, mounted the same conditional way
  `ReceptionStaffFormDialog` already is at `:118`.
- The existing `{...writeGate}` spread stays on Edit and Deactivate.

**Tests**

`renderWithProviders` takes `accessLevel`, defaulting to `"manager"`
(`test/renderWithProviders.tsx:34`), so the below-manager case is one option
away.

- `ReceptionStaffPage.test.tsx:94` ("deactivate then reactivate") mocks
  `window.confirm` and `http.delete("/api/v1/reception/staff/1")`. Rewrite
  it against `http.patch` — the assertion (status column toggles) is still
  the right one.
- Delete is absent on an active row; present on an inactive row at manager;
  absent on an inactive row at `accessLevel: "admin"`.
- Dialog: confirm button disabled until the code is typed exactly (assert a
  near-miss such as lower case stays disabled), fires the mutation with the
  right id, closes and removes the row on success, and surfaces an API
  error detail on failure.
- Usage counts render in the dialog from a mocked `/usage` response, and a
  failing `/usage` still allows the delete.

---

## Task 3: Documentation

### A. State of the world

Tasks 1 and 2 are done: the backend purges and gates, the frontend
deactivates via PATCH and deletes through a confirm dialog, and both halves
carry their own tests. All that remains is to correct the architecture
documentation, which still describes the old behaviour, and to delete this
plan.

### B. Files and deliverables

- `documentation/architecture-reception.md` — the `/reception/staff` row of
  the Router surface table (`:61`) and a new paragraph in the Domain
  section.
- `backend/app/reception_counters.py` — one caveat in the existing
  docstring.
- `documentation/reception_staff_delete_plan.md` — delete.

### C. Instructions

- Rewrite the `/reception/staff` table row at `:61`. It currently reads
  "`DELETE /{id}` (unconditional soft delete — no committed-rota concept to
  block against)", which is now wrong in both halves. Describe the four
  verbs, note that DELETE is a manager-only permanent purge that 409s on an
  active member, and add `GET /{id}/usage`.
- Add a short paragraph to the Domain: Reception Rota section (near the
  `reception_staff` paragraph at `:9`) carrying Design Decisions 1, 2, 5 and
  7: what a purge destroys and why that is accepted, why DELETE and
  deactivate are now different verbs where the clinical side's are not, why
  emptied `reception_rotas` headers survive, and why deletion requires
  deactivation first. Keep it to reasoning — the row-by-row mechanics are
  readable in the router.
- `app/reception_counters.py:173` says "a recently deactivated person's
  history stays visible". Still true, but add that a *deleted* person's does
  not, since their sessions are gone — the counters are derived from rows
  that no longer exist.
- Delete `documentation/reception_staff_delete_plan.md`.
