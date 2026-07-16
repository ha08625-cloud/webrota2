# Plan

Add a force-delete escape hatch for committed rotas: `DELETE /rota/{rota_id}/force-delete` removes a committed rota outright, leaving live counters exactly as they are. It exists for recovering from software bugs (the immediate case: a legacy commit with `committed_at = NULL` that can never be rolled back and is blocking regeneration of its date range), not for everyday mistakes -- rollback remains the correct tool wherever it is available. The frontend exposes it as a destructive-styled button on the committed rota detail view, gated behind a dialog that requires typing the word DELETE.

# Scope

- New engine function `force_delete_rota(db, rota_id)` in `backend/app/engine/generate.py`.
- New router endpoint `DELETE /rota/{rota_id}/force-delete` in `backend/app/api/routers/rota.py`.
- New frontend mutation hook `useForceDeleteRota` in `frontend/src/api/rota.ts`.
- New component `ForceDeleteRotaDialog` and wiring into `RotaDetailPage`'s committed view.
- Tests at all three layers (engine lifecycle, API, frontend).

Out of scope: no schema changes, no migration, no changes to rollback/scrap/archive behaviour, no audit log of deletions (single-admin system; the deletion is deliberate and confirmed), no button on archived rotas (user decision).

# Design Decisions

1. **Endpoint and status codes.** `DELETE /rota/{rota_id}/force-delete`. 404 if the rota does not exist; 409 if it is a draft (drafts already have scrap via `DELETE /rota/{id}` -- two delete paths for the same status is confusing); 204 on success, matching scrap's convention.
2. **Logic lives in the engine, router stays thin.** `force_delete_rota(db, rota_id)` in `generate.py` raises `ValueError` like its siblings; the router maps "not found" in the message to 404 and everything else to 409, the same pattern as the rollback endpoint. The engine flushes; the router commits.
3. **No ordering, `committed_at`, or snapshot-existence checks.** Rollback's five eligibility checks exist to keep the counter-restore chain consistent; this endpoint touches no counters, so none apply. Any committed rota -- middle of the chain, most recent, legacy with `committed_at = NULL`, zero snapshot rows -- can be force-deleted. Legacy NULL commits are in fact the primary real-world trigger.
4. **Counters (`ClinicCounter`/`SystemCounter`) are untouched.** Whatever the deleted rota's generation and subsequent edits added to the running totals stays in the live values. One documented caveat: this permanence is not absolute. Snapshots store absolute pre-generation values, not deltas, so if the force-deleted rota was the most recent commit, the previous commit becomes rollback-eligible, and rolling *it* back restores counters to *its* snapshot -- silently discarding the deleted rota's baked-in contributions as well. This is acceptable (arguably desirable in a bug-recovery scenario) and gets a test proving the interaction, but it must be stated in code comments rather than discovered later.
5. **Snapshot rows are deleted via the existing `_delete_snapshots(db, rota_id)` helper.** The snapshot tables have plain FKs to `generated_rotas` with no cascade, so the rota delete would fail with an FK violation otherwise. `_delete_snapshots` is two bulk deletes and is a safe no-op on a legacy rota with zero snapshot rows.
6. **Sessions, closures, and the generation log need no code.** All three carry `cascade="all, delete-orphan"` from `GeneratedRota`, so `db.delete(rota)` removes them.
7. **`archived_at` is ignored server-side.** An archived committed rota can be force-deleted via the API (archiving is a pure visibility flag). The UI, however, only shows the button on non-archived committed rotas (user decision) -- an archived buggy rota must be unarchived first, which is one click.
8. **The orphaned `RotaConfig` row is left behind**, exactly as scrap already does. Harmless, consistent, deliberate.
9. **Unblocking regeneration is automatic.** `generate`'s overlap check scans committed `GeneratedRota` rows; once the row is gone, its date range is free. No extra code.
10. **Rollback eligibility shift is self-healing on the frontend.** `isMostRecentRollbackableCommit` derives eligibility from the rota list; the hook invalidates the list on success, so the previous commit's Rollback button appears (or not) correctly on the next render. No special handling needed, but one frontend test pins it.
11. **Frontend confirmation is typed, not a click-through.** `window.confirm` (the commit/scrap/rollback/archive pattern) is too weak for an operation that permanently deletes a committed rota and desynchronises counters from history. A Radix dialog (`@radix-ui/react-dialog`, already a project dependency) requires typing DELETE exactly before the confirm button enables. The warning text states plainly: this is for software bugs only; use Roll back commit for everyday mistakes if it is available.
12. **Navigation on success.** The detail query is removed from the cache and the rota no longer exists, so the page navigates to `/rota` after a successful force-delete (unlike rollback/archive, which re-render in place from the response).

---

# Task 3: Frontend -- hook, dialog, detail-page wiring

**A.** Tasks 1-2 are complete: the backend endpoint exists and is tested. This task adds the frontend. Relevant existing behaviour: `RotaDetailPage`'s committed view renders "This rota is committed and read-only" with a conditional Roll back commit button and an Archive/Unarchive toggle; `useScrapRota` in `api/rota.ts` is the model for a delete-shaped mutation (removeQueries on detail, invalidate list); Radix `@radix-ui/react-dialog` is already a dependency (used by `DoctorFormDialog`).

