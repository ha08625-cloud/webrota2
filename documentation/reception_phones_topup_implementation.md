# Implementation plan — reception phones top-up (online triage → phones)

Stage 2 output. Supersedes `documentation/reception_phones_topup_plan.md`
(the provisional plan), which the final task deletes along with this file.

Each numbered task below is intended to be handed to its own chat. Sections
A/B/C in each task are, respectively: the state of the world, the files and
deliverables, and the instructions.

## Plan

After the front desk has been assigned on a generated reception day, move
staff tagged `online_triage` onto `phones` for any half-hour slot where the
phones headcount is below `min_phones_for_hour`, in **contiguous chunks** so
one person covers a run rather than three people covering a slot each.

Delivered as: one new pure module (`backend/app/reception_phones.py`), a
rename and one extra step in the existing assignment endpoint, docstring
corrections to two existing files, a frontend rename, and an architecture
doc update.

## Scope

In scope:

- A new pure selection module and its unit tests.
- Renaming `POST /reception/rota/{id}/front-desk` to
  `POST /reception/rota/{id}/assign` and running the top-up inside it.
- Frontend rename of the corresponding hook and its call sites.
- Docstring/invariant updates where the top-up widens an existing statement.

Out of scope, explicitly:

- The coverage rule itself (`min_phones_for_hour`, `MIN_PHONES_STAFF`,
  `MIN_PHONES_STAFF_QUIET`) — unchanged, no new constants, no config.
- `compute_coverage_issues` — unchanged. `phones_shortfall` already reports
  exactly the residual this step fails to fill.
- Generation (`POST /reception/rota`) — stays a pure template copy with its
  409 semantics.
- Any migration. `reception_rota_sessions.displaced_role` already exists
  (migration `006`) and the top-up writes the same column; see D1.
- `ReceptionGrid`, `pivotReception`, the counters page, and the counters
  module — all unchanged. `receptionRunContinuations` already merges a
  contiguous same-role run into one chip, so a three-hour top-up chunk
  renders as one block for free.

### Non-blocking pre-flight worth doing first

This feature can only fix a deficit at an hour where somebody is tagged
`online_triage` on that day. Before starting Task 1, it is worth eyeballing
the weekday master template: if triage cover sits mid-morning while the
shortfalls cluster at 08:00 and after 17:00, the feature will do very little
and D6's narrow source pool is the first thing to revisit. This is a
five-minute look at `reception_master_sessions`, not a task, and it does not
block implementation — a top-up that fires rarely is still correct.

## Design decisions

**D1 — One combined assign endpoint, replacing the two-step shape.**
`POST /reception/rota/{id}/front-desk` becomes
`POST /reception/rota/{id}/assign`, which does reset → front desk → phones
top-up in one transaction. The two steps are genuinely coupled: the
front-desk scorer deliberately displaces phones (`W_PHONES` is a penalty,
not a prohibition), so the top-up exists partly to repair the hole the desk
just made, and running it against a stale desk assignment is meaningless.

The decisive argument is the reset. Two endpoints would each have to reset
only *their own* `displaced_role` rows, which means a discriminator column
and therefore a migration, bought purely to enable a re-run mode nobody
wants. One endpoint keeps `displaced_role`'s invariant flat and total, and
needs no schema change at all.

Note this saves no round trip: the frontend does generate + assign today and
generate + assign afterwards. What it avoids is adding a *third* call.
The system is not live, so the rename is free.

**D2 — Greedy longest-chunk, not exhaustive enumeration. Knowingly
suboptimal.** Front desk enumerates all fifty legal partitions of a fixed
twenty-slot window and returns the true optimum. The top-up problem is a
different shape and does not admit that: demand is a per-hour **deficit
vector** over twenty-one slots where a deficit can be 2 (an hour with nobody
on phones), deficit hours are **not contiguous**, and chunks are a
**covering with multiplicity** rather than a partition.

Greedy can therefore get it wrong — it can hand a long run to the only
person who could have covered a later gap, leaving that gap unfilled when a
split would have covered both. Accepted for v1: the residual surfaces as the
existing `phones_shortfall` warning, which is the same "nothing blocks,
warnings tell the truth" convention as the rest of reception.

