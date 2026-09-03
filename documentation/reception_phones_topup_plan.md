# Provisional plan — reception phones top-up (online triage → phones)

Stage 1 (discussion) output. To be reviewed and expanded into an implementation
plan in a fresh chat, then broken into per-task chats.

## Scope

Add a second assignment step to the reception day: after front desk blocks are
chosen, move staff tagged `online_triage` onto `phones` for any half-hour slot
where the phones headcount is below `min_phones_for_hour`, in **contiguous
chunks** so one person covers a run rather than three people covering a slot
each.

Out of scope: any change to the coverage rule itself, to `compute_coverage_issues`,
to generation (`POST /reception/rota` stays a pure template copy), to the counters
page, or to `ReceptionGrid`.

## What already exists and is being reused, not rebuilt

- **The coverage rule is already exactly what was asked for.** `min_phones_for_hour`
  (`backend/app/models/reception.py`) returns 0 before 08:00, `MIN_PHONES_STAFF = 2`
  from 08:00 to 16:30, and `MIN_PHONES_STAFF_QUIET = 1` from 17:00 through the
  closing 18:00–18:30 slot. No new constants, no config, no migration.
- **The displacement/reset mechanism already exists.** `reception_rota_sessions.displaced_role`
  (nullable, migration 006) records what an assigner overwrote, and reset is a flat
  "restore every row with a non-null `displaced_role`". The top-up step writes the
  same column. **No migration is required.**
- **`compute_coverage_issues` needs no change.** `phones_shortfall` already reports
  exactly the residual this step fails to fill.
- **`receptionRunContinuations` already merges a contiguous same-role run into one
  chip**, so a three-hour top-up chunk renders as one block in the grid for free.

## Design decisions

**D1 — One combined assign endpoint, replacing the two-step shape.**
`POST /reception/rota/{id}/front-desk` becomes `POST /reception/rota/{id}/assign`,
which does reset → front desk → phones top-up in one transaction. The two steps are
genuinely coupled: the front-desk scorer deliberately displaces phones (`W_PHONES`
is a penalty, not a prohibition), so the top-up exists partly to repair the hole the
desk just made, and running it against a stale desk assignment is meaningless. Two
endpoints would also each need to reset only *their own* `displaced_role` rows, which
means a discriminator column and a migration, to buy a re-run mode nobody wants.
The system is not live, so the rename is free; the frontend already chains generate →
assign, so this is one fewer round trip.

**D2 — Greedy longest-chunk, not exhaustive enumeration. This is knowingly suboptimal.**
Front desk enumerates all 50 legal partitions of a fixed 20-slot window and returns the
true optimum. The top-up problem is a different shape and does not admit that: demand is
a per-hour **deficit vector** over 22 slots where a deficit can be 2 (an hour with nobody
on phones), deficit hours are **not contiguous**, and chunks are a **covering with
multiplicity** rather than a partition. Greedy can therefore get it wrong — it can hand a
long run to the only person who could have covered a later gap, leaving that gap unfilled
when a split would have covered both. Accepted for v1: the residual surfaces as the
existing `phones_shortfall` warning, which is the same "nothing blocks, warnings tell the
truth" convention as the rest of reception. Min-cost flow or a DP over slot states would be
optimal and are a large step up in complexity; revisit only if real days show bad answers.

**D3 — Longest chunk first, fairness as tie-break.** Candidates are ranked on
`(-deficit_slots_covered, phones_load_ratio, staff_id)`. Chunk quality is the stated goal,
so it outranks fairness; the ratio is `phones_hours / hours_worked` over the same
`assignment_counter_window` the front-desk assigner uses, with a zero denominator scoring
0.0 (lowest load, picked first) exactly as `_fairness` does there. Ranking is on *deficit*
slots covered, not total slots — bridged slots are a convenience, not a goal, and must not
inflate a candidate's rank.

**D4 — Bridge non-deficit slots, up to two of them (one hour).** Deficits at 09:00 and
10:00 but not 09:30 give one person 09:00–10:30 rather than two 30-minute stints. The cap
stops a bridge swallowing a whole afternoon of triage; trailing bridged slots are trimmed
so a chunk always starts and ends on a real deficit slot.

**D5 — Online triage is fully sacrificial.** No minimum triage headcount, hard or soft.
Phones is the only role in reception with a minimum-staffing concept, and introducing a
second one for triage would be a new domain rule to justify, document and edit. Strip
triage to zero if that is what the phones minimum needs.

**D6 — `online_triage` is the only source pool.** Not `other`, not `admin`. That is what was
asked for and it is the explicit, auditable version; widening the pool later is a constant
change, not a redesign.

