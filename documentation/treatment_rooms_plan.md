# Implementation Plan — Treatment rooms (TR1/TR2/TR3) and CK

Stage 2 output: the provisional plan reviewed against the code, corrected, and
broken into tasks. Tasks 1–4 are code; Task 5 is data entry; Task 6 closes the
ticket.

## Scope

Four physical rooms the clinical rota does not currently model:

| Code | Site | Notes |
|---|---|---|
| TR1 | SHC | treatment room, nurses |
| TR2 | SHC | treatment room, nurses |
| TR3 | SHC | treatment room, nurses |
| CK | Cutteslowe | Cutteslowe Kitchen |

They must be visible on the clinical rota (room view, doctor view, exports),
occupiable from the master rota and by manual edit, and **never** reachable by
any generation phase.

Out of scope: the "add nurse edit option" and "add med student" lines in
`planned_updates.md`, and anything that changes how nurses behave —
`DoctorType.NURSE` and its inertness landed in PRs #388–392 and are the
foundation this builds on.

## Answers settled in review

- **CK occupancy.** Normally one nurse. It is also used *in a pinch* by a
  supervisor: when three trainees are in C1/C2/C3 and nobody can work from
  home, the supervisor sits in the kitchen. Rare, and **explicitly not
  something the generation engine should model** — see Design Decision 8 for
  the one consequence this has.
- **TR1–3 utilisation.** Used every session, almost all of the time. So the
  master rota gets a full set of rows (Task 5), and the room view will not
  show four mostly-"Available" rows.
- **Nurses in the doctor view.** Yes — nurses appear in both the doctor view
  and the room view. This is already the default (they are `Doctor` rows and
  `DOCTOR_TYPE_ORDER` / `DOCTOR_TYPE_LABELS` already carry `Nurse`), so no
  work follows from it. Recorded so it is not re-litigated.

## Design Decisions

### 1. A fifth `RoomType`, `TR` — not a boolean flag on `Room`

`RoomType` gains `TR = "TR"`, and all four rooms carry it (CK included — the
type says "nurse room the engine does not allocate", the `site` column says
where it is).

This is the mirror of `INERT_TYPES` for nurses and works for the same reason:
**every engine phase reaches rooms through an explicit room-type allowlist**,
never through "all rooms minus exclusions". Verified — the only two sites that
touch `context.rooms` unfiltered (`phase7_9a.py:353`, `room_relocation.py:67`)
immediately filter on `_ROOM_MOVE_FALLBACK_TYPES`. Every other room lookup in
the engine is a `rooms_by_type.get(RoomType.X, ())` naming a single type
explicitly. A type absent from every such allowlist is structurally
unallocatable with **no new code in any phase**.

A boolean `Room.generator_assignable` would be the opposite: default-open, one
new check per phase, and the next phase anyone writes is unguarded until they
remember.

CK is `TR` rather than `C` for exactly this reason: `RoomType.C` is in
`_ROOM_MOVE_FALLBACK_TYPES` and `_PASS3_FALLBACK_TYPE_ORDER`, so a CK typed as
a C room would be a room the engine hands out.

### 2. The disjointness test covers four named tuples, not five

**Correction to the provisional plan.** It listed "`phase4`'s D-room pool" as
something the test would assert against. There is no such tuple: `phase4.py:122`
is an inline `context.rooms_by_type.get(RoomType.D, ())`, as are
`phase7_9a.py:119`, `room_relocation.py:104` and `phase9c.py:181/202`. An
inline single-type lookup cannot acquire `TR` by accident, so it needs no
assertion; there is nothing to assert against.

The complete set of room-type collections in the engine is:

| Constant | File |
|---|---|
| `_ROOM_MOVE_FALLBACK_TYPES` | `phase7_9a.py:104` |
| `_PASS3_FALLBACK_TYPE_ORDER` | `phase7_9a.py:111` |
| `_ROOM_MOVE_FALLBACK_TYPES` | `room_relocation.py:33` |
| `_SUPERVISOR_ROOM_TYPES` | `phase9c.py:90` |