The symptom to recognise, so a future bug report is not mistaken for a defect
in the module: **a `phones_shortfall` at a late hour, with somebody visibly
on `phones` earlier in the day who could have covered it.** That is this
trade-off working as documented, not a bug. Min-cost flow or a DP over slot
states would be optimal and are a large step up in complexity; revisit only
if real days show bad answers.

**D3 — Longest chunk first, with a one-slot tolerance band for fairness.**
Candidates are ranked on deficit slots covered, but *not* lexicographically:
a strict `(-deficit_slots, load, staff_id)` order would make fairness
vestigial, because a person available 09:00–17:00 always beats one available
09:00–12:00 for a gap starting at 09:00 regardless of load, so the same
full-time triage person would take every top-up every day and a rising
phones ratio could never overcome the first key.

Instead: take the best deficit-slot count, keep every candidate within
`COVERAGE_TOLERANCE_SLOTS = 1` of it, and pick the lowest phones load from
that shortlist, `staff_id` breaking the final tie. Chunk quality still
dominates — it decides the shortlist — but fairness can actually move the
answer. This is the same intent as front desk's weighted `W_FAIR = 6.0`
term, expressed in the shape this problem has.

Ranking is on *deficit* slots covered, not total slots: bridged slots (D4)
are a convenience, not a goal, and must not inflate a candidate's rank.

**D4 — Bridge non-deficit slots, up to two of them (one hour).** Deficits at
09:00 and 10:00 but not 09:30 give one person 09:00–10:30 rather than two
30-minute stints. The cap stops a bridge swallowing a whole afternoon of
triage; trailing bridged slots are trimmed, so a chunk always starts and
ends on a real deficit slot.

Bridged slots are part of the chunk and **are written as `phones`**: they
consume that person's triage time and push those hours above the minimum.
That is the cost of contiguity and it is intended.

**D5 — Online triage is fully sacrificial.** No minimum triage headcount,
hard or soft. Phones is the only role in reception with a minimum-staffing
concept, and introducing a second one for triage would be a new domain rule
to justify, document and edit. Strip triage to zero if that is what the
phones minimum needs.

**D6 — `online_triage` is the only source pool.** Not `other`, not `admin`.
That is what was asked for and it is the explicit, auditable version;
widening the pool later is a constant change, not a redesign.

A consequence worth stating so nobody "fixes" it: because availability is
filtered to `role == ONLINE_TRIAGE`, there is **no analogue of
`reception_front_desk._UNAVAILABLE_ROLES` here and none is needed** —
`lunch`, `not_working`, `cutteslowe` and `wolvercote` are excluded by the
role filter itself. Anyone the desk took is already `front_desk` and so is
excluded automatically too.

**D7 — `W_PHONES` in the front-desk scorer stays as it is.** It is tempting
to drop it now that shortfalls get repaired, but creating a shortfall that
must then be repaired by consuming a triage person is a real cost, not a
free one. Keep the documented relationship `W_PHONES > W_ROLE`.

**D8 — The top-up window is 08:00–18:30, wider than front desk's
08:00–18:00.** Front desk has its own narrower window because the desk is
not manned before opening or after close; phones cover is required for every
slot `min_phones_for_hour` returns non-zero for, which includes the closing
18:00–18:30 slot. That is **twenty-one** of `RECEPTION_HOURS`' twenty-two
slots — only 07:30 is exempt. The top-up module reads `RECEPTION_HOURS` and
`min_phones_for_hour`, never `FRONT_DESK_HOURS`.

**D9 — No minimum chunk length.** Front desk has `MIN_BLOCK_SLOTS = 4`
because a forty-minute stint on the desk is operationally silly. The top-up
deliberately has no equivalent: a lone 30-minute phones stint is a worse
answer than a two-hour one but a better answer than a shortfall, and the
whole point of the bridging rule (D4) is to make short chunks rare rather
than to forbid them. This is a decision, not an oversight — do not add one.

