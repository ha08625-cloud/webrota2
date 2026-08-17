# Implementation Plan — Reception Front Desk Assignment

Status: **implementation plan** (workflow step 2 output). Supersedes the provisional
plan of the same name; each task below is intended to be handed to its own chat.

## Plan

The reception day rota is a straight copy of the weekday master template
(`POST /reception/rota`). Add a second, separately-invoked step: choose a partition of
8:00am–6:00pm into 2 or 3 contiguous blocks at half-hour boundaries and assign one
available staff member to each, by writing `role = front_desk` onto that person's
existing `reception_rota_sessions` rows for the block's slots.

The search space is small enough to enumerate exhaustively — **50 legal partitions**
(5 two-block, 45 three-block) × at most a few hundred staff assignments each. No greedy
pass, no heuristics, no engine-style phase pipeline. The alternatives people reach for
here (fixed changeover times; greedy longest-available-first) are both worse *and* not
simpler at this size.

## Scope

**In scope:** a `displaced_role` column on `reception_rota_sessions`; a new
`backend/app/reception_front_desk.py` rule module; a `front_desk_gap` coverage check; a
`POST /reception/rota/{rota_id}/front-desk` endpoint; an "Assign front desk" action on
`ReceptionDayTab` wired into the existing "Generate week" loop; architecture docs.

**Out of scope:** any change to `reception_staff` (everyone can do front desk — no
eligibility flag), to the master template, to leave, to the counters endpoint's own
default window, to `ReceptionGrid` rendering, or to the clinical rota.

## Design Decisions

### D1 — Enumerate and score; never fail

Hard constraints (a candidate solution is discarded):

- Blocks tile 8:00–18:00 exactly — no gaps, no overlaps.
- 2 or 3 blocks.
- Each block is 4–12 slots (2–6 hours).
- The block's holder is available for **every** slot in it (see D2).
- **The same person may not hold two *adjacent* blocks.** Changed from the provisional
  plan's "nobody holds two blocks on the same day", which was too strong: morning block
  plus late-afternoon block with someone else covering the middle is a normal real-world
  outcome, and forbidding it hard can make a thin day infeasible — and infeasible means
  the desk goes unmanned, the worst outcome available. Two adjacent blocks held by one
  person are just one long block wearing a hat, so that stays forbidden. Holding two
  non-adjacent blocks is legal but carries a soft penalty (D3).

The 3–5 hour ideal is a **score, not a rule**, so an awkward day degrades gracefully — a
2.5h + 5.5h split, ranked last but still produced — instead of failing. This matches the
existing reception convention that nothing blocks: coverage produces warnings, never
errors.

Note for whoever tunes the weights: within the 3–5h ideal band there are only **6** legal
three-block shapes (3+3+4, 3+4+3, 4+3+3, 3+3.5+3.5, 3.5+3+3.5, 3.5+3.5+3) and exactly
**one** two-block shape (5+5). Ten hours over three blocks forces a 3h20 average, so the
length-deviation penalty will be firing on most three-block days rather than being a rare
tie-break. (The provisional plan said "roughly fifteen ideal shapes"; that was wrong.)

If **no** legal solution exists at all, assign nothing and emit `front_desk_gap` warnings
(D5). Never invent a partial or illegal assignment.

### D2 — Availability

A staff member is available for a slot when, on the generated day, they:

- have a `reception_rota_sessions` row for that `hour`, **and**
- have no `ReceptionLeaveEntry` for the date, **and**
- that row's role is not `lunch`, `not_working`, `cutteslowe`, or `wolvercote` (the last
  two are branch sites — they are not in the building).

An existing `front_desk` row counts as available: it is a working slot, and after the
reset step (D4) a leftover manual `front_desk` tag must not make its holder unassignable.

Lunch is what makes this problem tractable rather than what breaks it. A 1pm lunch slot
means that person cannot hold a block spanning 12:30–13:30, which naturally pushes a
changeover to the lunch boundary. Ragged finish times then only constrain the final
block, and there is normally someone who stays to close.