Mirror the nurse precedent exactly: add `NON_ALLOCATABLE_ROOM_TYPES =
(RoomType.TR,)` to `phases/_shared.py` beside `INERT_TYPES`, with a docstring
stating that the guarantee is *absence* from the four tuples above and that
`tests/test_engine/` is what pins it. Nothing in the engine reads the constant;
it exists so the rule has a name and a single place to document it, the way
`INERT_TYPES` does. Pair it with a generation test (Task 2) that proves no
phase seats anyone in a TR room — that test is what covers the inline lookups.

### 3. Preferred rooms are the one real hole, closed at the API boundary

Three call sites walk a doctor's preference list with no room-type allowlist:

- `phase7_9a.py:544` (Pass 3, first free preferred room wins — no filter at all)
- `room_relocation.py:58` and `phase5.py:298` (filter out `D`, allow the rest)

`Doctor.preferred_rooms` is the single path by which a generation phase could
put a doctor in TR1. Nothing else is.

Closed the way **SR-is-not-a-clinic-room** is closed (`architecture-clinical.md`
line 151), because that precedent already settled the argument:

- **Both halves of the `room_id`/`room_type` XOR, at the API.** The Pydantic
  schema rejects `room_type == "TR"`, and the `PUT
  /doctors/{id}/preferred-rooms` handler resolves `room_id`s against the DB and
  rejects TR rooms by id. That PUT is the **only** write path — `DoctorIn` and
  `DoctorPatch` carry no preferred-room fields (verified).
- **Mirrored in the frontend** picker (`DoctorFormDialog.tsx`): TR filtered out
  of both the concrete-room `<select>` and the `ROOM_TYPES` token list.
- **Not enforced in the engine.** `load_context()` keeps expanding whatever is
  stored, so the engine stays honest about the data. A **Phase 0 warning** names
  a stored TR preference before the run; `phase0._check_pre_assigned_sr_room`
  and `_check_clinic_sr_room_eligibility` are the shapes to copy.

Extend the same rejection to `ClinicTypeRoomEligibility` (schema + router),
alongside the existing SR rejection: a clinic type eligible for TR1 would let
Phase 5 seat a doctor there.

**Note the asymmetry with the SR precedent.** On the clinic-type side the
router half already exists (`clinic_types._reject_sr_rooms`) and only needs its
`where` clause widened. On the doctor side there is **no existing helper at
all** — `PreferredRoomIn` has no SR validator (deliberately: a doctor may
legitimately prefer SR) and `routers/doctors.py` has no `_reject_*` function.
Both halves there are new code, not an edit to an existing check.

**No data migration is needed, and this is a confirmation rather than an open
question.** The system is live, so a new rejection could in principle
invalidate stored rows — but it cannot here: `TR` is not a current enum value
and the four rooms do not exist yet, so no `doctor_preferred_rooms` or
`clinic_type_room_eligibilities` row can name one.

### 4. Manual edits and the master rota stay unrestricted

`set-room` (`rota.py:843`) and the master rota room setter (`master_rota.py:158`)
validate only that the room exists. They stay that way: a human overriding the
engine is trusted everywhere else in this app, and a TR restriction there would
be the only doctor-type-aware room rule in the codebase.

The CK-supervisor answer above **confirms** this decision rather than merely
tolerating it: a real, if rare, workflow needs a non-nurse manually placed in a
TR-typed room. Both pickers pass the full `/rooms` list through (`MasterRotaGrid`
and `RotaGrid` via `useRooms`), so the four rooms appear in them with no
frontend work.

The accepted consequence is unchanged: a rota admin can pin a Partner to TR2
from the master rota and Phase 2 will honour it, because Phase 2 copies
`PRE_ASSIGNED` rooms verbatim for every doctor type. That is a data-entry
mistake the room view shows plainly. **No Phase 0 warning for this case** — a
warning on every nurse row would be noise, and distinguishing "nurse in TR"
from "Partner in TR" is exactly the doctor-type room rule we just declined.