**D10 — The counters aggregate is computed once, before the front-desk
apply, and both selectors read the same object.** The router already flushes
the reset before calling `compute_role_counters`, so the day's own previous
assignments do not pollute its fairness input. The top-up must reuse that
same `RoleCounters` rather than recomputing after the desk has been applied:
recomputing would need a second flush and would fold the just-written
`front_desk` slots into the denominator, so the two selectors in one
transaction would disagree about what the day looked like.

**D11 — `note` is untouched.** The top-up overwrites `role` and leaves
`note` alone, exactly as the front-desk applier does. A stale "triage cover"
note sitting on a `phones` slot is an accepted consequence and is consistent
with the existing behaviour rather than a new wart.

**D12 — Fairness self-corrects through the top-up's own writes.** On the
first day assigned, every candidate's phones ratio may sit near zero and the
shortlist will resolve on `staff_id`. That is not a permanent bias: the
top-up writes real `phones` rows, `assignment_counter_window` reads the
preceding 29–33 days of generated sessions, so the second day sees the first
day's writes and the ratio moves. This is the answer to "won't it pick the
same person every time", and it only holds because of D3 — under a strict
lexicographic order it would not.

## Algorithm

`select_phones_blocks(rota, staff_on_leave, counters) -> list[PhonesBlock]`,
pure — no writes, no queries, the same separation as
`reception_front_desk.py`. Called by the router *after* the front-desk blocks
have been applied, so it reads the post-desk world.

1. `TOPUP_HOURS` = every hour in `RECEPTION_HOURS` with
   `min_phones_for_hour(hour) > 0` (08:00 through 18:00, twenty-one slots).
2. `deficit[h] = max(0, min_phones_for_hour(h) - phones_headcount(h))` for
   every `h` in `TOPUP_HOURS`, the headcount excluding staff on leave (the
   same exclusion `compute_coverage_issues` applies).
3. `availability[staff_id] = {h in TOPUP_HOURS : that staff has a session row
   at h with role == ONLINE_TRIAGE and is not on leave}`.
4. `load[staff_id] = phones_slots * 0.5 / hours_worked` from `counters`, with
   a zero denominator scoring `0.0` (lowest load, picked first) exactly as
   `reception_front_desk._fairness` does.
5. Loop until no fillable deficit remains:
   - `h` = the earliest hour with `deficit[h] > 0` that is not already marked
     unfillable.
   - `candidates` = every staff id available at `h`. If none, mark `h`
     unfillable and continue.
   - For each candidate, walk forward from `h`: while the next slot is in
     `TOPUP_HOURS` and in their availability, take it; a deficit slot resets
     the bridge run, a non-deficit slot increments it and stops the walk once
     `MAX_BRIDGE_SLOTS = 2` consecutive non-deficit slots have been taken.
     Then trim trailing non-deficit slots, so the chunk ends on a deficit
     slot. Every chunk starts at `h`, which has a deficit, so no chunk is
     empty.
   - Shortlist the candidates whose deficit-slot count is within
     `COVERAGE_TOLERANCE_SLOTS = 1` of the best (D3); take the minimum of the
     shortlist on `(load[staff_id], staff_id)`.
   - Emit the chunk. For every hour in it (bridged slots included) set
     `deficit[hour] = max(0, deficit[hour] - 1)` and remove that hour from
     that staff member's availability, so one person cannot count twice at
     one hour.

**Termination.** Each iteration either marks an hour permanently unfillable
(availability only ever shrinks, so an hour with no candidate now can never
gain one) or emits a chunk containing `h`, whose deficit is strictly
positive, reducing the total deficit by at least one. Both quantities are
bounded and monotone.

**Determinism.** Every tie-break ends in `staff_id`, so re-running against
unchanged data gives the same answer — the same guarantee
`select_front_desk_blocks` makes.

---

## Task 1: The selection module

### A — State of the world

Nothing has been implemented yet. This task adds the pure selection module
and its unit tests; it touches no router, no model and no frontend, and the
module is not called from anywhere until Task 2.

### B — Files and deliverables

- **New:** `backend/app/reception_phones.py` — `PhonesBlock`,
  `select_phones_blocks`, and the deficit/availability/load/walk helpers,
  with a module docstring carrying the mechanics.
