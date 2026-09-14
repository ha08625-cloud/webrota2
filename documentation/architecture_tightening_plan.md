# Provisional Plan — Architecture tightening before the next modules

**Status: provisional.** This is the output of a discussion chat, not an
implementation plan. It needs review and expansion (step 2 of the workflow in
CLAUDE.md) before any task here is handed to an implementation chat. Task
sizing below is a guess; the file lists are indicative, not verified
exhaustively.

## Plan

The system is live and two more sections are planned (Research, Trainee
Induction), with more after that. This plan does the work that makes adding
those sections safe, and deliberately does **not** do a domain-first
repackaging of the existing code.

The reasoning, from an audit of the current tree:

- The domains are already decoupled **in substance**. Reception code imports
  nothing from `engine/`, `models/doctor.py` or `models/rota.py` except one
  constant. Clinical code contains zero references to reception. There are no
  cross-domain FKs between `Doctor` and `ReceptionStaff`. The frontend already
  has one self-contained shell per section with no shared routes, components
  or nav items.
- The permission model is already generic. `models/permissions.py` holds
  string-keyed permissions in a `MutableDict(JSON)` column; the research plan
  confirms the payoff — adding a `research` area is a one-line change to
  `AREA_KEYS` with **no migration**.
- What is missing is **enforcement**. The boundaries hold because of author
  discipline, not because anything fails a build. There is no `ruff`, no
  `mypy`, no `eslint` and no import linting in `ci.yml` at all. One careless
  `from ...engine.datatypes import ...` in a research router and the boundary
  is gone silently.

So the value here is in codifying the boundaries that already exist, not in
moving existing files to match a textbook diagram. Directory shape is the
cheapest and least valuable part of a modular monolith, and a wholesale
repackaging of live, well-tested code is a large all-at-once change with high
regression risk and zero user-visible benefit.

## Scope

**In scope**

1. Extract the one genuine cross-domain import so a boundary contract can pass.
2. Add `import-linter` to CI with contracts that forbid cross-domain imports.
3. Move the three loose reception helper modules into an `app/reception/`
   package — a pure move, no logic changes.
4. Write down the convention for new modules, and amend the research plan to
   follow it before it is implemented.
5. Split `api/routers/rota.py` (970 lines) and `api/routers/staging.py`
   (850 lines) — **optional / deferred**, see Decision 6.

**Out of scope, with reasons**

- **Domain-first repackaging of clinical.** ~600 lines of architecture doc,
  the most complex thing in the repo, heavily tested. Repackaging earns
  nothing that the import contracts don't already give, and risks a lot.
- **Per-module Alembic migration streams.** One database, one migration chain.
  Branched heads across five modules buys nothing for a single-DB app and
  costs permanent "multiple heads" pain.
- **Restructuring reception's logic to match the clinical phase pipeline.**
  Clinical rota generation is a real constraint-satisfaction problem;
  reception phone/desk coverage is not. `reception_front_desk.py` is 366 lines
  because the problem is 366 lines big. A phased pipeline there would be
  ceremony. Proportionality is correct, not inconsistent.
- **Any change to the permission model.** It is already the shape a reviewer
  would ask for.
- **Frontend restructuring into `src/features/*`.** The shells already give
  the isolation this would buy. Revisit only if a *new* section's pages
  genuinely need co-location — see Decision 5.
- **`mypy`.** Adding gradual typing to 23k lines of untyped-in-places live
  code is its own multi-week project with its own plan.