**B.** Files:
- `frontend/src/api/rota.ts` -- add `useForceDeleteRota`.
- `frontend/src/api/rota.test.tsx` -- hook tests.
- `frontend/src/components/ForceDeleteRotaDialog.tsx` -- new component.
- `frontend/src/components/ForceDeleteRotaDialog.test.tsx` -- new component tests.
- `frontend/src/routes/RotaDetailPage.tsx` -- render the dialog trigger on the committed, non-archived view; navigate on success.
- `frontend/src/routes/RotaDetailPage_test.tsx` -- visibility and end-to-end tests.
- `frontend/src/test/msw/handlers.ts` -- default handler for the new endpoint if the central handler list covers the other rota mutations (match existing convention; if rollback/archive are only registered per-test via `server.use`, do the same here).

Deliverables: hook, component, page wiring, all frontend tests green, typecheck clean.

**C.** Instructions:

**Hook** (`api/rota.ts`), mirroring `useScrapRota` exactly, with a docstring noting it is the bug-recovery escape hatch and that counters are not restored:

```typescript
export function useForceDeleteRota() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rotaId: number) => apiClient.delete<void>(`/rota/${rotaId}/force-delete`),
    onSuccess: (_data, rotaId) => {
      queryClient.removeQueries({ queryKey: rotaKeys.detail(rotaId) });
      queryClient.invalidateQueries({ queryKey: rotaKeys.list() });
    },
  });
}
```

Hook tests mirror the `useScrapRota`/`useRollbackCommit` test pattern: correct URL and method; detail cache removed and list invalidated on success.

**Component** (`ForceDeleteRotaDialog.tsx`). Props: `{ rotaId: number; onDeleted: () => void }`. Radix Dialog:
- Trigger: a button labelled "Force delete rota", destructive styling stronger than the Scrap button's outline style -- solid red: `rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50`.
- Dialog content: title "Force delete this rota?"; warning body text: "This permanently deletes this committed rota. Counters are NOT restored -- they will keep this rota's contributions with no rota to explain them. This exists only for recovering from software bugs, such as a committed rota that cannot be rolled back. For everyday mistakes, use Roll back commit instead if it is available."
- A labelled text input: "Type DELETE to confirm". The confirm button ("Permanently delete") is disabled unless the input value is exactly `DELETE` (case-sensitive) and the mutation is not pending.
- Confirm fires `useForceDeleteRota` (the component owns the hook); on success call `onDeleted()`. On error render the `detail` string when present, else a static "Could not delete this rota." -- same pattern as the rollback error rendering.
- Cancel button and Radix's overlay/escape close the dialog and reset the input.

Component tests: trigger renders; confirm disabled initially, disabled for wrong text ("delete", "DELET"), enabled for exact "DELETE"; confirm fires the endpoint (MSW capture) and calls `onDeleted`; a 409 response renders its detail string; cancel resets so reopening shows a disabled confirm again.