### 5. Cell font colour moves from room *type* to *site*

`cellStyle.ts`'s `ROOM_FONT_COLOR` is `Record<RoomType, FontColor>`: D→black,
SR→black, C→red, W→blue. That mapping is really a **site** mapping — D and SR
are SHC, C is Cutteslowe, W is Wolvercote — and room type has been a faithful
proxy for site only because no type has ever spanned two sites.

`TR` breaks the proxy: TR1–3 are SHC and CK is Cutteslowe, and the red "this is
off-site at Cutteslowe" signal is the whole point of the colour for CK.

So re-key `ROOM_FONT_COLOR` on `Room.site` (`SHC`→black, `Cutteslowe`→red,
`Wolvercote`→blue). For all fourteen existing rooms this is **provably
identical output**. `Room` already carries `site` and `RoomOut` already exposes
it, so no payload change; `Site` is already declared in `frontend/src/api/types.ts`.
`exportStyles.ts` / `exportRotaPdf.ts` go through `cellStyle`, so both exports
follow with no separate edit.

This is worth stating explicitly because `architecture.md`'s theming section
pins the cell colour language as meaning-carrying. The change is **compatible
with what that documentation already claims**: `architecture-clinical.md` line
604 says "Font colour is derived from the assigned room's type and encodes room
location, nothing else". We are keeping the stated meaning and fixing the
derivation that no longer delivers it.

If review prefers not to touch the existing mapping, the fallback is TR→black
and CK reads as an SHC room. That is worse and is recorded only so it is not
rediscovered as an oversight.

### 6. Display order: `D, C, W, SR, TR`, and CK sorts first within TR

`ROOM_TYPE_ORDER` in `pivotRoomRota.ts` gains `TR` at the end, so the four new
rows sit below SR in the room view and in the Excel/PDF room sheets, leaving
the familiar GAS layout untouched above them.

**This edit is not optional and is easy to miss.** `compareRoomDisplayOrder`
sorts on `ROOM_TYPE_ORDER.indexOf(...)`, and `indexOf` returns `-1` for an
unknown type — so forgetting it does not fail, it silently sorts the treatment
rooms *above* the D rooms. Note that adding `TR` to the `RoomType` union does
**not** produce a compile error here (the constant is a plain array), unlike
`ROOM_FONT_COLOR`, whose `Record<...>` type will fail the build until Decision
5 is done. Task 4 must not treat "it compiles" as "it is complete".

Within the TR group the comparator falls through to `code.localeCompare`, so
the row order is **CK, TR1, TR2, TR3** — "C" before "T". That is correct
behaviour, not a bug; it is written down here so nobody 'fixes' it.

### 7. Rooms reach production by data migration, not by seeding