**D7 — `W_PHONES` in the front-desk scorer stays as it is.** It is tempting to drop it now
that shortfalls get repaired, but creating a shortfall that must then be repaired by
consuming a triage person is a real cost, not a free one. Keep the documented relationship
`W_PHONES > W_ROLE`.

**D8 — The top-up window is 08:00–18:30, wider than front desk's 08:00–18:00.** Front desk
has its own narrower window because the desk is not manned before opening or after close;
phones cover is required for every slot `min_phones_for_hour` returns non-zero for, which
includes the closing slot. The top-up module reads `RECEPTION_HOURS` and
`min_phones_for_hour`, never `FRONT_DESK_HOURS`.

## Algorithm

`select_phones_blocks(rota, staff_on_leave, counters) -> list[PhonesBlock]`, pure —
no writes, no queries, same separation as `reception_front_desk.py`. Called by the router
*after* front desk blocks have been applied and flushed, so it reads the post-desk world.

1. `deficit[hour] = max(0, min_phones_for_hour(hour) - phones_headcount(hour))` for every
   hour in `RECEPTION_HOURS`, headcount excluding staff on leave (the same exclusion
   `compute_coverage_issues` applies).
2. `availability[staff_id] = {hours where that staff has a session row with role ==
   ONLINE_TRIAGE and is not on leave}`. Anyone the desk took is already `front_desk` and
   so is excluded automatically.
3. Loop until no fillable deficit remains:
   - `h` = earliest hour with `deficit[h] > 0` and not already known unfillable.
   - Candidates = staff available at `h`. None → mark `h` unfillable and continue (this is
     what guarantees termination alongside the monotonically falling deficit total).
   - For each candidate, walk forward from `h` while they remain available, taking deficit
     slots and bridging runs of at most 2 non-deficit slots when a further deficit slot is
     still reachable; trim trailing bridged slots.
   - Take the best candidate by `(-deficit_slots, phones_load_ratio, staff_id)`.
   - Emit the chunk; decrement `deficit` (floored at 0 for bridged slots); remove those
     hours from that staff's availability so one person cannot count twice at one hour.

Determinism: every tie-break ends in `staff_id`, so re-running against unchanged data gives
the same answer — the same guarantee `select_front_desk_blocks` makes.

## Open question for the review stage

**Which fairness ratio should pick who comes off triage?** The plan defaults to *lowest
phones load*, consistent with front desk's convention that fairness means spreading the
thing being assigned. The arguable alternative is *highest online-triage load* — pull
whoever has had the most triage time recently, on the grounds that they can best afford to
lose a session and it is less disruptive than moving a triage specialist's rare slot. Both
are defensible; the counters aggregate already carries both numbers, so this is a one-line
change either way. Worth a decision before implementation rather than after.

## Provisional task breakdown

1. **New module** `backend/app/reception_phones.py` — `PhonesBlock`, `select_phones_blocks`,
   the deficit/availability/chunk helpers, module docstring carrying the mechanics.
   Plus `backend/tests/test_reception_phones.py` covering: a single-slot deficit, a
   three-slot run going to one person, a run split because nobody spans it, bridging and
   its cap, a deficit of 2 at one hour, nobody available (empty result), the 17:00+
   requirement of 1, and determinism.
2. **Router** `backend/app/api/routers/reception_rota.py` — rename `assign_front_desk` to
   `assign_rota` on `/{rota_id}/assign`, apply the top-up after the front-desk apply and
   flush, extend the docstring. Update `backend/tests/test_api/test_reception_rota.py`.
3. **Docstring/invariant updates** — `displaced_role` on `ReceptionRotaSession`
   (`backend/app/models/reception.py`) widens from "the front-desk generator wrote this
   slot" to "an assigner wrote this slot"; a note in `reception_front_desk.py` that a second
   step now follows it and why `W_PHONES` survives.
4. **Frontend** — `frontend/src/api/reception.ts` (`useAssignReceptionFrontDesk` →
   `useAssignReceptionRota`, URL `/assign`), `frontend/src/routes/ReceptionDayPage.tsx`
   (two call sites, ~line 129 and ~line 253, plus the page docstring), and the MSW handlers
   in `ReceptionDayPage.test.tsx`.
5. **Architecture doc** — record D1–D8 and the greedy-vs-optimal trade in
   `documentation/architecture-reception.md`, update the `/reception/rota` endpoint table
   row, then delete the implementation plan.

## Consequence worth stating up front

Days generated before this feature keep their `phones_shortfall` warnings until the day is
re-assigned. Freshly generated days will carry far fewer of them, because the frontend
chains generate → assign.
