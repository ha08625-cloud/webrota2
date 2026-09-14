# Implementation Plan — Architecture tightening before the next modules

**Status: implementation plan.** This is the reviewed and corrected output of
step 2 of the CLAUDE.md workflow. The provisional plan it replaces was
verified against the tree, and its claims were tested by installing
`import-linter` 2.15 in a scratch venv and running real contracts against
`backend/app`. Findings from that verification are recorded in "Review
findings" below, because two of them change the task order and one changes
what the contracts can honestly claim to enforce.

Each task below is sized for a single implementation chat.

## Plan

The system is live and two more sections are planned (Research, Trainee
Induction), with more after that. This plan does the work that makes adding
those sections safe, and deliberately does **not** do a domain-first
repackaging of the existing code.

The reasoning, from an audit of the current tree:

- The domains are already decoupled **in substance**. Reception imports
  nothing from `engine/`, `models/doctor.py` or `models/rota.py` except one
  constant (`DAY_ORDER`, two call sites). Clinical contains zero references to
  reception — verified by grep across `engine/`, `documents/` and the loose
  clinical helpers. There are no cross-domain FKs between `Doctor` and
  `ReceptionStaff`.
- The permission model is already generic. `models/permissions.py` holds
  string-keyed permissions in a `MutableDict(JSON)` column; adding a
  `research` area is a one-line change to `AREA_KEYS` with **no migration**.
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

## Review findings

These were verified empirically, not reasoned about. They are the reason this
plan differs from the provisional one.

**F1. `forbidden` contracts follow indirect chains, and that makes them
unusable here unless `allow_indirect_imports = True`.** Run without it, a
contract saying "reception must not import `app.models.doctor`" breaks
immediately on chains that are not violations:

```
app.api.routers.reception_counters -> app.api.deps (l.30)
    app.api.deps -> app.models (l.90)
    app.models -> app.models.user (l.51)
    app.models.user -> app.models.doctor (l.128)
```

`app/models/__init__.py` imports every domain's models (it has to —
`create_all` and Alembic autogenerate depend on it), so in the indirect graph
everything reaches everything. `allow_indirect_imports = True` is mandatory.

**F2. Direct-only contracts are blind to cross-domain *model* access while the
aggregate imports remain.** `from ...models import Doctor` in a future
research router is a *direct* import of `app.models`, which is shared kernel
and therefore allowed — the contract never fires. The same hole exists via
`app.api.schemas`. This is why Task 3 exists: domain modules must import model
and schema **submodules**, so that a cross-domain model import is a direct
edge the contract can see. Without Task 3, the contracts catch
`from ...engine...` and `from ...documents...` and nothing else, which is
materially less than "the boundaries are enforced".

**F3. Wildcards cannot match name prefixes — verified.**
`source_modules = ["app.reception_*"]` is rejected outright:
*"A wildcard can only replace a whole module."* Wildcards work per path
segment (`app.reception.*`), not as prefixes on a name. With today's flat
`app/reception_*.py` and `api/routers/reception_*.py` files, every contract
list must be written longhand **and manually extended for every new reception
file** — a new `reception_foo.py` would be silently uncovered. This reverses
the provisional plan's ordering: **the move to `app/reception/` must come
before the contracts, not after**, because `app.reception` as a package makes
the contract one line that covers new files automatically.

**F4. `TYPE_CHECKING` imports are counted.** `models/user.py:127-129` imports
`Doctor` and `ReceptionStaff` under `if TYPE_CHECKING:`, and import-linter
reports them as real edges. Any "shared kernel must not import domains"
contract must therefore exempt `app.models.user` explicitly, with a comment
pointing at Decision 7.

**F5. Config in `pyproject.toml` works.** `[tool.importlinter]` plus
`[[tool.importlinter.contracts]]` is read correctly by 2.15; no separate
`.importlinter` or `setup.cfg` is needed.

**F6. The frontend claim in the provisional plan was overstated.** There are
four real shells (`ClinicalShell`, `ReceptionShell`, `SignaturesShell`,
`AdminShell`) but all four live in one `App.tsx`, and `src/routes/`,
`src/components/` and `src/api/` are flat directories mixing every domain
(`ReceptionGrid.tsx` sits beside `RotaGrid.tsx`). The shells give isolation of
*routing and nav*, not of code organisation, and there is no enforcement of
any kind on the frontend. Decision 5 stands, but for the honest reason, not
the overstated one.

