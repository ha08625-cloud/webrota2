# Provisional Plan — Treatment rooms (TR1/TR2/TR3) and CK

Stage 1 output: design decisions settled, gaps identified, provisional task
breakdown. Needs review into an implementation plan before any code is written.

## Scope

Four physical rooms the clinical rota does not currently model:

| Code | Site | Notes |
|---|---|---|
| TR1 | SHC | treatment room, nurses only |
| TR2 | SHC | treatment room, nurses only |
| TR3 | SHC | treatment room, nurses only |
| CK | Cutteslowe | Cutteslowe Kitchen; one specialist nurse |

They must be visible on the clinical rota (room view, doctor view, exports),
occupiable from the master rota and by manual edit, and **never** reachable by
any generation phase.

Out of scope: the "add nurse edit option" and "add med student" lines in
`planned_updates.md`, and anything that changes how nurses themselves behave —
`DoctorType.NURSE` and its inertness landed in PRs #388–392 and are the
foundation this builds on, not something to revisit.

## Design Decisions

### 1. A fifth `RoomType`, `TR` — not a boolean flag on `Room`

`RoomType` gains `TR = "TR"`, and all four rooms carry it (CK included —
the type says "nurse room the engine does not allocate", the `site` column
says where it is).

This is the mirror of `INERT_TYPES` for nurses, and it works for the same
reason: **every engine phase reaches rooms through an explicit room-type
allowlist**, never through "all rooms minus exclusions". The two places that
touch `context.rooms` unfiltered (`phase7_9a.py:353`, `room_relocation.py:67`)
immediately filter on `_ROOM_MOVE_FALLBACK_TYPES`. So a type absent from all of

- `phase7_9a._PASS3_FALLBACK_TYPE_ORDER` and its D-room pool
- `phase7_9a._ROOM_MOVE_FALLBACK_TYPES` / `room_relocation._ROOM_MOVE_FALLBACK_TYPES`
- `phase9c._SUPERVISOR_ROOM_TYPES`
- `phase4`'s D-room pool

is structurally unallocatable, with **no new code in any phase**. A boolean
`Room.generator_assignable` would be the opposite: default-open, one new check
per phase, and the next phase anyone writes is unguarded until they remember.

The same caveat the nurse work hit applies here, and gets the same answer:
absence is not something the code can state, so a phase author could add `TR`
to one of those tuples without noticing. `tests/test_engine/test_inert.py`
already asserts `INERT_TYPES` is disjoint from the four doctor-type tuples;
extend it (or add a sibling) to assert `RoomType.TR` is absent from every one
of the room-type tuples above. That test is what makes the guarantee real.

### 2. Preferred rooms are the one real hole, and are closed at the API boundary

This is the finding that changes the shape of the work. Three call sites walk a
doctor's preference list with **no room-type allowlist at all**:

- `phase7_9a.py:544` (Pass 3, first free preferred room wins — no filter whatsoever)
- `room_relocation.py:58` and `phase5.py:298` (filter out `D`, allow everything else)

So `Doctor.preferred_rooms` is the single path by which a generation phase
could put a doctor in TR1. Nothing else is.

Closed exactly the way **SR-is-not-a-clinic-room** is closed (see
`architecture-clinical.md`, "SR is not a selectable clinic room"), because that
precedent already settled this argument:

- **Both halves of the `room_id`/`room_type` XOR**, at the API: the Pydantic
  schema rejects `room_type == "TR"`, and the `PUT /doctors/{id}/preferred-rooms`
  handler resolves `room_id`s against the DB and rejects TR rooms by id.
- **Mirrored in the frontend** picker (`DoctorFormDialog.tsx`): TR filtered out
  of both the concrete-room `<select>` and the `ROOM_TYPES` token list. Note
  this is a *different* filter from the clinic-type one — `DoctorFormDialog`
  deliberately still offers SR, so the two lists genuinely diverge now and the
  comment at `ClinicTypeFormDialog.tsx:24` saying `ROOM_TYPES` is untouched
  needs updating.
- **Not enforced in the engine.** `load_context()` keeps expanding whatever is
  stored, so the engine stays honest about the data rather than silently
  disagreeing with it. A **Phase 0 warning** names a stored TR preference before
  the run instead of leaving it to be inferred from the output —
  `phase0._check_pre_assigned_sr_room` is the shape to copy.

Also extend the same rejection to `ClinicTypeRoomEligibility` (schema + router),
alongside the existing SR rejection: a clinic type eligible for TR1 would let
Phase 5 seat a doctor there.

Unlike SR, **this needs a data check**: the system is live, so the
implementation plan must confirm no existing `preferred_rooms` or
`clinic_type_room_eligibilities` row would newly become invalid. It cannot —
the rooms do not exist yet and `TR` is not a current enum value — so this is a
confirmation, not a migration. Say so explicitly rather than leaving it open.

### 3. Manual edits and the master rota are unrestricted

`set-room` (`rota.py:843`) and the master rota room setter
(`master_rota.py:158`) validate only that the room exists. They stay that way:
a human overriding the engine is trusted everywhere else in this app, and a TR
restriction there would be the only doctor-type-aware room rule in the codebase.

Consequence to accept knowingly: a rota admin can pin a Partner to TR2 from the
master rota, and the engine will honour it (Phase 2 copies `PRE_ASSIGNED` rooms
verbatim). That is a data-entry mistake the UI will show plainly in the room
view, not a hole the schema should be shaped around. **No Phase 0 warning for
this case** — decided; a warning on every nurse row would be noise, and
distinguishing "nurse in TR" from "Partner in TR" is exactly the doctor-type
room rule we just declined to write.

### 4. Cell font colour moves from room *type* to *site*

