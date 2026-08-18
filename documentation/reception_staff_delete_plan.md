# Plan — Permanently delete reception staff (as well as deactivate)

Provisional plan, written in discussion. Not yet expanded into per-task
implementation chats.

## Scope

Reception only. Adds a permanent-delete path for `reception_staff` alongside
the existing deactivate, and separates the two verbs, which currently do the
same thing. Nothing in the clinical rota is touched — `doctors.py` keeps its
soft-delete-with-409 shape, and the divergence is deliberate (recorded in the
router docstring, see Design Decisions).

Out of scope: bulk delete, an undo/restore path, and any change to how leave,
the master template or generation behave for staff who remain.

## State of the world

- `reception_staff` is `id`/`code`/`name`/`active` and nothing else
  (`backend/app/models/reception.py`).
- `DELETE /reception/staff/{id}` is already an unconditional soft delete —
  it sets `active = False`, which is exactly what `PATCH {"active": false}`
  does. Two endpoints, one behaviour.
- Exactly three tables carry a plain (non-cascading) FK to
  `reception_staff`: `reception_master_sessions`,
  `reception_rota_sessions`, `reception_leave_entries`. Nothing else
  references staff — reception counters are derived at read time from
  `reception_rota_sessions` and have no stored table, and there is no engine.
- `ReceptionStaffPage` already lists inactive staff and offers Reactivate, so
  the deactivate half of the requirement already works and does not change.

## Design Decisions

1. **Delete purges history; it does not refuse to run.** A hard delete
   removes the staff member's rows from every already-generated day, so a day
   rota printed last March will no longer match what the app shows, and the
   reception counters window loses that person entirely. There is no way
   around this: `reception_rota_sessions.staff_id` is non-nullable, and an
   orphaned row with no name attached is worse than no row. The considered
   alternative — block deletion for anyone with generated-day rows — was
   rejected because anyone who has actually worked a day would then be
   undeletable, which is precisely the retiring-staff case the feature
   exists for. The mitigation is informed consent in the UI, not a guard in
   the router.

2. **`DELETE` means delete; deactivate is `PATCH {"active": false}`.** The
   frontend already reactivates via PATCH, so the pair is symmetric after
   this change and the current duplicate endpoint goes away. This diverges
   from `routers/doctors.py`, where DELETE is a soft delete — the reception
   staff router's docstring states the divergence and why, so a reader
   moving between the two is not misled.

3. **Manager-only, unlike every other reception write.** Reception routers
   are write-gated globally at `include_router` time (admin and manager).
   This one endpoint additionally carries `Depends(require_manager)`, the
   same per-endpoint pattern `routers/users.py` and `routers/audit.py` use.
   An irreversible, history-destroying action should be the narrower
   permission; deactivate stays open to admins.

4. **Explicit deletes in the router, not `ondelete="CASCADE"` on the FKs.**
   No migration, and the destruction is visible at the point it is decided
   rather than as a property of the schema that some unrelated future code
   path could trigger. The known cost is that a table added later with a
   staff FK would not be purged, so Task 3 adds a metadata-driven test that
   enumerates FKs targeting `reception_staff` and fails if one is not
   covered.

5. **Empty `reception_rotas` headers are left behind.** A header with no
   sessions already has a documented meaning — "generated, then every row
   deleted", as distinct from "never generated" — so deleting a header that
   the purge happened to empty would destroy that distinction and change what
   the day page offers.

6. **A separate usage endpoint, not counts on the list.** The confirm dialog
   needs real numbers to be worth reading, and the frontend holds no rota
   sessions. Folding the counts into `GET /reception/staff` would mean N+1
   aggregate queries on every page load for data that matters on one click.

## Task 1: Backend — separate the two verbs

Files: `backend/app/api/routers/reception_staff.py`,
`backend/app/api/schemas.py`.

- Rewrite `DELETE /reception/staff/{id}` as a permanent delete. In one
  transaction: delete the member's `ReceptionLeaveEntry`,
  `ReceptionMasterSession` and `ReceptionRotaSession` rows, then the
  `ReceptionStaff` row. 404 on an unknown id, as now.
- Return `200` with `{"deleted": {"master_sessions": n, "rota_sessions": n,
  "leave_entries": n}}` rather than `204`, so the page can report what went.
  New `ReceptionStaffDeleteOut` schema.
- Add `Depends(require_manager)` to this endpoint only.
- Add `GET /reception/staff/{id}/usage` →
  `{"master_sessions": n, "rota_sessions": n, "generated_days": n,
  "leave_entries": n}` (`generated_days` = distinct `reception_rotas.date`
  the member has sessions on). Readable by anyone, like every other GET.
  New `ReceptionStaffUsageOut` schema.
- Update the module docstring: it currently states DELETE is a soft delete
  and explains why there is no 409 guard. Replace with Design Decisions 1–4
  above, stated as reasoning rather than as a pointer to this file.

## Task 2: Frontend

Files: `frontend/src/api/reception.ts`, `frontend/src/api/types.ts`,
`frontend/src/routes/ReceptionStaffPage.tsx`, plus a new
`frontend/src/components/DeleteReceptionStaffDialog.tsx`.

- `useDeactivateReceptionStaff` is renamed/retargeted: deactivate becomes a
  `PATCH {"active": false}` call (the page already has
  `useUpdateReceptionStaff` — reuse it and drop the dedicated hook).
- New `useReceptionStaffUsage(id)` query and `useDeleteReceptionStaff()`
  mutation. The mutation invalidates the staff key root, the reception rota
  keys and the counters key, since both of those can be stale after a purge.
- Row actions become Edit | Deactivate/Reactivate | Delete.
- Delete opens a Radix dialog rather than `window.confirm`, because it has
  to render the usage counts. It states in plain words that past generated
  days will change and the counters page will lose this person, and requires
  the staff **code** to be typed before the destructive button enables.
  Non-managers do not see the Delete button at all (UX courtesy; the 403 is
  the boundary), consistent with how `Users`/`Audit Log` are hidden.

## Task 3: Tests and documentation

- `backend/tests/test_api/test_reception_staff.py`: purge removes rows from
  all three child tables; other staff untouched; emptied `reception_rotas`
  headers survive; 404 on unknown id; a non-manager write-tier user gets 403;
  the metadata FK-coverage test from Design Decision 4.
- `frontend/src/routes/ReceptionStaffPage.test.tsx`: the dialog gates on the
  typed code, fires the mutation, surfaces an error, and Delete is absent
  below manager.
- `documentation/architecture-reception.md`: correct the `/reception/staff`
  row of the Router surface table (it currently documents DELETE as an
  unconditional soft delete) and add a short paragraph carrying Design
  Decisions 1, 2 and 5. Delete this plan file once the work ships.