`/rooms` is read-only and `seed/seed_rooms.py` only runs against a fresh
database, so production needs a migration to `INSERT` the four rows plus the
Postgres `ALTER TYPE room_type ADD VALUE IF NOT EXISTS 'TR'`. Same shape and
the same load-bearing `IF NOT EXISTS` reasoning as `018_doctor_type_nurse.py`,
since migration `001` builds native enums from the *current* Python enums.
The native type is named `room_type` (`001`'s `_snake(RoomType.__name__)`).

**Numbering is `019`.** `018` is head; nothing else is in flight.

Three details, one of which is a correction:

- **Postgres will not let a value added by `ALTER TYPE ... ADD VALUE` be used
  later in the same transaction.** The provisional plan offered "confirm the
  deployed Postgres major version, or split into two revisions". **Splitting
  does not help**: `alembic/env.py`'s `run_migrations_online()` wraps
  `context.run_migrations()` in a single `context.begin_transaction()` and does
  not set `transaction_per_migration`, so every pending revision shares one
  transaction. The restriction also still applies on current Postgres — it was
  never lifted for a type that pre-dates the transaction. Use Alembic's
  purpose-built escape hatch instead, in one revision:

  ```python
  with op.get_context().autocommit_block():
      op.execute("ALTER TYPE room_type ADD VALUE IF NOT EXISTS 'TR'")
  ```

  which commits the surrounding transaction, runs the `ALTER` in autocommit,
  and reopens — after which the `INSERT` may use `'TR'`. No version check
  needed, and no dependence on env.py's transaction shape.
- **The insert must be idempotent on `code`** (`uq_rooms_code`). Seeding is a
  manual command, so a fresh DB that runs `alembic upgrade head` and then
  `seed.run_all` would otherwise collide on the four codes the migration just
  inserted. **Decision: `seed_rooms.py` does the skipping** — it gains the four
  rows and only inserts codes not already present. Putting it there rather than
  in the migration keeps the guard on the side that is re-run by hand, and
  makes `seed_rooms` safe to re-run generally, which it is not today.
- **Downgrade deletes the four rooms** and rebuilds the enum without `TR`. It
  will fail on FK references from `master_rota_sessions.room_id` or
  `rota_sessions.room_id`, which is the correct behaviour for narrowing and
  matches `018`'s stance.

### 8. A supervisor in CK will raise a Phase 12 warning — accepted, not new

Following from the CK answer: `phase9c.is_eligible_supervisor` requires the
supervisor's room to be in `_SUPERVISOR_ROOM_TYPES = (D, SR)`, and Phase 12's
`_check_supervision_on_incompatible_slot` reuses it. So a supervisor manually
placed in CK produces a `supervision_on_incompatible_slot` warning.

**Do not add `TR` to `_SUPERVISOR_ROOM_TYPES`** to silence it. Two reasons:

1. It is not new behaviour. A supervisor manually placed in C1, C2 or C3 —
   i.e. the same Cutteslowe scenario, with the supervisor in a consulting room
   rather than the kitchen — already raises the identical warning today. CK
   changes nothing except giving that scenario one more room to happen in.
2. It is already a known gap, tracked in `planned_updates.md` as "trainees off
   site needs validation or local supervisors". Off-site supervision wants its
   own discussion, not a quiet widening of a tuple inside this ticket — and
   widening it would put `TR` in one of the four tuples Decision 2's test
   asserts it is absent from, which is precisely the failure that test exists
   to catch.

Leave the `planned_updates.md` line in place when the other two are removed in
Task 6.

### 9. `_ROOM_TYPE_TOKENS` in `seed_doctors.py`

`seed/seed_doctors.py:20` derives its preferred-room token set from `RoomType`,
so adding `TR` silently makes `TR` a valid CSV token — which Decision 3 has
just banned at the API. Low stakes (seed data is ours), but the seed parser
should reject it too, or the two disagree.

---

## Task 1: Data model, seeds and migration

**A.** Nothing is implemented yet. This task adds the `TR` room type and the
four rooms, and must land before any other task. Everything downstream imports
`RoomType`.

**B. Files and deliverables**

- `backend/app/models/enums.py` — `RoomType` gains `TR = "TR"`.
- `backend/seed/seed_rooms.py` — the four rows appended to `ROOMS`
  (`TR1/TR2/TR3` → `Site.SHC`, `CK` → `Site.CUTTESLOWE`); `seed_rooms()` made
  idempotent on `code` (query existing codes, insert only the missing ones);
  the module docstring's "14 physical rooms" updated to 18.
- `backend/seed/seed_doctors.py` — `_ROOM_TYPE_TOKENS` excludes `TR`, with a
  one-line comment pointing at the API rejection as the reason.
- `backend/alembic/versions/019_treatment_rooms.py` — new revision, `down_revision = "018"`.
- `backend/tests/` — a test that `seed_rooms` is re-runnable (run it twice
  against one session, assert 18 rooms and no `IntegrityError`).

**C. Instructions**

Write `019` with a module docstring in the house style (see `018`), covering:
why `IF NOT EXISTS` is load-bearing; why the `autocommit_block` is required
(Design Decision 7 — env.py runs all revisions in one transaction, and
Postgres forbids using a newly added enum value in the transaction that added
it); and that downgrade fails on FK references by design.

`upgrade()`:

1. On Postgres only, inside `with op.get_context().autocommit_block():`, run
   `ALTER TYPE room_type ADD VALUE IF NOT EXISTS 'TR'`. SQLite renders the enum
   as VARCHAR + CHECK rebuilt at `create_all` time and needs no DDL — skip it,
   as `018` does.
2. On every dialect, insert the four rooms. Use a plain `op.execute` with
   `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE code = ...)`
   or the equivalent — the belt-and-braces guard costs nothing even though
   Decision 7 puts the primary idempotency in the seed.

`downgrade()`: delete the four rooms by code, then (Postgres only) the
rename/recreate/swap dance on `room_type` without `TR`, copying `018`'s shape.
Remember `room_type` is used by three tables — `rooms.room_type`,
`doctor_preferred_rooms.room_type` and `clinic_type_room_eligibilities.room_type`
(see `001` lines 198, 332, 379) — so all three columns need the
`USING room_type::text::room_type` cast, not just `rooms`. `018` only had one
column to convert; this is the one place its shape does not transfer directly.

Run `uv run pytest backend/tests/` for the seed and model tests, and check
`alembic upgrade head` then `alembic downgrade -1` against a scratch SQLite DB.

## Task 2: Engine guarantee

**A.** Task 1 is complete: `RoomType.TR` exists and the four rooms are in the
database. **No engine phase code changes are expected in this task.** The
deliverable is the tests that make "no phase ever allocates a TR room" a
property the suite enforces rather than a property that happens to hold.

**B. Files and deliverables**

- `backend/app/engine/phases/_shared.py` — `NON_ALLOCATABLE_ROOM_TYPES =
  (RoomType.TR,)` beside `INERT_TYPES`, with a docstring in the same voice as
  `is_inert`'s: the rule is enforced by *absence* from the four room-type
  tuples, absence is not something the code can state, and the test below is
  what pins it.
- `backend/tests/test_engine/test_inert.py` (or a sibling
  `test_non_allocatable_rooms.py` — either is fine, say which in the commit) —
  four disjointness assertions, one per tuple in Decision 2's table.
- `backend/tests/test_engine/` — one generation test: a fixture rota where the
  four TR rooms exist, a nurse holds TR1 via a `PRE_ASSIGNED` template row, and
  D-room demand exceeds D-room supply so the fallback paths are genuinely
  exercised. Assert no non-nurse session ends with `room_id` in the TR set, and
  that the nurse keeps TR1.

**C. Instructions**

The generation test is the part that carries weight: the disjointness
assertions cover the four named tuples, and this covers the inline
`rooms_by_type.get(RoomType.D, ())` lookups and the preferred-room paths that
no tuple assertion can reach. Make the D-room pressure real — if every doctor
gets a D room on the first pass, Pass 3 and `room_relocation` never run and the
test proves nothing.

Do **not** add `TR` to `_SUPERVISOR_ROOM_TYPES` — see Design Decision 8.

Run `uv run pytest backend/tests/test_engine/`.

## Task 3: API boundary

**A.** Tasks 1–2 are complete: the type and rooms exist and the engine is
proven not to allocate them. This task stops `TR` being *stored* as a
preference or a clinic-room eligibility, and warns if one ever is.

**B. Files and deliverables**

- `backend/app/api/schemas/doctor.py` — `PreferredRoomIn` gains a `_no_tr`
  `model_validator`, modelled on `RoomEligIn._no_sr` in `schemas/clinic_type.py`.
  Note there is no SR validator here to sit beside; this is the first such rule
  on this schema.
- `backend/app/api/routers/doctors.py` — new `_reject_tr_rooms(db, payload)`
  helper called from `replace_preferred_rooms` before the delete/insert,
  resolving `room_id`s against `Room.room_type == RoomType.TR`. 400 with a
  string `detail`, matching `clinic_types._reject_sr_rooms`.
- `backend/app/api/schemas/clinic_type.py` — `RoomEligIn._no_sr` extended (or a
  sibling validator added) to reject `RoomType.TR`.
- `backend/app/api/routers/clinic_types.py` — `_reject_sr_rooms`'s `where`
  clause widened to `Room.room_type.in_((RoomType.SR, RoomType.TR))`, with the
  error text and the function name generalised so they still describe what the
  code does. The two cases have different reasons ("supervision room" vs
  "treatment room") — either branch the message or use wording that covers
  both; do not let the SR wording silently apply to a TR room.
- `backend/app/engine/phases/phase0.py` — `_check_preferred_tr_room`, modelled
  on `_check_clinic_sr_room_eligibility`: warn once per doctor holding a stored
  TR preference (concrete room or token), naming the doctor and the room. Wire
  it into the phase's issue list. Also extend
  `_check_clinic_sr_room_eligibility` to cover TR eligibilities, or add a
  sibling — the same "a stale row written straight against the DB still
  resolves in Phase 5" argument applies verbatim.
- Tests for each rejection (422 for the schema half, 400 for the router half)
  and for the Phase 0 warnings.

**C. Instructions**

No new routes, so the authorization sweep is unaffected.

Keep the engine honest: do **not** filter TR out of `preferred_rooms_by_doctor`
or `eligible_room_ids` in `load_context()`. The warning-not-filter stance is the
whole point of the SR precedent (`architecture-clinical.md` line 153) — an
engine that silently disagrees with stored configuration is what the decision
log exists to prevent.

Run `uv run pytest backend/tests/test_api/ backend/tests/test_engine/test_phase0*`.

## Task 4: Frontend

**A.** Tasks 1–3 are complete: the backend serves four new rooms of type `TR`
and refuses to store TR preferences. This task makes them render correctly and
keeps them out of the two pickers.

**B. Files and deliverables**

- `frontend/src/api/types.ts` — `RoomType` union gains `"TR"`.
- `frontend/src/lib/cellStyle.ts` — `ROOM_FONT_COLOR` re-keyed
  `Record<Site, FontColor>` (`SHC`→black, `Cutteslowe`→red, `Wolvercote`→blue);
  `fontColorFor` reads `room.site`. Update the comment to say the colour
  encodes site, and why (Decision 5).
- `frontend/src/lib/pivotRoomRota.ts` — `ROOM_TYPE_ORDER` gains `"TR"` at the
  end; docstring updated to mention the TR group and that CK sorts first within
  it.
- `frontend/src/components/DoctorFormDialog.tsx` — `TR` kept out of the
  `ROOM_TYPES` token list, and TR rooms filtered out of the concrete-room
  `<select>` (line ~385 region). Comment it: unlike SR, TR is never a
  legitimate preference.
- `frontend/src/components/ClinicTypeFormDialog.tsx` — `CLINIC_ROOM_TYPES`
  filter extended to exclude `TR` as well as `SR`; concrete-room `<select>`
  filtered likewise; **the comment at line 24 corrected** — it currently says
  `ROOM_TYPES` is untouched because `DoctorFormDialog` still needs SR, which
  remains true for SR but no longer describes the file, since both dialogs now
  filter TR.
- Tests: `cellStyle.test.ts` (a Cutteslowe TR room reads red, an SHC TR room
  reads black, and the fourteen existing rooms are unchanged),
  `pivotRoomRota.test.ts` (TR rows sort last, CK before TR1),
  `DoctorFormDialog.test.tsx` and `ClinicTypeFormDialog.test.tsx` (no TR option
  offered in either control).

**C. Instructions**

Adding `"TR"` to the union will break the build at `ROOM_FONT_COLOR` until it
is re-keyed — that is the intended forcing function. **It will not break
anything else**: `ROOM_TYPE_ORDER` and both dialogs' `ROOM_TYPES` are plain
arrays, so they compile fine while being wrong. Work the file list, not the
compiler.

`exportStyles.ts`, `exportRotaPdf.ts`, `exportRota.ts` and `rotaPdfModel.ts`
all route through `cellStyle` and `compareRoomDisplayOrder`, so they need no
edits — but check `exportRota.test.ts` and `rotaPdfModel.test.ts` for fixtures
that assert the old room ordering or a `Record<RoomType, ...>` shape.

`MasterRotaGrid` and `RotaGrid` pass the full `useRooms` list into their room
pickers, so the four rooms appear there automatically. That is intended
(Decision 4) — do not filter them.

Run `npm run test -- src/lib/cellStyle.test.ts src/lib/pivotRoomRota.test.ts src/components/DoctorFormDialog.test.tsx src/components/ClinicTypeFormDialog.test.tsx`
and `npm run build` for the type check.

## Task 5: Master rota data entry

**A.** Tasks 1–4 are complete and deployed; the four rooms exist in production
and appear in the master rota room picker. This task is **data entry through
the UI, not code** — no branch, no PR.

**B. Deliverable**

The nurses' TR/CK sessions entered as `PRE_ASSIGNED` rows on the active master
template.

**C. Instructions**

Do this after Tasks 1–4 are live, not alongside them — the rooms must exist in
production before anything can be assigned to them.

Two prerequisites to confirm first:

1. The nurses exist as `Doctor` rows with `doctor_type = Nurse` and sensible
   `sessions_per_week`. PRs #388–392 added the type; whether the people have
   been entered is a separate question.
2. The template is week-specific, weeks 1–4. Given TR1–3 are used every session
   almost all the time, expect roughly **3 rooms × 4 weeks × 5 days × 2 periods
   = 120 rows**, plus CK's. That is a substantial amount of clicking; budget
   for it rather than treating it as a footnote to Task 4.

Enter each as `PRE_ASSIGNED` with the room set. Phase 2 copies the room
verbatim, so the rooms read as occupied from the start of every generation run
— which is also what keeps them out of any free-room search at runtime,
independently of the structural guarantee in Task 2.

## Task 6: Review and documentation

**A.** Tasks 1–5 are complete and the feature is live. This step is review and
documentation only.

**B. Files**

- `documentation/architecture-clinical.md`
- `documentation/architecture.md`
- `documentation/planned_updates.md`
- `documentation/treatment_rooms_plan.md` (deleted)

**C. Instructions**

In `architecture-clinical.md`:

- Under "Table design decisions", the **"Rooms and doctors"** paragraph says
  the room type letters "mirror room codes and carry no further semantics in
  the data layer". That is no longer true — `TR` is a semantic marker. Rewrite
  it to say `TR` means "a room the generation engine never allocates", with the
  four codes and their sites.
- Add a paragraph next to **"SR is not a selectable clinic room"** (line 151)
  covering Decisions 1, 2 and 3: the allowlist-not-exclusion argument, the four
  tuples, `NON_ALLOCATABLE_ROOM_TYPES` and the test that pins it, and the API
  rejection of TR preferences and TR clinic eligibilities in both halves of the
  XOR. State that no data migration was needed and why (the rooms did not exist
  when the rule landed), mirroring how the SR paragraph handles the same point.
- Under **"Cell colouring"** (line 603), change "Font colour is derived from
  the assigned room's type and encodes room location" to say it is derived from
  the room's **site**, and note in one clause that the type-keyed version was
  equivalent until a type spanned two sites.
- Record Decision 8 in a sentence: a supervisor in a TR room raises
  `supervision_on_incompatible_slot`, this is the pre-existing off-site
  supervision gap rather than anything CK introduced, and `_SUPERVISOR_ROOM_TYPES`
  was deliberately not widened.

In `architecture.md`, the theming section's pinned-colour bullet mentions the
Q13 cell colour language — add that the font-colour half now keys on
`Room.site`, so the pinning still holds and the derivation changed.

In `planned_updates.md`, remove **"add treatment rooms and CK"** and **"add
cutteslowe kitchen"**. Leave **"trainees off site needs validation or local
supervisors"** in place — Decision 8 explicitly defers it.

Then delete this plan file.