`cellStyle.ts`'s `ROOM_FONT_COLOR` is `Record<RoomType, FontColor>`:
D→black, SR→black, C→red, W→blue. That mapping is really a **site** mapping —
D and SR are SHC, C is Cutteslowe, W is Wolvercote — and room type has been a
faithful proxy for site only because no type has ever spanned two sites.

`TR` breaks the proxy: TR1–3 are SHC and CK is Cutteslowe, and the red "this is
off-site at Cutteslowe" signal is the whole point of the colour for CK.

So re-key `ROOM_FONT_COLOR` on `Room.site` (`SHC`→black, `Cutteslowe`→red,
`Wolvercote`→blue). For all fourteen existing rooms this is **provably
identical output** — worth stating in the task, because the colour language is
pinned as meaning-carrying in `architecture.md`'s theming section and a change
there normally needs an argument. `Room` already carries `site` and `RoomOut`
already exposes it, so no payload change. `exportStyles.ts` / `exportRotaPdf.ts`
go through `cellStyle`, so both exports follow with no separate edit.

If review prefers not to touch the existing mapping, the fallback is TR→black
and CK reads as an SHC room. That is worse and is recorded only so the option
is not rediscovered as an oversight.

### 5. Display order: `D, C, W, SR, TR`

`ROOM_TYPE_ORDER` in `pivotRoomRota.ts` gains `TR` at the end, so the four new
rows sit below SR in the room view and in the Excel/PDF room sheets, leaving
the familiar GAS layout untouched above them.

**This edit is not optional and is easy to miss**: `compareRoomDisplayOrder`
sorts on `ROOM_TYPE_ORDER.indexOf(...)`, and `indexOf` returns `-1` for an
unknown type — so forgetting it does not fail, it silently sorts the treatment
rooms *above* the D rooms. Worth a test asserting TR rows come last.

### 6. Rooms reach production by data migration, not by seeding

`/rooms` is read-only by design and `seed/seed_rooms.py` only runs against a
fresh database, so production needs migration `020` (`019` being whatever the
`ClinicType`/preferred-room work needs, if anything — the implementation plan
should settle the numbering) to `INSERT` the four rows, plus the Postgres
`ALTER TYPE room_type ADD VALUE IF NOT EXISTS 'TR'` — same shape and the same
load-bearing `IF NOT EXISTS` reasoning as `018_doctor_type_nurse.py`, since
migration `001` builds native enums from the *current* Python enums.

Two details for the migration task:

- The insert must be **idempotent on `code`** (`uq_rooms_code`). Seeding is a
  manual command, so a fresh DB that runs `alembic upgrade head` and then
  `seed.run_all` would otherwise hit the unique constraint. Either the migration
  skips codes that exist, or `seed_rooms.py` does — pick one and say which.
- Postgres will not let a value added to an enum by `ALTER TYPE` be *used* in
  the same transaction in older versions. Confirm the deployed Postgres major
  version, or split into two revisions, before assuming one revision works.
- Downgrade deletes the four rooms; it will fail on FK references from
  `master_rota_sessions.room_id` / session rows, which is the correct behaviour
  for narrowing, matching `018`'s stance.

### 7. `_ROOM_TYPE_TOKENS` in `seed_doctors.py`

`seed/seed_doctors.py:20` derives its preferred-room token set from
`RoomType`, so adding `TR` silently makes `TR` a valid CSV token — which
decision 2 has just banned at the API. Low stakes (seed data is ours), but the
seed parser should reject it too, or the two disagree.

## Provisional task breakdown

Rough shape for the implementation plan to firm up; task 1 must land before
anything else, the rest are largely independent.

1. **Data model and migration** — `RoomType.TR`, `seed_rooms.py`, the Alembic
   revision(s) for the enum value and the four rows, `seed_doctors.py` token
   rejection.
2. **Engine guarantee** — no phase code changes expected; the deliverable is
   the disjointness test asserting `TR` is absent from every room-type tuple,
   plus a generation test proving no phase seats anyone in a TR room when the
   rooms exist and nurses hold them.
3. **API boundary** — preferred-rooms and clinic-type-eligibility rejection of
   `TR` in both halves of the XOR (schema + router), Phase 0 warning for a
   stored TR preference, authorization sweep unaffected (no new routes).
4. **Frontend** — `RoomType` union in `api/types.ts`, `ROOM_TYPE_ORDER`,
   `ROOM_FONT_COLOR` re-keyed on site, TR filtered from `DoctorFormDialog`'s
   two preferred-room controls, `ClinicTypeFormDialog` filter extended and its
   stale `ROOM_TYPES` comment corrected.
5. **Master rota entry for the nurses** — the practical step that makes this
   visible: the nurses' TR/CK sessions entered as `PRE_ASSIGNED` rows on the
   active template. Data entry through the UI, not code; the plan should say
   whether it happens in this ticket or after.
6. **Review and documentation** — update `architecture-clinical.md` ("Rooms and
   doctors", the SR-clinic-room section's neighbour) and `architecture.md`'s
   theming note about the colour language now keying on site; remove the
   "add treatment rooms and CK" and "add cutteslowe kitchen" lines from
   `planned_updates.md`; delete this plan.

## Open questions for the review chat

- Does CK ever hold a non-nurse, or hold two people across AM/PM with different
  occupants? Nothing here depends on it, but it affects whether the master rota
  rows are per-week or identical across weeks 1–4.
- Are TR1–3 used every session of every week, or only some? If they are only
  occupied part of the time, the room view gains four rows that read "Available"
  much of the time — acceptable, but worth knowing before the rota admins see it.
- Should nurses appear in the doctor-view `RotaGrid` at all, or only in the room
  view? They will appear by default (they are `Doctor` rows), which is assumed
  correct here but was not explicitly decided.