### D3 — Scoring

Four soft criteria only. **Recency and block-position fairness are deliberately dropped**
from the provisional plan. The rolling counter window is 29–33 days, which is already the
horizon over which rotation self-corrects: if someone has managed to avoid front desk for
a few weeks it is perfectly reasonable for them to take it several days running, and that
is exactly what the counter is for. Dropping both also keeps the module reading only the
counters aggregate and the target day — no re-deriving historical blocks from past days'
role tags, which the no-blocks-table decision (D4) would otherwise have forced.

Lower score wins. Per block, summed:

| Criterion | Formula | Starting weight |
|---|---|---|
| Length deviation | hours outside the 3–5h band | `W_LEN = 1.0` per hour |
| Fairness | holder's `front_desk_hours / hours_worked` over the window (D6) | `W_FAIR = 6.0` |
| Phones damage | hours in the block that gain a `phones_shortfall` they did not have before | `W_PHONES = 2.0` per hour |
| Role displaced | slots displacing a specialist role (anything but `phones`/`other`) | `W_ROLE = 0.5` per slot |

Plus, per solution: `W_REPEAT = 4.0` if one person holds two (non-adjacent) blocks.

Phones damage is intentionally the strongest signal, and is intentionally **soft** — with
`MIN_PHONES_STAFF = 2` and a thin day, a hard constraint could make the whole problem
infeasible and leave the desk unmanned, which is worse than a warning that already has a
UI. This mirrors current practice: the same collision exists today on the paper
spreadsheet and is tolerated there.

"Role displaced" and "phones damage" deliberately overlap on the phones case — displacing
phones is both the cheapest displacement and the thing that creates shortfalls. The
weights above are set so phones damage dominates; keep that relationship if they are
retuned.

Ties break on `(staff_id, block start hour)` so enumeration is fully deterministic and
re-running against unchanged data gives the same answer.

**Tests must pin ordering properties, not scores.** Assert "prefers the lower-counter
person, all else equal", "prefers 5+5 over 3+7", "avoids creating a phones shortfall when
an equal-cost alternative exists" — never an exact float. Otherwise every weight tweak
breaks the suite.

### D4 — Storage: overwrite the role, and remember what was overwritten

Write `role = front_desk` onto the existing `reception_rota_sessions` rows, and record the
previous role in a new nullable `displaced_role` column on the same row. No new table.

Three things already exist that make the overwrite work:

- `front_desk` is already a `ReceptionRole` value (`backend/app/models/enums.py`), so an
  assignment is a tagged slot — no enum change.
- `receptionRunContinuations` (`frontend/src/lib/receptionRuns.ts`) already renders a
  contiguous run of same-role slots as a single merged chip, so a 3-hour block *displays*
  as one block despite being six rows. No new rendering.
- `compute_role_counters` (`backend/app/reception_counters.py`) already returns
  `front_desk` slot counts and `hours_worked` over the rolling window, and its docstring
  states it exists to be the fairness input for exactly this generator.

The provisional plan proposed recovering the displaced role by re-reading the weekday
master template. **That does not work**, in three ways: it clobbers manual edits
(`front_desk` is already selectable in `RECEPTION_ROLE_LABELS`, so an admin can tag a slot
by hand and a re-run would silently delete it); there may be no template row to reset to
(sessions can be created directly on the day for a `(staff, hour)` the template has no row
for); and the template drifts, so resetting a two-week-old day restores a role that day
never had.

One nullable column fixes all three exactly, and is far cheaper than the rejected
`reception_front_desk_blocks` overlay table — no second source of truth for "what is Sam
doing at 2pm", no overlay rendering in `ReceptionGrid`, no counters change.

The invariant: **`displaced_role IS NOT NULL` ⇔ this generator wrote this slot.** From it,

- The reset step touches only rows with a non-null `displaced_role`, so manual `front_desk`
  tags survive a re-run untouched.
