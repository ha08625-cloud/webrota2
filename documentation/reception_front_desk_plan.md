# Provisional Plan — Reception Front Desk Assignment

Status: **provisional** (workflow step 1 output). Not yet reviewed or expanded into an
implementation plan.

## Problem

The reception day rota is currently a straight copy of the weekday master template
(`POST /reception/rota`). We want a second step: assign a named staff member to the
front desk for the day.

The awkwardness is granularity. The rota is stored as half-hourly slots, but nobody
should move every half hour; at the same time staff finish at ragged times (3pm, 4pm,
5:30pm), so the day cannot be cut into fixed sessions. The target is the front desk
manned by one person at a time in stretches of roughly 3–5 hours — the day divided into
two or three blocks.

## Answers that shape the design

- Desk cover window: **8:00am–6:00pm** (20 half-hour slots, `hour` 8.0 … 17.5).
  Narrower than the rota's own 7:30am–6:30pm.
- **Everyone** can do front desk — no eligibility flag, no schema change to
  `reception_staff`.
- Front desk is **exclusive**: the assigned person's role for those slots switches to
  `front_desk`, so they stop counting toward phones coverage.
- **Mix it up** across consecutive days; continuity (same person, same block, all week)
  is not wanted.
- Changeover times need not be round hours.

## Reframing

Not "divide the day into sessions", but: **choose a partition of 8:00–6:00 into 2 or 3
contiguous blocks at half-hour boundaries, and assign one available person to each
block.** The half-hour grid is only the resolution at which a boundary may fall; the
block is the unit of work, so nobody moves every half hour.

The search space is small enough to enumerate exhaustively:

- 20 slots. Two blocks = one interior boundary; three blocks = two.
- With hard length bounds of 2–6 hours (4–12 slots), that is ~5 two-block partitions and
  a few dozen three-block partitions.
- Within the ideal 3–5h band, the only legal two-block split is exactly **5h + 5h**;
  three-block splits have roughly fifteen ideal shapes (3+3.5+3.5, 3+4+3, 3.5+3+3.5, …).
- Multiply by candidate staff per block (≤ ~10 staff, ≤ 3 blocks) and the worst case is
  tens of thousands of combinations — milliseconds, brute force.

**Design decision: enumerate every legal partition and score it. No greedy pass, no
heuristics, no engine-style phase pipeline.** The alternatives people reach for here
(fixed changeover times; greedy longest-available-first) are both worse *and* not
simpler, given the space is this small.

## Availability

A staff member is available for a slot when, on the generated day, they:

- have a `reception_rota_sessions` row for that `hour`, and
- have no `ReceptionLeaveEntry` for the date, and
- that row's role is not `lunch`, `not_working`, `cutteslowe`, or `wolvercote`
  (the last two are branch sites — they are not in the building).

A block is legal for a person only if they are available for **every** slot in it.

Note that lunch is what makes this problem tractable rather than what breaks it. A 1pm
lunch slot means that person cannot hold a block spanning 12:30–13:30, which naturally
pushes a changeover to the lunch boundary. Ragged finish times then only constrain the
final block, and there is normally someone who stays to close.

## Hard vs soft constraints

**Hard** (a candidate solution is discarded):

- Every block's holder is available for all of its slots (above).
- Blocks tile 8:00–18:00 exactly — no gaps, no overlaps.
- 2 or 3 blocks.
- Each block is between 2 and 6 hours.
- Nobody holds two blocks on the same day.

**Soft** (scored; weights to be fixed at implementation-plan stage):

- Deviation of each block from the 3–5 hour ideal.
- Fairness: the holder's `front_desk` slot count over the rolling counter window
  (`compute_role_counters`), lowest first.
- Recency: penalise anyone who held front desk on the immediately preceding generated
  days, satisfying "mix it up".
- Phones damage: penalise a block that creates a `phones_shortfall` hour that did not
  exist before the assignment.
- Role displaced: prefer overwriting `phones` over overwriting a specialist role
  (`prescriptions`, `registrations`, `online_triage`, `rotas`, `admin`, `tasks`).
- Block position fairness: penalise always giving the same person the early block.

Making 3–5 hours a *score* rather than a rule means an awkward day degrades gracefully —
a 2.5h + 5.5h split, ranked last but still produced — instead of failing. That matches
the existing convention that nothing in reception blocks: coverage produces warnings,
never errors.