**Page wiring** (`RotaDetailPage.tsx`). In the committed (non-draft) action area, render `<ForceDeleteRotaDialog rotaId={currentRotaId} onDeleted={() => navigate("/rota")} />` only when `rota.archived_at === null` (Decision 7's UI side -- the field is on `Rota` from `GET /rota/{id}`). Place it after the Archive/Unarchive control so the destructive action sits last. `useNavigate` is already imported on this page if commit/scrap use it; if not, add it.

Page tests (`RotaDetailPage_test.tsx`, following the rollback describe-block conventions):
1. Button visible on a committed, non-archived rota -- including one with `committed_at: null` and no Roll back button (the primary use case: it must appear exactly where rollback is unavailable).
2. Button absent on a draft.
3. Button absent on an archived committed rota (`archived_at` set).
4. Full flow: open dialog, type DELETE, confirm, MSW returns 204 for `DELETE /api/v1/rota/:id/force-delete` -- assert navigation to `/rota` (route probe pattern already used in `RotaPage.test.tsx`).
5. Rollback-eligibility shift: list contains commits A (older) and B (newer); after force-deleting B and list invalidation returns only A, A's detail view shows the Roll back commit button. If wiring this in one test is awkward with MSW handler swapping, a simpler acceptable form: assert the list query is invalidated on success (already covered at hook level) and pin the shift at the `isMostRecentRollbackableCommit` unit level instead with a comment referencing Decision 10.

Run typecheck, vitest, and build.

---

# Notes for the user (not part of the Sonnet tasks)

- Your architecture hub still contains two pre-M3.7 sentences stating "Commit deletes the snapshots" (under "Counters and snapshots" and in the "Rota lifecycle" intro paragraph), contradicting the M3.7 sections of the same document. Worth fixing next time you touch it, and worth adding a force-delete line to the lifecycle section once this ships.
- The `railway.toml` [UNRESOLVED] note in the hub is unrelated to this work and remains outstanding.



# Task 1: Engine function and lifecycle tests

**A.** State of the world: the full draft/commit/scrap/rollback lifecycle exists in `backend/app/engine/generate.py` with shared helpers `_restore_counters_from_snapshot` and `_delete_snapshots`. Nothing for this feature has been built yet. This task adds the engine function and its engine-level tests only -- no API changes.

**B.** Files:
- `backend/app/engine/generate.py` -- add `force_delete_rota(db, rota_id)`.
- `backend/tests/tes_engine/test_lifecycle.py` -- add a `TestForceDelete` class (note the existing directory really is spelled `tes_engine` in the repo file naming; match wherever the existing lifecycle tests live).

Deliverables: the new function with a docstring in the house style (what it does, what it deliberately does not check, the Decision 4 counter caveat, ValueError cases and their router mapping), plus passing tests.

**C.** Instructions:

Implement `force_delete_rota(db, rota_id) -> None`:
- `db.get(GeneratedRota, rota_id)`; `ValueError(f"GeneratedRota id={rota_id} not found")` if None.
- `ValueError` if `rota.status != RotaStatus.COMMITTED` -- message should say the rota is a draft and scrap is the correct operation (this becomes the 409 detail verbatim).
- No other checks. Do not look at `committed_at`, `archived_at`, snapshot rows, chain order, or active drafts.
- `_delete_snapshots(db, rota_id)`, then `db.delete(rota)` (ORM cascade removes sessions, closures, generation log), then `db.flush()`. Do not call `_restore_counters_from_snapshot` -- leaving counters untouched is the entire point.
- Docstring must state Decision 4's caveat explicitly: after force-deleting the most recent commit, rolling back the new most-recent commit restores counters to that rota's snapshot, discarding the deleted rota's contributions too.

Tests (reuse `_build_fixture` and the factory helpers already in the lifecycle test module):
1. Generate, commit, force-delete: the `GeneratedRota`, its `RotaSession`, snapshot, and `RotaGenerationLogEntry` rows are all gone; the `ClinicCounter` value remains at its post-generation value (not restored to the snapshot value); the `RotaConfig` row still exists.
2. Force-delete a draft raises `ValueError` (message mentions draft/scrap).
3. Force-delete a nonexistent id raises `ValueError` with "not found".
4. Legacy commit: build a `GeneratedRota` directly with `status=COMMITTED` and `committed_at=None` and no snapshot rows (the same construction `test_rollback_committed_at_null_raises` uses); force-delete succeeds.
5. Chain-position freedom: generate+commit rota A, generate+commit rota B, force-delete A (the older one) -- succeeds, B untouched.
6. Decision 4 interaction: generate+commit A, generate+commit B, force-delete B, then `rollback_commit(session, A.id)` succeeds and restores the counter to A's pre-generation snapshot value -- i.e. B's contribution is gone from the live counters. Assert the final counter value equals A's snapshot value.

Run the engine test suite; all green before moving on.

---

# Task 2: Router endpoint and API tests

**A.** Task 1 is complete: `force_delete_rota` exists in `generate.py` with engine tests passing. This task exposes it over HTTP and tests the wire behaviour.

**B.** Files:
- `backend/app/api/routers/rota.py` -- new endpoint; extend the module docstring's lifecycle-rules list with one line for force-delete.
- The API rota test module (repo path corresponding to `backend_tests_tes_api_test_rota.py`) -- new test class.

Deliverables: the endpoint with docstring, updated module docstring, passing API tests.

**C.** Instructions:

Add to `routers/rota.py`, importing `force_delete_rota` alongside the other engine imports:

```python
@router.delete("/{rota_id}/force-delete", status_code=204)
def force_delete(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
```

- Docstring: escape hatch for committed rotas that cannot be rolled back (e.g. legacy `committed_at = NULL` commits) or other software-bug states; counters deliberately untouched (reference the engine docstring for the Decision 4 caveat); no chain-order or draft-elsewhere checks; `archived_at` ignored; drafts 409 here because scrap is their delete path.
- Body follows the rollback endpoint's delegation pattern: `try: force_delete_rota(db, rota_id) except ValueError` -> `db.rollback()`, map "not found" to 404 else 409 with the message as detail; on success `db.commit()`. Return nothing (204).

Tests (use the existing API test conftest and whatever generate/commit helpers the rota API tests already use):
1. Commit a rota, `DELETE /api/v1/rota/{id}/force-delete` returns 204; `GET /rota/{id}` then 404s; the rota is absent from `GET /rota`.
2. Regeneration unblocked: commit a rota over a date range, confirm `POST /rota/generate` for the same range 409s, force-delete, confirm the same generate call now succeeds.
3. Draft: 409, detail mentions draft.
4. Nonexistent id: 404.
5. Archived committed rota (commit then `POST /{id}/archive`): force-delete returns 204 -- Decision 7's server side.
6. Legacy commit (`committed_at=None`, no snapshots, inserted directly via the session the conftest exposes): 204.

Run the API test suite; all green.

---