- **New:** `backend/tests/test_reception_phones.py`.
- **Read for reference, do not modify:** `backend/app/reception_front_desk.py`
  (the module this one mirrors in shape), `backend/app/models/reception.py`
  (`RECEPTION_HOURS`, `min_phones_for_hour`),
  `backend/app/reception_counters.py` (`RoleCounters`, `StaffRoleCounters`),
  `backend/tests/test_reception_front_desk.py` (fixture style to copy).

### C — Instructions

Write `backend/app/reception_phones.py` as a sibling of
`reception_front_desk.py` — same conventions: `from __future__ import
annotations`, a frozen dataclass for the result, module-level constants for
every tunable, no writes, no queries, no `db` parameter.

Constants:

```python
MAX_BRIDGE_SLOTS = 2          # D4: at most one hour of bridged non-deficit slots
COVERAGE_TOLERANCE_SLOTS = 1  # D3: shortlist width before fairness decides
HOURS_PER_SLOT = 0.5
```

`TOPUP_HOURS` is derived at import from `RECEPTION_HOURS` and
`min_phones_for_hour`, not written out as literals — the window is defined by
the coverage rule (D8), and a future change to `PHONES_OPEN_HOUR` must move
it automatically.

`PhonesBlock` mirrors `FrontDeskBlock` exactly: frozen dataclass with
`staff_id`, `start_hour`, `end_hour_exclusive`, `slot_hours`. Same meaning
for `end_hour_exclusive` (the first hour *not* in the block).

`select_phones_blocks(rota: ReceptionRota, staff_on_leave: set[int],
counters: RoleCounters) -> list[PhonesBlock]` implements the algorithm above.
Return `[]` when there is no deficit or nobody on triage — never raise, never
return a partial or illegal chunk.

Helper split, all module-private except the dataclass and the entry point:

- `_phones_deficit(rota, staff_on_leave) -> dict[float, int]`
- `_triage_availability(rota, staff_on_leave) -> dict[int, set[float]]`
- `_phones_load(counters) -> dict[int, float]` — a near-copy of
  `reception_front_desk._fairness` with `PHONES` in place of `FRONT_DESK`.
  Copy it rather than generalising the original into a shared helper: two
  five-line functions that happen to agree today are cheaper to read than one
  parameterised one, and this file is deliberately independent of the
  front-desk module (it imports nothing from it).
- `_walk_chunk(start, hours_available, deficit) -> tuple[float, ...]` — the
  forward walk with bridging and trailing trim.

The module docstring must carry, in prose: what question the module answers;
that the window is `RECEPTION_HOURS` filtered by the coverage rule and why it
is wider than front desk's (D8); that greedy is knowingly suboptimal, with
the recognisable symptom named (D2); the tolerance band and why a strict
lexicographic order was rejected (D3); the bridging rule and that bridged
slots are written as `phones` (D4); that triage is fully sacrificial (D5);
that the role filter is the whole availability rule and no
`_UNAVAILABLE_ROLES` analogue is needed (D6); that there is no minimum chunk
length, deliberately (D9); and that the module performs no writes, the caller
applying the blocks.

**Tests** in `backend/tests/test_reception_phones.py`. Build rotas with the
same in-memory fixture style `test_reception_front_desk.py` uses. Cover at
minimum:

1. No deficit anywhere → `[]`.
2. A single-slot deficit filled by one candidate → one one-slot block (D9).
3. A three-slot contiguous deficit with one candidate available throughout →
   **one** block of three slots, not three blocks.
4. A three-slot deficit where no one person spans it → split across people,
   every slot still covered.
5. Bridging: deficits at 09:00 and 10:00, none at 09:30 → one block
   09:00–10:30 whose middle slot is bridged.
6. The bridge cap: a three-slot non-deficit gap is *not* bridged → two
   blocks, and neither ends on a bridged slot.
7. A deficit of 2 at one hour with two candidates → both assigned at that
   hour; with only one candidate → one assigned and the hour left one short.
8. Nobody on triage at the deficit hour → `[]`, no exception.
9. The 17:00+ requirement of 1: an hour with one person on phones at 17:00 is
   *not* a deficit, while the same headcount at 16:30 is.