If **no** legal solution exists at all, assign nothing and emit a `front_desk_gap`
warning per uncovered hour, exactly parallel to `phones_shortfall`. Never invent a
partial or illegal assignment.

## Storage: overwrite the role on existing rows

**Decision: write `role = front_desk` onto the existing `reception_rota_sessions` rows.
No new table.**

This works because three things already exist:

- `front_desk` is already a `ReceptionRole` value (`backend/app/models/enums.py`), so an
  assignment is a tagged slot — no enum change, no migration.
- `receptionRunContinuations` (`frontend/src/lib/receptionRuns.ts`) already renders a
  contiguous run of same-role slots as a single merged chip, so a 3-hour block *displays*
  as one block despite being six rows. No new rendering.
- `compute_role_counters` (`backend/app/reception_counters.py`) already returns
  `front_desk` slot counts over the rolling window, and its docstring states it exists to
  be the fairness input for exactly this generator.

Cost: the displaced role (usually `phones`) is not stored anywhere. That is recoverable
without extra storage — the weekday master template *is* the source, so re-running
assignment first resets every currently-`front_desk` slot to its `(day, hour)` template
role, then assigns afresh. Idempotent, with nothing new persisted.

Rejected alternative: a `reception_front_desk_blocks(rota_id, staff_id, start_hour,
end_hour)` table rendered as an overlay. It makes blocks first-class and preserves the
underlying role, but introduces a second source of truth for "what is Sam doing at 2pm",
needs overlay rendering in `ReceptionGrid`, and needs the counters query taught about it.
Given this codebase's consistent bias against tables that do not earn themselves, it does
not.

## API surface

**Decision: a separate endpoint, `POST /reception/rota/{rota_id}/front-desk`**, not a
step folded into `POST /reception/rota`.

- Generation stays a pure template copy with its 409 semantics intact.
- Assignment can be re-run without the delete-then-regenerate dance.
- "Generate week" on `ReceptionDayPage` is a client-side per-day loop already; it calls
  the new endpoint per day after each successful generate.
- Returns `ReceptionRotaOut` (the full day plus freshly recomputed `issues`), since a
  successful assignment rewrites many rows at once and the page should just take the new
  state.

The selection logic itself lives in a new `backend/app/reception_front_desk.py`, called by
the router — the same separation as `reception_counters.py`, so the rule is unit-testable
without HTTP.

## Assumptions made (flag on review)

1. **A phones shortfall caused by the assignment is a soft penalty, not a hard block.**
   With `MIN_PHONES_STAFF = 2` and a thin day, a hard constraint could make the whole
   problem infeasible and leave the desk unmanned — worse than a warning that already has
   a UI. If you would rather the desk go unmanned than drop below two on phones, this
   flips to hard.
2. **Blocks may displace any working role, not only `phones`.** Restricting candidate
   slots to those tagged `phones` would be a hard constraint that could easily make some
   days unsolvable. Displacing a specialist role is instead a soft penalty, so it happens
   only when nothing better exists.
3. Front desk coverage is expected for the whole 8:00–18:00 window every weekday, with no
   per-day variation.

## Implementation outline (to be expanded into tasks at step 2)

- **Backend rule module** — `backend/app/reception_front_desk.py`: window constants,
  availability derivation, exhaustive partition enumeration, scoring, result dataclass.
- **Coverage** — add a `front_desk_gap` check to `compute_coverage_issues`
  (`backend/app/api/routers/reception_rota.py`), warning per hour in 8:00–18:00 with no
  `front_desk` holder. Note this fires on every day generated before this feature exists,
  which is acceptable but worth knowing.
- **Router** — `POST /reception/rota/{rota_id}/front-desk` in the same router; reset
  existing `front_desk` rows from the template, apply the chosen assignment, recompute
  issues, return `ReceptionRotaOut`.
- **Frontend** — an "Assign front desk" action on `ReceptionDayTab`
  (`frontend/src/routes/ReceptionDayPage.tsx`) plus the API call in
  `frontend/src/api/reception.ts`; hook it into the existing "Generate week" loop. No grid
  changes — `front_desk` already renders and already merges.
- **Docs** — a new section in `documentation/architecture-reception.md` recording the
  enumerate-and-score decision, the overwrite-vs-blocks-table trade-off, and the
  template-reset idempotency rule.