- Assignment always sets `displaced_role` to the pre-assignment role, *even when that role
  is already `front_desk`* — a no-op restore later, but it keeps the invariant total.
- A manual `PATCH /reception/rota/{id}/sessions/{id}` must set `displaced_role = NULL`: the
  user has overridden the slot, and a later reset must not resurrect a stale role.

Re-running assignment is therefore idempotent: reset, then assign afresh.

### D5 — Coverage: `front_desk_gap`

Add to `compute_coverage_issues`, which already runs on every read and every session
write. One warning per **contiguous uncovered range** in 8:00–18:00, not per hour — 20
per-hour warnings on top of up to 22 `phones_shortfall` would swamp the panel, and
"08:00–13:00: no front desk cover" is more useful than ten copies of the same line.

A slot is covered when at least one session at that hour has `role = front_desk` **and**
its holder is not on leave — the same leave exclusion `phones_shortfall` already applies,
because a desk assigned to someone later marked off is not covered.

This fires on every day generated before this feature ships. Accepted, but worth knowing.

### D6 — The counter window is anchored to the rota's date, not to today

`default_counter_window` returns `(monday_of(today) − 4 weeks, today)`, and
`architecture-reception.md` records the future-date exclusion as deliberate: generating a
week ahead should not pollute the counters *page* with assignments that have not happened.

That is right for the page and wrong for this generator. Generate next week on a Friday
and every day in the batch is future-dated, so when Tuesday is assigned Monday's brand-new
`front_desk` rows are outside the window and invisible — every day sees identical counters
and picks the same person, five days running.

So this module uses its own window: `from_date = monday_of(rota.date) − 4 weeks`,
`to_date = rota.date`. `compute_role_counters` itself has no notion of "today" (the
exclusion lives entirely in `default_counter_window`), so this needs no change to the
aggregation — just a second window helper beside the existing one. Assignment also becomes
reproducible: re-running in a month against unchanged data gives the same answer.

**Fairness is a proportion, not a raw count.** The provisional plan said "`front_desk`
slot count, lowest first". Raw counts structurally favour part-timers — someone in two
days a week always has a lower count than someone in five, so they would win the tie-break
every day they are in. Use `front_desk_hours / hours_worked`, the same ratio
`lib/receptionWeightedScore.ts` already renders on the counters page, so the two surfaces
agree on what "least front desk" means. A zero denominator (new starter, or nobody
generated in the window) scores `0.0` — lowest load, picked first — mirroring that file's
"no data" rule.

### D7 — API surface

`POST /reception/rota/{rota_id}/front-desk`, a separate endpoint, not a step folded into
`POST /reception/rota`. Generation stays a pure template copy with its 409 semantics
intact, and assignment can be re-run without the delete-then-regenerate dance.

Returns `ReceptionRotaOut` (the full day plus freshly recomputed `issues`), since a
successful assignment rewrites many rows at once and the page should just take the new
state. 404 on an unknown rota; no other error status — an unsolvable day is a 200 with
`front_desk_gap` warnings.

The selection logic lives in `backend/app/reception_front_desk.py`, called by the router —
the same separation as `reception_counters.py`, so the rule is unit-testable without HTTP.

### D8 — Assumptions still standing

1. Front desk cover is expected for the whole 8:00–18:00 window every weekday, with no
   per-day variation. Note this is narrower than the rota's own 7:30am–6:30pm: 6:00–6:30pm
   is deliberately uncovered.
2. Blocks may displace any working role, not only `phones`. Restricting candidate slots to
   `phones` would be a hard constraint that could easily make some days unsolvable;
   displacing a specialist is a soft penalty instead, so it happens only when nothing
   better exists.

---

## Task 1: Data model changes

**A.** Nothing has been built yet; this is the first task. Deliverable: the
`displaced_role` column and its migration, so later tasks have somewhere to record the
role an assignment overwrote (D4).

**B.** Files:

- `backend/app/models/reception.py` — `ReceptionRotaSession`
- `backend/alembic/versions/006_reception_displaced_role.py` (new)
- `backend/app/api/routers/reception_rota.py` — `patch_session` only
- `backend/tests/test_models.py`

**C.** Instructions:

1. Add to `ReceptionRotaSession`:
   ```python
   displaced_role: Mapped[ReceptionRole | None] = mapped_column(
       enum_col(ReceptionRole), nullable=True, default=None
   )
   ```
   Document the D4 invariant in the class docstring: non-null ⇔ the front-desk generator
   wrote this slot, and it holds the role that was there before. Do **not** add the column
   to `ReceptionMasterSession` — the template has no assignments.
2. Do **not** expose it in `ReceptionRotaSessionOut` or any other schema. It is internal
   bookkeeping; the frontend neither needs nor should see it.
3. New migration `006`, `down_revision = "005"`. Only Postgres needs it (CI runs
   `alembic upgrade head` / `downgrade base` against Postgres; the test suite builds SQLite
   via `create_all` from the models). Follow `004`/`005`'s dialect-branching style. Upgrade
   is `op.add_column` with the **existing** `reception_role` type —
   `postgresql.ENUM(..., create_type=False)`, as `005` does for `Day` — so it does not try
   to `CREATE TYPE` a second time. Downgrade drops the column.
4. In `patch_session`, set `session.displaced_role = None` alongside the `role`/`note`
   assignment, and say why in the docstring: a manual edit overrides the generator, and a
   later reset must not resurrect a stale role.
5. Tests: the column defaults to `None` on a plain insert; a round-trip stores and reads
   back a `ReceptionRole`.

## Task 2: Counter window helper

**A.** Task 1 (the `displaced_role` column) is complete. Deliverable: the rota-date-anchored
counter window the rule module will use as its fairness input (D6).

**B.** Files:

- `backend/app/reception_counters.py`
- `backend/tests/test_reception_counters.py`

**C.** Instructions:

1. Add beside `default_counter_window`:
   ```python
   def assignment_counter_window(rota_date: datetime.date) -> tuple[datetime.date, datetime.date]:
   ```
   returning `(monday_of(rota_date) - 4 weeks, rota_date)`.
2. Its docstring must state the whole of D6 — why the page's window is wrong here (a
   week generated ahead of today is invisible to `default_counter_window`, so every day in
   the batch would see identical counters and pick the same person), and that anchoring to
   the rota's date also makes assignment reproducible.
3. Change nothing in `compute_role_counters`. It already has no notion of "today"; the
   future-date exclusion lives entirely in `default_counter_window` and must stay there so
   `GET /reception/counters` is unaffected.
4. Tests: window bounds on a Monday, a Friday, and across a month boundary; and that
   `compute_role_counters` over an assignment window picks up a future-dated generated day
   that `default_counter_window` excludes.

## Task 3: The rule module

**A.** Tasks 1–2 are complete: `reception_rota_sessions.displaced_role` exists, and
`assignment_counter_window` gives the fairness window. Deliverable: the whole selection
rule, unit-tested without HTTP.

**B.** Files:

- `backend/app/reception_front_desk.py` (new)
- `backend/tests/test_reception_front_desk.py` (new)

**C.** Instructions:

1. Constants: `FRONT_DESK_FIRST_HOUR = 8.0`, `FRONT_DESK_LAST_HOUR = 17.5`,
   `FRONT_DESK_HOURS` (20 slots), `MIN_BLOCK_SLOTS = 4`, `MAX_BLOCK_SLOTS = 12`,
   `IDEAL_MIN_SLOTS = 6`, `IDEAL_MAX_SLOTS = 10`, and the five weights from D3. Note in the
   module docstring that this window is narrower than `RECEPTION_HOURS` and why (D8.1).