- **`users.doctor_id` / `users.reception_staff_id`.** These are real
  cross-domain FKs on the identity table, and in principle a reviewer is right
  to flag them. But the rationale in `models/user.py` is sound (the link is a
  privilege grant, gated by `user_admin`, not by the domain's permission), and
  two columns is fine. Revisit if Research and Induction each want one and it
  becomes five. See Decision 7.

## Design Decisions

**1. Contracts are `forbidden`, not `layers`.**
`import-linter`'s `layers` contract wants one package per layer. We don't have
that — `app/models/` is a single flat package holding clinical, reception and
identity models together, so no layered contract can distinguish them without
the repackaging we're explicitly not doing. Use `forbidden` contracts naming
module sets instead: "the reception modules must not import the clinical
modules", and vice versa. This works at today's module granularity and
tightens naturally into a `layers` contract if modules ever do become
packages. *To verify at implementation time: whether the installed
import-linter version supports `*` wildcards in `forbidden` module
expressions; if not, the module lists are written out longhand.*

**2. Shared-kernel modules are named explicitly, not discovered.**
Some modules are legitimately shared by every domain: `database.py`,
`models/enums.py`, `models/user.py`, `models/permissions.py`, `api/deps.py`,
`email.py`, `api/audit.py`. These are the shared kernel. The contracts must
permit any domain to import them, and the convention doc must say that adding
to this list is a decision, not a convenience — an ever-growing shared kernel
is how a modular monolith quietly becomes a layered one.

**3. `DAY_ORDER` moves out of the clinical engine.**
It is the one real boundary violation, and it blocks Decision 1. Today
`app/api/routers/reception_rota.py` and `app/api/routers/reception_master.py`
import `DAY_ORDER` from `app/engine/week_map.py` — reception reaching into the
clinical engine for a dict that is really just "the weekday order of the `Day`
enum". It belongs next to `Day` itself, in `models/enums.py`, or in a small
`app/shared/days.py`. `models/enums.py` is the better home: `DAY_ORDER` is a
property of the enum, it needs no new module, and `models/enums.py` is already
shared-kernel by Decision 2. `engine/week_map.py` keeps importing it and
re-exporting via `engine/__init__.py` so no clinical call site changes.

**4. The reception move is a pure move, in its own PR, with no logic changes.**
`reception_counters.py`, `reception_front_desk.py` and `reception_phones.py`
go to `app/reception/{counters,front_desk,phones}.py`. The point is not purity
— it is that `app/` is becoming a junk drawer (it also holds
`leave_charging.py`, `leave_entitlement.py`, `doctor_window.py`,
`master_template.py`, `calendar_feed.py`), and at five or six sections you
won't be able to tell what belongs to what. Doing it as a move-only PR means
CI proves it safe. **Note for the implementation chat:** these three modules
are named in *prose* in at least `models/reception.py`,
`api/schemas/reception.py`, `api/routers/reception_counters.py` and
`tests/test_api/test_reception_counters.py` docstrings, plus
`documentation/architecture-reception.md`. The grep must cover comments and
docs, not just import statements. Clinical's loose files are **not** moved in
this plan — same junk-drawer argument applies, but they are more numerous and
more entangled, and one demonstrated move is enough to establish the pattern.

**5. New modules are built domain-first from day one; old modules are not
retrofitted.** Let the new pattern demonstrate itself on Research before
committing to it everywhere. If after Research and Induction the domain-first
shape is clearly better to work in, retrofitting reception is then a small,
evidence-backed decision rather than a leap of faith. If it isn't clearly
better, we've saved ourselves a large pointless refactor. The frontend gets
the same treatment: Research's pages go in `src/features/research/`, existing
sections stay where they are.

**6. The router splits are deferred, not scheduled.**
`rota.py` at 970 lines and `staging.py` at 850 are the codebase's largest
genuine maintainability problem — and they are unrelated to modularity, which
is why they sit last here and may be dropped from this plan entirely. Splitting
them is best done opportunistically, the next time a ticket touches them, not
as standalone churn on live endpoints. Listed for completeness; recommend
deferring.

**7. No speculative generalisation of the identity link.**
Do not build a `module_identities` link table now. Two nullable FKs work, and
the shape the third module actually needs isn't known until it exists — the
Research plan's `Owner` field is already a plain nullable FK to `users`, which
is a *different* relationship from `doctor_id`/`reception_staff_id` (who this
login *is* on a rota). Guessing the abstraction now is likely to guess wrong.

**8. `ruff` is scoped narrowly or dropped.**
Adding a linter to 23k lines with no prior linting produces a large
style-churn diff across live code. The value is real but small, and it is not
what this plan is for. If included at all, enable only rules that catch
*correctness or boundary* problems (unused imports, undefined names, the
`TID252` relative-import family) with formatting rules off, and treat it as
strictly optional. Same reasoning for `eslint` on the frontend, which also has
none. **Recommend: ship the import contracts without ruff, and let ruff be its
own small ticket.** The discussion that produced this plan cited "no ruff, no
mypy" as *evidence* that nothing is enforced — not as a recommendation to
adopt both.

---

## Task 1: Extract `DAY_ORDER` to the shared kernel

**A. State of the world.** Nothing has been done yet. This is the first task
and it unblocks Task 2 — the boundary contracts cannot pass while two
reception routers import from `app/engine/`.

**B. Files.**
- `backend/app/models/enums.py` — new home for `DAY_ORDER`
- `backend/app/engine/week_map.py` — import it from there instead of defining it
- `backend/app/engine/__init__.py` — keeps re-exporting `DAY_ORDER` unchanged
- `backend/app/api/routers/reception_rota.py` — import from `models.enums`
- `backend/app/api/routers/reception_master.py` — import from `models.enums`
- `backend/app/api/routers/recurring_notes.py` — clinical; may stay on the
  engine re-export or move, decide at review
- `backend/app/master_template.py` — same
- `backend/app/engine/context.py` — same
- `backend/tests/test_week_map.py` — may reference the definition site

**C. Deliverable.** `DAY_ORDER` defined once, in `models/enums.py`, beside the
`Day` enum it orders. No reception module imports anything from `app.engine`.
No clinical call site needs to change (the `engine/__init__.py` re-export
stays). Existing tests pass unchanged.

## Task 2: Add `import-linter` contracts to CI

**A. State of the world.** Task 1 is done, so no cross-domain imports remain.
This task makes that property permanent.

**B. Files.**
- `backend/pyproject.toml` — `import-linter` in the `dev` extra; contracts in
  `[tool.importlinter]` and `[[tool.importlinter.contracts]]`
- `.github/workflows/ci.yml` — a `lint-imports` step in the existing `test`
  job (not a new job; it shares the `uv sync --extra dev` install and is
  fast). Note the `gate` job already short-circuits docs-only changes, so
  nothing extra is needed there.
- `documentation/architecture.md` — a short subsection recording the contracts
  and the shared-kernel list

**C. Deliverable.** Contracts that fail CI on: reception importing clinical,
clinical importing reception, either importing documents, and anything
importing a domain from the shared kernel. The shared-kernel allowlist
(Decision 2) is written down with the note that adding to it is a decision.
Verify the contracts actually bite by temporarily adding a forbidden import
locally and confirming `lint-imports` fails — a contract that passes because
its module expressions match nothing is worse than no contract, and this is
the single most likely way for this task to be silently useless.

## Task 3: Move the reception helpers into `app/reception/`

**A. State of the world.** Tasks 1–2 are done and the boundaries are enforced.
This task tidies the one domain small enough to move safely, and proves the
contracts survive a repackaging.

**B. Files.**
- `backend/app/reception_counters.py` → `backend/app/reception/counters.py`
- `backend/app/reception_front_desk.py` → `backend/app/reception/front_desk.py`
- `backend/app/reception_phones.py` → `backend/app/reception/phones.py`
- `backend/app/reception/__init__.py` — new; re-export the names the routers use
- `backend/app/api/routers/reception_rota.py`, `reception_counters.py` — imports
- `backend/tests/test_reception_counters.py`, `test_reception_front_desk.py`,
  `test_reception_phones.py` — imports (consider a `tests/test_reception/`
  package to match, decide at review)
- `backend/app/api/schemas/reception.py`, `backend/app/models/reception.py`,
  `backend/tests/test_api/test_reception_counters.py` — **prose references** in
  docstrings
- `documentation/architecture-reception.md` — path references
- `backend/pyproject.toml` — check `[tool.hatch.build.targets.wheel]`
  `packages = ["app"]` still picks up the new subpackage (it should)

**C. Deliverable.** No `reception_*.py` at the top of `app/`. No logic changes
in the diff at all — if a reviewer sees anything but moves, renames and import
updates, it belongs in a different PR. Import contracts updated to the new
module names and still failing on a deliberate violation. Full backend suite
green.

## Task 4: Write the new-module convention, and amend the research plan

**A. State of the world.** Tasks 1–3 are done. The boundaries are enforced and
reception demonstrates the package shape. This task makes sure Research is
built the new way rather than adding to the old layout.

**B. Files.**
- `documentation/architecture.md` — a new "Adding a module" section
- `documentation/research_section_plan.md` — amend the file lists

**C. Deliverable.** A convention section stating: a new module is a package
(`app/<module>/` holding its own `models.py`, `router.py`, `schemas.py`,
`service.py`), it may import only the shared kernel and its own internals, it
registers in `_AREA` in `api/main.py` and `AREA_KEYS` in `models/permissions.py`,
its models are imported in `models/__init__.py` so `create_all` sees them, it
shares the single Alembic chain, and its frontend lives in
`src/features/<module>/` behind its own shell.

Then amend `research_section_plan.md`, which currently follows the *old*
layout — it puts models in `backend/app/models/study.py`, the router in
`backend/app/api/routers/research.py` and schemas in
`backend/app/api/schemas/research.py`, while also creating
`backend/app/research/catalogue.py`. That hybrid is the thing to fix, and it is
cheaper to fix in the plan than in the code. Two constraints survive the
amendment and must be called out: `models/__init__.py` must still import the
new models (`create_all` depends on it), and the permission wiring in
`models/permissions.py`, `api/deps.py`, `api/schemas/auth.py` and
`api/main.py` is unchanged — those are shared kernel and the research plan
already gets them right.

## Task 5 *(optional, recommend deferring)*: Split the two oversized routers

**A. State of the world.** Tasks 1–4 are done. This is unrelated to
modularity and is listed only because it is the largest real maintainability
problem in the backend. See Decision 6 — the recommendation is to drop this
from the plan and do it opportunistically instead.

**B. Files.** `backend/app/api/routers/rota.py` (970 lines),
`backend/app/api/routers/staging.py` (850 lines), and their tests.

**C. Deliverable.** If done: each split into cohesive sibling modules behind
the same router registration, with **no route paths changed** — these are live
endpoints, and `_AREA` in `api/main.py` plus the 720-case authorization sweep
in `tests/test_api/test_authorization.py` both key off router modules, so the
split must keep every path and its gating identical. The authorization sweep
passing unchanged is the acceptance test.

## Task 6: Review and documentation

**A. State of the world.** Tasks 1–4 (and possibly 5) are complete. This step
is for review and documentation.

**B/C. Deliverable.**
- `documentation/architecture.md` updated with: the import contracts and the
  shared-kernel list, the "Adding a module" convention, and a short record of
  the decisions *not* taken and why (no per-module migrations, no clinical
  repackaging, no frontend restructure, no permission-model change) — so they
  are not rediscovered as omissions.
- `documentation/architecture-reception.md` updated for the new paths.
- Confirm the contracts still fail on a deliberate violation after all moves.
- Delete `documentation/architecture_tightening_plan.md`.

---

## Open questions for the review chat

1. Is `models/enums.py` the right home for `DAY_ORDER`, or is a dedicated
   `app/shared/` package worth starting now given more modules are coming?
2. Should the shared kernel become an actual `app/shared/` package as part of
   this plan, rather than a list in a config file? It is more honest, but it
   moves `database.py`, `api/deps.py` and several models — which is exactly
   the kind of large live-code move this plan otherwise avoids.
3. Is Task 5 in or out? Recommend out.
4. Is `ruff` in or out? Recommend out of this plan, as its own ticket.
5. Does the frontend get `src/features/research/` in the research plan, or is
   that a separate frontend-convention decision?