**F7. Moving router modules is safe.** `_AREA` in `api/main.py` keys off
imported module *objects*, and the 720-case sweep in
`tests/test_api/test_authorization.py` keys off **URL path prefixes**, not
module paths (`audit_descriptions.py` likewise keys off `(method, path)`). So
relocating `api/routers/reception_*.py` changes only the import statement in
`main.py`, provided no `APIRouter(prefix=...)` value changes.

## Scope

**In scope**

1. Extract `DAY_ORDER` out of the clinical engine (Task 1).
2. Move reception into an `app/reception/` package, routers included — a pure
   move, no logic changes (Task 2).
3. Normalise domain modules onto model/schema submodule imports (Task 3).
4. Add `import-linter` to CI with contracts that forbid cross-domain imports,
   and document honestly what they do and do not catch (Task 4).
5. Write down the convention for new modules, and amend the research plan to
   follow it before it is implemented (Task 5).
6. Review and documentation (Task 6).

**Out of scope, with reasons**

- **Domain-first repackaging of clinical.** 6,100 lines of engine, 600 lines
  of architecture doc, the most complex thing in the repo, heavily tested.
  Repackaging earns nothing the import contracts don't already give, and risks
  a lot.
- **Splitting `api/routers/rota.py` (970 lines) and `staging.py` (850).** The
  codebase's largest genuine maintainability problem, and unrelated to
  modularity. Do it opportunistically, the next time a ticket touches them,
  not as standalone churn on live endpoints. **Dropped from this plan.**
- **`ruff`, `eslint`, `mypy`.** Real value, but each is its own ticket with
  its own style-churn diff across live code. "No ruff, no mypy" was cited as
  *evidence* that nothing is enforced, not as a recommendation to adopt both.
- **Per-module Alembic migration streams.** One database, one migration chain.
  Branched heads across five modules buys nothing for a single-DB app and
  costs permanent "multiple heads" pain.
- **Restructuring reception's logic to match the clinical phase pipeline.**
  Clinical rota generation is a real constraint-satisfaction problem;
  reception phone/desk coverage is not. `reception_front_desk.py` is 366 lines
  because the problem is 366 lines big. Proportionality is correct, not
  inconsistent.
- **Any change to the permission model.** It is already the shape a reviewer
  would ask for.
- **Frontend restructuring into `src/features/*`** for existing sections. See
  Decision 5 and F6.