2. `_UNAVAILABLE_ROLES = {LUNCH, NOT_WORKING, CUTTESLOWE, WOLVERCOTE}` (D2). Build
   per-staff availability as a set (or bitmask) of covered slot indices from the rota's
   sessions, excluding staff on leave for the date.
3. Enumerate partitions: compositions of 20 slots into 2 or 3 parts, each in
   `[MIN_BLOCK_SLOTS, MAX_BLOCK_SLOTS]`. Assert in a test that this yields exactly 50.
4. For each partition, compute each block's candidate set (staff available for *every*
   slot). A block with no candidates discards the partition. Then enumerate assignments
   across blocks, discarding any where the same person holds **adjacent** blocks (D1).
5. Score per D3 and return the best. Public entry point takes the loaded rota, the staff
   on leave, and the counters, and returns a result dataclass —
   `list[FrontDeskBlock(staff_id, start_hour, end_hour_exclusive, slot_hours)]`, empty when
   nothing is legal. It performs **no writes**; the router applies them.
6. Phones damage must be computed against the pre-assignment phones headcount per hour, so
   it counts hours the assignment *newly* pushes below `MIN_PHONES_STAFF` — an hour already
   short before assignment is not this block's fault.
7. Tests: the 50-partition count; availability excludes lunch/leave/branch-site slots and
   absent rows; an existing `front_desk` row still counts as available; an unsolvable day
   returns an empty list rather than raising; the ordering properties from D3 (lower
   proportion wins, 5+5 beats 3+7, phones-preserving beats phones-damaging, adjacent
   double-holding is rejected while non-adjacent is merely penalised); determinism on a
   symmetric input.

## Task 4: Coverage check

**A.** Tasks 1–3 are complete: the rule module can choose blocks, nothing writes them yet.
Deliverable: `front_desk_gap` warnings (D5).

**B.** Files:

- `backend/app/models/reception.py` — a `format_hour_range` helper beside `format_hour`
- `backend/app/api/routers/reception_rota.py` — `compute_coverage_issues`
- `backend/tests/test_api/test_reception_rota.py`

**C.** Instructions:

1. Add `format_hour_range(start: float, end_exclusive: float) -> str` next to
   `format_hour`, producing e.g. `"08:00-13:00"`. Server-rendered only — the frontend
   needs no mirror, unlike `format_hour`/`formatHour`.
2. In `compute_coverage_issues`, after the existing phones loop, walk
   `FRONT_DESK_HOURS` and collect contiguous runs with no `front_desk` holder whose holder
   is not on leave. Emit one issue per run: `severity="warning"`, `phase="coverage"`,
   `check="front_desk_gap"`, message `f"{format_hour_range(...)}: no front desk cover"`,
   `day=day`. Reuse the already-computed `on_leave` set and `rota.sessions` — no new query.
3. Note in the docstring that this fires on every day generated before the feature existed.
4. Tests: a fully covered day emits none; a day with no `front_desk` at all emits exactly
   one issue spanning 08:00–18:00; two gaps either side of a covered middle emit two; a
   covered day whose holder is on leave emits the gap.

## Task 5: The endpoint

**A.** Tasks 1–4 are complete: column, window, rule module, and coverage check all exist.
Deliverable: the endpoint that applies an assignment.

**B.** Files:

- `backend/app/api/routers/reception_rota.py`
- `backend/tests/test_api/test_reception_rota.py`

**C.** Instructions:

1. `POST /{rota_id}/front-desk`, `response_model=ReceptionRotaOut`, status 200. No request
   body. 404 on unknown rota; no other error status (D7).