10. The 18:00–18:30 closing slot is inside the window (front desk's is not),
    and 07:30 is outside it.
11. Staff on leave are excluded both from the phones headcount and from the
    candidate pool.
12. A `lunch`/`not_working`/`cutteslowe`/`wolvercote` row is not a candidate
    (it is not `online_triage`), and neither is a `front_desk` row.
13. Fairness: two candidates with identical availability, different phones
    load → the lower load wins; a zero `hours_worked` scores 0.0 and wins.
14. The tolerance band (D3): a candidate covering one fewer deficit slot but
    with a materially lower load is chosen; a candidate covering two fewer is
    not.
15. Determinism: two runs over identical input give identical output, and
    two candidates identical on every key resolve on the lower `staff_id`.
16. No staff member is assigned two blocks overlapping the same hour.

Run only `uv run pytest backend/tests/test_reception_phones.py` for this task.

---

## Task 2: The router — rename and the second step

### A — State of the world

Task 1 is complete: `backend/app/reception_phones.py` exists, is unit
tested, and is called from nowhere. This task renames the assignment endpoint
and wires the top-up in as its second step. The frontend still calls the old
URL after this task and is fixed in Task 4 — expect
`ReceptionDayPage.test.tsx` to fail in between if run.

### B — Files and deliverables

- `backend/app/api/routers/reception_rota.py` — rename
  `assign_front_desk` → `assign_rota`, route
  `/{rota_id}/front-desk` → `/{rota_id}/assign`, add the top-up step,
  extend the docstring.
- `backend/tests/test_api/test_reception_rota.py` — update every call site
  and add the new coverage below.

### C — Instructions

Rename the route and the handler. Nothing else about the endpoint's contract
changes: no request body, `ReceptionRotaOut` response, 404 on an unknown rota
and no other error status, and a day nothing could be done for is still a 200
carrying warnings.

Restructure the handler body to these steps, keeping the existing numbered
comments and adding to them:

1. **Reset** — unchanged. Every row with a non-null `displaced_role` is
   restored and the column nulled. Both assigners write that column, so one
   flat reset still covers both (D1); update the comment to say "either
   assigner" rather than "this generator".
2. **Flush, then counters** — unchanged, and now load-bearing for two
   selectors rather than one. Extend the comment with D10: this single
   `RoleCounters` is passed to both selectors deliberately, and must not be
   recomputed after step 4.
3. **Choose front desk** — unchanged.
4. **Apply front desk** — unchanged.
5. **Choose the phones top-up** — `select_phones_blocks(rota, on_leave,
   counters)`, using the *same* `counters` object from step 2. No flush is
   needed first: `rota.sessions` are live ORM objects whose roles step 4
   already changed, so the selector sees the post-desk world through the
   identity map.
6. **Apply the top-up** — for each block, for each hour, set
   `session.displaced_role = session.role` and `session.role =
   ReceptionRole.PHONES`, reusing the same `by_slot` map step 4 builds. Leave
   `note` alone (D11). Then flush, build the output, commit as now.

While here, hoist `_staff_on_leave(db, rota.date)` into a local computed once
and pass it to both selectors, rather than querying twice.

The handler docstring must be rewritten, not patched. It currently argues
that assignment is a separate endpoint from generation "(D7)" — that
reference is to the *front-desk* plan's numbering and is now stale; drop the
bare "(D7)" rather than renumbering it. The new docstring says: this is one
transaction doing reset → front desk → phones top-up; why the two steps are
one endpoint (the reset discriminator argument, D1); that generation stays a
pure template copy with its 409 semantics; and that a day where neither step
could do anything is a 200 whose issues carry `front_desk_gap` and
`phones_shortfall` warnings.

Also update the module docstring's opening paragraph, which describes the
router as "generation, editing, and coverage validation" — it now also owns
assignment.

**Tests** — update every existing `/front-desk` call in
`test_reception_rota.py` to `/assign` and rename the tests accordingly, then
add:

- A day with an obvious phones shortfall and a triage person available comes
  back with `phones` rows written over their `online_triage` rows and fewer
  `phones_shortfall` issues than before the call.
- Re-running `/assign` twice in a row is idempotent — identical rows and
  identical issues, which is what proves the shared reset covers both
  assigners.
- A manual `PATCH` of a top-up-written slot survives a later `/assign`
  (the `PATCH` nulls `displaced_role`, so reset must not touch it), mirroring
  the existing front-desk test of the same property.
- A day where the top-up can do nothing (nobody on `online_triage`) is a 200
  that still assigns the front desk normally.
- 404 on an unknown rota id still holds for the renamed route.

Run `uv run pytest backend/tests/test_api/test_reception_rota.py
backend/tests/test_reception_phones.py` for this task.

---

## Task 3: Docstring and invariant updates

### A — State of the world

Tasks 1 and 2 are complete: the module exists and the renamed `/assign`
endpoint runs both steps. Two existing docstrings now describe a world with
one assigner in it and are wrong. This task is documentation-only — no
behaviour changes, no new tests.

### B — Files and deliverables

- `backend/app/models/reception.py` — the `displaced_role` invariant on
  `ReceptionRotaSession`.
- `backend/app/reception_front_desk.py` — module docstring.
- `backend/app/api/routers/reception_rota.py` — the `min_phones_for_hour`
  reference in `compute_coverage_issues`' docstring, if it names only the
  front desk as a consumer.

### C — Instructions

In `ReceptionRotaSession`'s docstring, widen the invariant from "non-null ⇔
**the front-desk generator** wrote this slot" to "non-null ⇔ **an assigner**
wrote this slot", and say there are two of them — the front-desk step and the
phones top-up — both inside `POST /reception/rota/{id}/assign`, both setting
the column on every slot they write so that the invariant stays total and
reset stays a flat restore. The two documented consequences (a hand-tagged
role has a NULL column and survives a re-run; a manual `PATCH` clears the
column) are unchanged and still correct — do not rewrite them, only the
sentence that says which code sets the column.

In `reception_front_desk.py`'s docstring, add a short paragraph: a second
assignment step now runs immediately after this one, moving `online_triage`
staff onto `phones` to repair shortfalls — including shortfalls this module's
`W_PHONES` penalty tolerated. Say explicitly that `W_PHONES` survives that
and why (D7): a shortfall that must be repaired by consuming a triage person
is a real cost, so the documented `W_PHONES > W_ROLE` relationship still
holds and must be preserved by anyone retuning the weights.

Also check `min_phones_for_hour`'s own docstring in `models/reception.py`: it
lists its readers as `compute_coverage_issues` and `reception_front_desk`.
Add `reception_phones`.

No test changes. Run nothing beyond a lint/typecheck pass.

---

## Task 4: Frontend rename

### A — State of the world

The backend is complete: the endpoint is `POST /reception/rota/{id}/assign`
and it does both steps. The frontend still posts to `/front-desk` and will
404, so `ReceptionDayPage.test.tsx` is currently failing. This task is a
rename plus wording; no new UI, no new button, no behaviour change.

### B — Files and deliverables

- `frontend/src/api/reception.ts` — `AssignReceptionFrontDeskPayload` →
  `AssignReceptionRotaPayload`, `useAssignReceptionFrontDesk` →
  `useAssignReceptionRota`, URL → `/reception/rota/${rotaId}/assign`,
  docstring rewritten.
- `frontend/src/routes/ReceptionDayPage.tsx` — the import, the two
  `assignFrontDesk` locals (around lines 72 and 224), the `saving` guard, the
  `generateAndAssignFrontDesk` helper (around line 244) and its two call
  sites, the page docstring, and the assignment-failure message.
- `frontend/src/routes/ReceptionDayPage.test.tsx` — the six MSW handlers on
  `/front-desk` (around lines 65, 142, 326, 366, 401, 459) and the test names
  that say "front desk".

### C — Instructions

Keep the hook's existing cache behaviour exactly as it is: the response is
the whole day, so it overwrites `rotaByDate` and `rotaDetail` outright rather
than splicing. That reasoning is unchanged and the comment explaining it
should survive the rewrite — only the sentence describing *what* the endpoint
does needs replacing, with: resets whatever the assigners wrote last time,
chooses and applies a 2–3 block front-desk partition of 8:00am–6:00pm, then
tops phones up from `online_triage` where the day is below its minimum.

In `ReceptionDayPage.tsx`, rename `generateAndAssignFrontDesk` to
`generateAndAssign` and update its docstring: generating a day means "copy
the template *and* assign it", still two endpoints always chained in the same
order, still reported as two separate failures because a failed assignment
leaves a real generated day on screen. The failure message becomes something
like "The day was generated, but it could not be assigned." rather than
naming the front desk. The page docstring's closing line ("Generating…always
chains the front-desk assignment…") becomes "chains the assignment step
(front desk, then the phones top-up)".

The week-loop comment about chaining assignment onto every day rather than
only new ones is unchanged in substance — only the phrase "front desk
assignment" needs widening.

Do **not** add a button for assignment, and do not change when it runs: every
path that creates a day still chains it, and a 409 in the week loop still
skips it.

Run `npm run test -- src/routes/ReceptionDayPage.test.tsx` for this task.

---

## Task 5: Architecture doc, then delete these plans

### A — State of the world

Tasks 1–4 are complete and the feature works end to end.
`documentation/architecture-reception.md` still describes assignment as a
single front-desk step behind `POST /{id}/front-desk`. This task records the
design and removes the plans.

### B — Files and deliverables

- `documentation/architecture-reception.md` — the "Front desk assignment"
  section and the `/reception/rota` row of the endpoint table.
- **Delete:** `documentation/reception_phones_topup_plan.md` and
  `documentation/reception_phones_topup_implementation.md`.

### C — Instructions

Rename the section "Front desk assignment" to "Assignment" and add the
top-up beneath the existing front-desk paragraphs, which stay as they are
except where they name the endpoint. Follow the file's established
convention: record only what reading the code will not tell a future reader —
the reasons a shape was chosen over the obvious alternative — and do not
restate mechanics the module docstrings already carry.

What must land there:

- **D1**, with the reset-discriminator argument as the decisive one, and the
  correction that merging the endpoints saved no round trip but avoided
  adding a third call.
- **D2**, the greedy-vs-optimal trade, and the recognisable symptom of it.
  Contrast it deliberately with the front-desk section's existing
  "exhaustive enumeration, and why there is no engine here" paragraph:
  the two modules make opposite choices, and the reason is the problem shape
  (partition of a fixed window vs. a covering-with-multiplicity of a sparse
  deficit vector), not inconsistency.
- **D3**, including why the strict lexicographic order was rejected and how
  it relates to front desk's weighted `W_FAIR`, plus **D12**, the
  self-correction through the top-up's own writes.
- **D4**, **D5**, **D6** and **D9** in a short paragraph each or one combined
  one — the sacrificial-triage rule and the deliberate absence of a second
  minimum-staffing concept are the parts a future reader is most likely to
  question.
- **D7**, why `W_PHONES` survives.
- **D8**, the window difference and that it is derived from the coverage rule
  rather than declared.
- **D10**, the single shared `RoleCounters` and why recomputing between the
  steps would be wrong.

Then update the endpoint table's `/reception/rota` row: `POST
/{id}/front-desk` becomes `POST /{id}/assign`, described as "no body; reset
every assigner-written slot, then choose and apply a 2–3 block partition of
8:00am–6:00pm via `app/reception_front_desk.py`, then move `online_triage`
staff onto `phones` in contiguous chunks wherever the day is below
`min_phones_for_hour` via `app/reception_phones.py` — returns the whole day,
404 only; a day neither step can help is a 200 with `front_desk_gap` and
`phones_shortfall` warnings".

Check the two older statements elsewhere in the file that this feature
changes: the line noting "every day generated before front desk assignment
existed now carries an all-day gap warning" gains a sibling — days generated
before the top-up existed keep their `phones_shortfall` warnings until the
day is re-assigned, and freshly generated days will carry far fewer of them
because the frontend chains generate → assign. Also check the frontend
paragraph ("assignment has no button of its own") still reads correctly with
the renamed hook; it should need only the hook name changing.

Finally delete both plan files. They are superseded by the doc update, and
leaving them behind guarantees a future reader finds a stale second account
of the same design.