- **`users.doctor_id` / `users.reception_staff_id`.** Real cross-domain FKs on
  the identity table, and in principle a reviewer is right to flag them. The
  rationale in `models/user.py` is sound (the link is a privilege grant, gated
  by `user_admin`, not by the domain's permission), and two columns is fine.
  Revisit if Research and Induction each want one and it becomes five. See
  Decision 7.

## Design Decisions

**1. Contracts are `forbidden`, not `layers`, and direct-only.**
`import-linter`'s `layers` contract wants one package per layer. We don't have
that — `app/models/` is a single flat package holding clinical, reception and
identity models together. Use `forbidden` contracts naming module sets
instead, with `allow_indirect_imports = True` (mandatory, see F1). This works
at today's granularity and tightens into a `layers` contract if modules ever
all become packages.

**2. Shared-kernel modules are named explicitly, not discovered.**
The shared kernel is: `app.database`, `app.email`, `app.models.enums`,
`app.models.user`, `app.models.permissions`, `app.api.deps`, `app.api.audit`,
`app.api.audit_descriptions`, `app.api.auth_utils`, `app.api.edit_lock`,
`app.models.audit`, `app.models.edit_lock`. Contracts must permit any domain
to import these. **Adding to this list is a decision, not a convenience** — an
ever-growing shared kernel is how a modular monolith quietly becomes a layered
one, and the convention doc must say so.

`app.models` and `app.api.schemas` (the aggregate `__init__` modules) are
deliberately **not** shared kernel for domain code — see Decision 8.

**3. `DAY_ORDER` moves to `models/enums.py`.**
It is the one real boundary violation. It belongs next to the `Day` enum it
orders, and `models/enums.py` is already shared kernel. `engine/week_map.py`
imports it from there and `engine/__init__.py` keeps re-exporting it, so no
clinical call site *has* to change — but they all change anyway, see Task 1,
because leaving two idioms in place invites the wrong one to be copied.

**4. The reception move is a pure move, in its own PR, with no logic changes.**
`app/` is becoming a junk drawer (it also holds `leave_charging.py`,
`leave_entitlement.py`, `doctor_window.py`, `master_template.py`,
`calendar_feed.py`), and at five or six sections you won't be able to tell what
belongs to what. Doing it as a move-only PR means CI proves it safe. Unlike
the provisional plan, **the routers move too** — F3 makes that the difference
between a one-line contract and a hand-maintained list, and F7 shows it is
safe. Clinical's loose files are **not** moved: same junk-drawer argument, but
they are more numerous and more entangled, and one demonstrated move is enough
to establish the pattern.

**5. New modules are built domain-first from day one; old modules are not
retrofitted.** Let the new pattern demonstrate itself on Research before
committing to it everywhere. If after Research and Induction the domain-first
shape is clearly better to work in, retrofitting is then a small,
evidence-backed decision rather than a leap of faith. The frontend gets the
same treatment: Research's pages go in `src/features/research/`, existing
sections stay where they are. Note this is a *decision to defer*, not a claim
that the frontend is already isolated — see F6.

**6. `app/shared/` is not created now.** It is more honest than a list in a
config file, but it moves `database.py`, `api/deps.py` and several models —
exactly the kind of large live-code move this plan otherwise avoids. Revisit
when the shared kernel next grows. The list in Decision 2 plus the
architecture-doc note is the interim.

**7. No speculative generalisation of the identity link.**
Do not build a `module_identities` link table now. Two nullable FKs work, and
the shape the third module needs isn't known until it exists — the Research
plan's `Owner` field is a plain nullable FK to `users`, which is a *different*
relationship from `doctor_id`/`reception_staff_id` (who this login *is* on a
rota). Guessing the abstraction now is likely to guess wrong.

**8. Domain code imports model and schema submodules, not the aggregates.**
This is new, and it is what makes the contracts mean what they say (F2). The
aggregates keep existing and keep importing everything — `create_all` and
Alembic autogenerate depend on `app/models/__init__.py` doing so, and that is
unchanged. What changes is that *domain* modules stop going through them, so
`from ...models.doctor import Doctor` in a reception file is a direct,
visible, contract-breaking edge. Shared-kernel modules (`api/deps.py` in
particular) may continue to use the aggregate; they are not domain code.

---

## Task 1: Extract `DAY_ORDER` to the shared kernel

**A. State of the world.** Nothing has been done yet. This is the first task.
It removes the only genuine cross-domain import in the backend, and every
later task depends on it.

**B. Files.**
- `backend/app/models/enums.py` — new home for `DAY_ORDER`, defined
  immediately after the `Day` enum, with the comment explaining that it is the
  weekday offset of each `Day` and that dict insertion order (Monday..Friday)
  is relied on by callers.
- `backend/app/engine/week_map.py:16` — delete the definition, import from
  `..models.enums` instead. Uses at lines 43 and 78 are unchanged.
- `backend/app/engine/__init__.py:35,50` — keeps importing from `.week_map`
  and re-exporting in `__all__`. Unchanged, deliberately: dropping the
  re-export would be a breaking change to the engine's public surface for no
  gain.
- `backend/app/engine/context.py:39` — switch to `..models.enums`.
- `backend/app/api/routers/reception_rota.py:30` — switch to
  `...models.enums`.
- `backend/app/api/routers/reception_master.py:21` — switch to
  `...models.enums`.
- `backend/app/api/routers/recurring_notes.py:36` — switch to
  `...models.enums`.
- `backend/app/master_template.py:16` — switch to `.models.enums`.
- `backend/tests/test_week_map.py` — **no change needed**: verified, it
  imports `build_date_to_genslot`, `build_week_dates` and `template_week` from
  `app.engine.week_map` and `Day` from `app.models.enums`, but not
  `DAY_ORDER`. Listed so the implementation chat does not go looking.

**C. Instructions.**
1. Move the dict verbatim. Do not change its contents, its type annotation or
   its ordering.
2. Convert **every** call site, including the clinical ones that could have
   stayed on the engine re-export. Two idioms for one constant is how the next
   author picks the wrong one.
3. Grep for `DAY_ORDER` across `app/` and `tests/` afterwards and confirm the
   only remaining reference to `engine.week_map.DAY_ORDER` is the
   `engine/__init__.py` re-export.
4. Run `uv run pytest tests/test_week_map.py tests/test_reception_rota.py
   tests/test_api/test_reception_master.py tests/test_api/test_recurring_notes.py`
   plus `tests/test_engine/`.

**D. Deliverable.** `DAY_ORDER` defined once, in `models/enums.py`. No module
outside `app/engine/` imports anything from `app.engine`. The
`engine/__init__.py` re-export still works. Existing tests pass unchanged — no
test assertions should need editing, only import lines.

## Task 2: Move reception into an `app/reception/` package

**A. State of the world.** Task 1 is done: `DAY_ORDER` lives in
`models/enums.py` and no reception module imports `app.engine`. This task
makes reception a package so that Task 4's contracts can name it with a
wildcard instead of a hand-maintained file list (F3). **This is a pure move.
If a reviewer sees anything in the diff but moves, renames, import updates and
prose updates, it belongs in a different PR.**

**B. Files.**

Moves (helpers):
- `backend/app/reception_counters.py` → `backend/app/reception/counters.py`
- `backend/app/reception_front_desk.py` → `backend/app/reception/front_desk.py`
- `backend/app/reception_phones.py` → `backend/app/reception/phones.py`

Moves (routers — see F7 for why this is safe):
- `backend/app/api/routers/reception_staff.py` →
  `backend/app/api/routers/reception/staff.py`
- `backend/app/api/routers/reception_master.py` → `.../reception/master.py`
- `backend/app/api/routers/reception_rota.py` → `.../reception/rota.py`
- `backend/app/api/routers/reception_leave.py` → `.../reception/leave.py`
- `backend/app/api/routers/reception_counters.py` → `.../reception/counters.py`

New:
- `backend/app/reception/__init__.py` — re-export the names the routers use
  (`compute_role_counters`, `default_counter_window`,
  `assignment_counter_window`, `RoleCounters`, `StaffRoleCounters`,
  `FRONT_DESK_END_HOUR`, `FRONT_DESK_HOURS`, `select_front_desk_blocks`,
  `select_phones_blocks` — check the actual import lines, don't trust this
  list). Keep it a thin re-export module with a short docstring; do not put
  logic in it.
- `backend/app/api/routers/reception/__init__.py` — empty or a one-line
  docstring. It must **not** re-export the router modules, because `main.py`
  imports them as module objects for `_AREA`.

Import updates:
- `backend/app/api/main.py:55-90` — the router import block becomes
  `from .routers.reception import (counters as reception_counters, leave as
  reception_leave, ...)` or equivalent. **Keep the local names
  `reception_counters`, `reception_rota` etc. unchanged**, so `_ALL_ROUTERS`,
  `_AREA` and the two assertions at lines 220-229 need no edit at all.
- `backend/app/api/routers/reception/rota.py:46-52` and
  `.../reception/counters.py:29` — `from ...reception_counters import ...`
  becomes `from ....reception.counters import ...` (mind the extra dot from
  the new directory level; prefer `from app.reception.counters import ...`
  only if the file already uses absolute imports, which it does not).
- `backend/app/reception/front_desk.py:75` and `phones.py:95` —
  `from .reception_counters import RoleCounters` becomes
  `from .counters import RoleCounters`.
- `backend/app/reception/front_desk.py:72`, `phones.py:92` —
  `from .models import ReceptionRota` becomes `from ..models import ...`
  (Task 3 then narrows it further; leave that to Task 3).
- `backend/tests/test_reception_counters.py:17`,
  `test_reception_front_desk.py:18-19`, `test_reception_phones.py:19-20` —
  `from app.reception.counters import ...` etc.
- `backend/tests/test_api/test_reception_counters.py:17` —
  `from app.api.routers.reception import counters as reception_counters_router`.
  The `monkeypatch.setattr(reception_counters_router, "_today", ...)` at
  line 36 keeps working unchanged.

Prose references (the grep must cover comments and docstrings, not just
imports — these are all real and all wrong after the move):
- `backend/app/api/schemas/reception.py:59,265`
- `backend/app/models/reception.py:179,180,285,286`
- `backend/app/reception/phones.py:12,19,70,181`
- `backend/app/reception/front_desk.py:42,55`
- `backend/tests/test_api/test_reception_counters.py:6,9`
- `backend/tests/test_api/test_reception_rota.py:343`
- `backend/tests/test_reception_phones.py:6`
- `documentation/architecture-reception.md` — path references throughout

**C. Instructions.**
1. Use `git mv` for every move so the diff reads as a rename.
2. Do **not** rename the test files or create `tests/test_reception/` in this
   task. Test layout is a separate decision and mixing it in destroys the
   "pure move" property that makes this PR reviewable. (Recommendation for
   later: leave them. `tests/` is flat throughout and consistency there is
   worth more than mirroring.)
3. Do not change any `APIRouter(prefix=...)` value. F7's safety argument
   depends on every URL path being byte-identical.
4. Check `backend/pyproject.toml` `[tool.hatch.build.targets.wheel] packages =
   ["app"]` still picks up the new subpackages. It should — hatchling includes
   subpackages — but confirm with `uv build` or by checking the wheel contents,
   because a packaging regression here would only show up on a Railway deploy.
5. Run the full backend suite for this one. It is a wide move and the suite is
   the proof.

**D. Deliverable.** No `reception_*.py` anywhere in `app/`. `app.reception`
and `app.api.routers.reception` are packages. `git diff --stat` shows renames
plus import and prose lines only. `_AREA`, `_ALL_ROUTERS` and the
authorization sweep are untouched and green. Full backend suite green.

## Task 3: Domain modules import model and schema submodules

**A. State of the world.** Tasks 1-2 are done; reception is a package. This
task is what makes Task 4's contracts actually bite on model access rather
than only on `app.engine` (F2). It is small but it is not cosmetic — skipping
it means shipping contracts that pass while policing about half of what the
architecture doc will claim they police.

**B. Files.**
- `backend/app/reception/front_desk.py:72`, `phones.py:92` —
  `from ..models import ReceptionRota` → `from ..models.reception import
  ReceptionRota`.
- `backend/app/api/routers/reception/counters.py:28,31` —
  `from ....models import User` → `from ....models.user import User`;
  `from ...schemas import ReceptionCounterRowOut, ReceptionCountersOut` →
  `from ...schemas.reception import ...`.
- `backend/app/api/routers/reception/leave.py:32,34` — same treatment
  (`models.reception` for `ReceptionLeaveEntry`/`ReceptionStaff`,
  `models.user` for `User`, `schemas.reception` for the bulk schemas).
- `backend/app/api/routers/reception/master.py:22` — same. Its schema import
  at line 24 is **already** `..schemas.reception`; that mixed idiom within one
  directory is exactly the problem.
- `backend/app/api/routers/reception/rota.py:31-54` — collapse the aggregate
  `from ....models import (...)` into `models.reception` + `models.user`; it
  already imports `models.enums` and `models.reception` directly at lines
  39-40. Schemas likewise.
- `backend/app/api/routers/reception/staff.py` — check and normalise.

**C. Instructions.**
1. **Scope is reception only.** There are ~40 files repo-wide importing the
   `app.models` aggregate; do not touch the clinical ones. Clinical is not
   under a package-level contract and converting it is churn with no
   enforcement payoff until someone decides to repackage clinical.
2. `app/models/__init__.py` and `app/api/schemas/__init__.py` are **not**
   changed. They must keep importing everything — `create_all` and Alembic
   autogenerate depend on it, and the module docstring in
   `models/__init__.py` says so.
3. Verify nothing was relying on an aggregate-only name (a symbol re-exported
   from `__init__` but not defined in the obvious submodule, e.g.
   `is_stale` which lives in `models/edit_lock.py`). Run the import of
   `app.api.main` before running the suite: `uv run python -c "import
   app.api.main"`.
4. Run `uv run pytest tests/test_reception_counters.py
   tests/test_reception_front_desk.py tests/test_reception_phones.py
   tests/test_api/` .

**D. Deliverable.** No module under `app/reception/` or
`app/api/routers/reception/` imports `app.models` or `app.api.schemas` as an
aggregate. A deliberate `from ....models.doctor import Doctor` inserted into a
reception router is now a *direct* edge in the import graph — verify this by
eye before Task 4, and by contract in Task 4.

## Task 4: Add `import-linter` contracts to CI

**A. State of the world.** Tasks 1-3 are done: no cross-domain imports remain,
reception is a package, and domain code imports model submodules. This task
makes those properties permanent.

**B. Files.**
- `backend/pyproject.toml` — `import-linter` added to the `dev` extra;
  configuration in `[tool.importlinter]` and `[[tool.importlinter.contracts]]`
  (F5 — pyproject config is supported, no extra file needed).
- `.github/workflows/ci.yml` — a `lint-imports` step in the existing `test`
  job, placed **before** "Run tests" so a boundary break fails fast. Not a new
  job: it shares the `uv sync --extra dev` install and takes about a second.
  The `gate` job already short-circuits docs-only changes, so nothing extra is
  needed there.
- `documentation/architecture.md` — the contracts, the shared-kernel list, and
  the honest statement of what they do not catch.

**C. Instructions.**

1. Pin `import-linter>=2.4` in the `dev` extra (2.15 is what was verified;
   the `allow_indirect_imports` option and pyproject config both predate it).

2. Write the contracts. Shape that was verified to work:

   ```toml
   [tool.importlinter]
   root_package = "app"

   [[tool.importlinter.contracts]]
   name = "Reception must not import other domains"
   type = "forbidden"
   allow_indirect_imports = true   # mandatory -- see the comment below
   source_modules = ["app.reception", "app.api.routers.reception"]
   forbidden_modules = [
       "app.engine",
       "app.documents",
       "app.models.doctor", "app.models.rota", "app.models.staging",
       "app.models.master_rota", "app.models.clinic_type", "app.models.duty",
       "app.models.leave", "app.models.counter", "app.models.room",
       "app.master_template", "app.leave_charging", "app.leave_entitlement",
       "app.doctor_window", "app.calendar_feed",
   ]
   ```

   Named modules include their descendants, so `app.reception` covers
   `app.reception.counters` and anything added later — that is the payoff from
   Task 2.

3. Write the mirror contract ("Clinical must not import reception"), sourcing
   `app.engine`, `app.master_template`, `app.leave_charging`,
   `app.leave_entitlement`, `app.doctor_window`, `app.calendar_feed` and the
   clinical routers, forbidding `app.reception`, `app.api.routers.reception`
   and `app.models.reception`. Note this one **must** list clinical routers
   longhand, because they are flat files in `api/routers/` — that is the
   ongoing cost of not repackaging clinical, and it should be stated as a
   comment in the config so nobody thinks it is an oversight.

4. Write the documents contract: `app.documents` is a leaf and imports nothing
   from `app` at all today (verified). A contract forbidding it from importing
   `app.engine`, `app.reception` and `app.models.*` keeps it that way cheaply.

5. Write the shared-kernel contract: the modules in Decision 2 must not import
   any domain. **Exempt `app.models.user`** (F4 — its `TYPE_CHECKING` imports
   of `Doctor` and `ReceptionStaff` are counted as real edges, and Decision 7
   says those stay). Put the exemption in the config with a comment naming
   Decision 7, not silently.

6. Add a comment above `allow_indirect_imports` explaining *why* it is on —
   `app/models/__init__.py` aggregates every domain, so the indirect graph is
   fully connected and an indirect contract can never pass. Without that
   comment a future author will "tighten" it and find themselves reverting.

7. **Prove the contracts bite.** For each of the four contracts, temporarily
   add a violating import, run `uv run lint-imports`, confirm it fails naming
   that contract, then remove it. A contract whose module expressions match
   nothing passes vacuously, and that is the single most likely way for this
   task to be silently useless. Record in the PR description which four
   violations you tested.

8. Write the architecture.md subsection. It must say, in plain terms: the
   contracts catch a direct import of another domain's modules; they do **not**
   catch cross-domain access routed through `app.models` or
   `app.api.schemas`, which is why domain code imports submodules (Decision 8)
   and why new modules must do the same; and adding a module to the shared
   kernel is a decision, not a convenience.

**D. Deliverable.** `uv run lint-imports` passes locally and in CI. Four
contracts, each demonstrated to fail on a deliberate violation. The
architecture doc states the contracts' real coverage, including the gap.

## Task 5: Write the new-module convention, and amend the research plan

**A. State of the world.** Tasks 1-4 are done. The boundaries are enforced and
reception demonstrates the package shape. This task makes sure Research is
built the new way rather than adding to the old layout.

**B. Files.**
- `documentation/architecture.md` — a new "Adding a module" section.
- `documentation/research_section_plan.md` — amend the file lists (lines
  ~400-530 hold them).

**C. Instructions.**

1. Write the convention. A new module is a package `app/<module>/` holding its
   own `models.py`, `schemas.py`, `service.py` and a router package at
   `app/api/routers/<module>/`. It may import **only** the shared kernel
   (Decision 2 list) and its own internals. It imports model and schema
   **submodules**, never the aggregates (Decision 8). It registers in `_AREA`
   in `api/main.py` and `AREA_KEYS` in `models/permissions.py`. Its models are
   imported in `models/__init__.py` so `create_all` sees them. It shares the
   single Alembic chain. Its frontend lives in `src/features/<module>/` behind
   its own shell. It gets a `forbidden` contract in `pyproject.toml` at the
   same time as its first file — one line, because it is a package.

2. Amend `research_section_plan.md`. It currently follows a **hybrid** layout —
   verified: models at `backend/app/models/study.py` (line 464), router at
   `backend/app/api/routers/research.py` (511), schemas at
   `backend/app/api/schemas/research.py` (505), *and* a new package at
   `backend/app/research/catalogue.py` (244, 459). That hybrid is the thing to
   fix, and it is much cheaper to fix in the plan than in the code. Move them
   to `app/research/models.py`, `app/research/schemas.py`,
   `app/research/catalogue.py`, `app/api/routers/research/`.

3. Two constraints survive the amendment and must be called out explicitly in
   the amended plan, because they are the two things a domain-first layout
   invites people to forget:
   - `models/__init__.py` must **still** import the new models — `create_all`
     and Alembic autogenerate depend on it. Domain-first models do not mean
     an unregistered mapper.
   - The permission wiring in `models/permissions.py`, `api/deps.py`,
     `api/schemas/auth.py` and `api/main.py` is unchanged and stays where it
     is — those are shared kernel, and the research plan already gets them
     right.

4. Add one line to the research plan noting that `app/research` gets its
   import contract in the same PR as its first module.

**D. Deliverable.** An "Adding a module" section in `architecture.md` a new
chat could follow without reading this plan. `research_section_plan.md`
internally consistent, domain-first, with the two surviving constraints called
out.

## Task 6: Review and documentation

**A. State of the world.** Tasks 1-5 are complete. This step is for review and
documentation.

**B/C. Instructions and deliverable.**
- `documentation/architecture.md` updated with: the import contracts and their
  real coverage, the shared-kernel list and the rule that extending it is a
  decision, the "Adding a module" convention (from Task 5), and a short record
  of the decisions **not** taken and why — no per-module migrations, no
  clinical repackaging, no frontend restructure, no permission-model change,
  no router splits, no ruff/eslint/mypy — so they are not rediscovered later as
  omissions.
- `documentation/architecture-reception.md` updated for the new paths.
- Re-confirm all four contracts still fail on a deliberate violation after all
  moves are in. This is the second time this check is done deliberately; the
  first was mid-plan, and moves since then could have made an expression match
  nothing.
- Record as follow-up tickets, not as work here: `ruff` (correctness rules
  only — unused imports, undefined names, `TID252`; formatting off), `eslint`
  for the frontend, and the `rota.py` / `staging.py` splits to be done
  opportunistically.
- Delete `documentation/architecture_tightening_plan.md`.

---

## Resolved open questions

The provisional plan's five open questions, answered:

1. **Is `models/enums.py` the right home for `DAY_ORDER`?** Yes. It is a
   property of the `Day` enum, it needs no new module, and `models/enums.py`
   is already shared kernel. No `app/shared/` needed for this.
2. **Should the shared kernel become a real `app/shared/` package?** Not now —
   Decision 6. It is the more honest shape, but it moves `database.py`,
   `api/deps.py` and several models, which is the class of change this plan
   exists to avoid. Revisit when the kernel next grows.
3. **Is the router split in?** Out. Dropped from the plan; do it
   opportunistically.
4. **Is `ruff` in?** Out of this plan; its own ticket, recorded in Task 6.
5. **Does the frontend get `src/features/research/`?** Yes, in the research
   plan — Decision 5. Existing sections are not moved. Note F6: this is a
   deliberate deferral, not a claim that the frontend is already isolated.