2. Order of operations matters and must be commented:
   1. **Reset**: for every session on the rota with `displaced_role IS NOT NULL`, set
      `role = displaced_role`, `displaced_role = None`. `db.flush()`.
   2. **Read counters**: `compute_role_counters(db, *assignment_counter_window(rota.date))`.
      This must come *after* the flush, so the day's own just-reset front-desk slots do not
      count toward the fairness input.
   3. **Choose**: call the rule module.
   4. **Apply**: for each block, for each of its slots, find that staff member's session
      and set `displaced_role = session.role` (always, even if it is already `front_desk` —
      D4's invariant is total) then `role = ReceptionRole.FRONT_DESK`.
   5. Recompute issues via `_rota_out`, commit, return.
3. An empty block list means the reset still stands and nothing is assigned — the day comes
   back with `front_desk_gap` warnings. This is the documented outcome, not an error.
4. Tests: assignment tiles 08:00–18:00 and clears the gap warnings; the response carries
   the rewritten sessions; re-running twice is idempotent (identical roles, no accumulated
   `displaced_role` drift); a manual `front_desk` tag with `displaced_role IS NULL` survives
   a re-run; a `PATCH` after assignment clears `displaced_role` and that slot is then left
   alone by the next re-run; an unsolvable day returns 200 with gaps; unknown rota is 404.

## Task 6: Frontend

**A.** Tasks 1–5 are complete: the backend endpoint works end to end. Deliverable: a way to
invoke it, per day and as part of "Generate week".

**B.** Files:

- `frontend/src/api/reception.ts`
- `frontend/src/routes/ReceptionDayPage.tsx`
- `frontend/src/routes/ReceptionDayPage.test.tsx`

**C.** Instructions:

1. Add `useAssignReceptionFrontDesk()` taking `{ rotaId, date }`, POSTing to
   `/reception/rota/${rotaId}/front-desk`, and on success writing the returned
   `ReceptionRota` into both `receptionKeys.rotaByDate(date)` and
   `receptionKeys.rotaDetail(rota_id)` — the same pattern as `useGenerateReceptionRota`.
   Not a splice: the response is the whole day.
2. On `ReceptionDayTab`, add an "Assign front desk" button beside "Regenerate", gated by
   `writeGate` and disabled while `saving`. Fold the mutation's `isPending` into `saving`
   so the grid is disabled during the write. Errors go to the existing `actionError` banner.
3. In `handleGenerateWeek`, call the assign mutation after each **successful** generate,
   using the `rota_id` from the generate response. Deliberately **not** after a 409: a 409
   means the day already existed and presumably already has its desk assigned, and
   reshuffling an existing day is not what the button promises. Say so in the comment next
   to the existing 409 skip. Treat an assign failure like a generate failure — collect it
   into `failures`.
4. No `ReceptionGrid` changes. `front_desk` already renders via `RECEPTION_ROLE_LABELS` and
   contiguous slots already merge via `receptionRunContinuations`.
5. Tests: the button calls the endpoint and the grid repaints from the response; the week
   loop assigns for a freshly generated day and skips a 409 day; an assign error surfaces in
   the banner.

## Task 7: Documentation

**A.** Tasks 1–6 are complete and the feature works. Deliverable: the architecture record.

**B.** Files:

- `documentation/architecture-reception.md`

**C.** Add a "Front desk assignment" section recording only what the code will not tell a
reader on its own:

- Enumerate-and-score over 50 partitions, and why no greedy pass or phase pipeline (D1).
- The 3–5h band is a score not a rule, and the ideal band admits only 6 three-block shapes,
  so the deviation penalty fires routinely (D1).
- Overwrite-the-role plus `displaced_role`, and the three concrete ways the
  reset-from-template alternative fails (D4). Include the invariant and the reason `PATCH`
  nulls the column.
- Why the blocks table was rejected (D4).
- Why this generator uses its own counter window while the counters page keeps
  `default_counter_window` (D6) — the week-ahead-batch failure is the whole reason.
- Fairness is a proportion, not a raw count, and why (part-timers) (D6).
- Adjacent-only double-holding rule, and why the stronger rule was dropped (D1).
- Phones damage stays soft, matching current paper practice (D3).
- `front_desk_gap` aggregates into ranges and fires on every pre-existing day (D5).

Also update the router-surface table with `POST /reception/rota/{rota_id}/front-desk`.
