# Plan

A read-only room-occupancy view of a generated rota, toggled inside `RotaDetailPage` as an alternative to the existing doctor grid. Answers "which rooms are free this session, and who is in the occupied ones" at a glance. Pure frontend transformation of data already fetched (`rota.sessions` via `useRota`, rooms via `useRooms`); no backend change, no new endpoint, no new query.

**Dependency:** the "leave frees rooms" ticket is expected to land first (Phase 2 stops occupying rooms for on-leave slots; leave endpoints clear `room_id` on the active draft). This plan does not depend on it structurally, but Design Decision 4 (leave-holder rendering) exists because committed rotas with post-commit leave can still show an on-leave room holder even after that ticket.

# Scope

In scope:

- `frontend/src/lib/pivotRoomRota.ts` + test — session list pivoted to room-keyed cell lookup.
- `frontend/src/components/WeekTabs.tsx` — the week tab strip extracted from `RotaGrid` so both grids share one implementation.
- `RotaGrid` becomes week-controlled (`activeWeek` + `onWeekChange` props); `RotaDetailPage` owns `activeWeek`.
- `frontend/src/components/RoomRotaGrid.tsx` + test — the room view.
- Doctor view / Room view toggle in `RotaDetailPage`, week selection preserved across the toggle.
- `data-week-day-period` attributes on room grid cells so IssuesPanel navigation keeps working in room view.
- Test updates for `RotaGrid_test.tsx`, `RotaDetailPage_test.tsx`.

Out of scope (explicitly):

- Any editing from the room view — no drag-and-drop, no popover, no undo. Edits happen on the doctor grid.
- Export or printing of the room view.
- Any backend change.
- Wiring cross-week IssuesPanel navigation (`onNavigateToWeek`) — see Design Decision 8.

# Design Decisions

1. **Row order is room_type-grouped, not site-grouped.** Explicit order `D, C, W, SR` (a `ROOM_TYPE_ORDER` constant in `pivotRoomRota.ts`), then `code` ascending within a type. This reproduces the familiar GAS layout (D1-D8, C1-C3, W1-W2, SR) while staying data-driven from `useRooms()` — no hardcoded room-code array. Site-then-code was considered and rejected: it interleaves SR into the SHC D-rooms and puts Cutteslowe first.

2. **Single-occupancy invariant, documented pivot.ts-style.** The cell lookup is `Map<string, RotaSession>` keyed `(room_id, week, day, period)` — a single session per key, which silently drops a duplicate holder if one ever existed. That reliance is safe and must be documented in a docstring on the map, mirroring `pivot.ts`'s row-existence docstring: at most one session holds a room per slot, enforced by the engine's `_room_occupancy` index at generation time and by displacement in every room-writing edit endpoint (`set-room` displaces via `_find_room_holder`, `swap-rooms` swaps, `set-role` only ever clears). `_find_room_holder`'s own defensive `.first()` acknowledges the same "impossible by construction" stance. Do not build duplicate handling; do state the invariant and what it rests on.

3. **Occupied cell content: doctor code + role label + badges.** `doctor_code` on the first line, then the same role vocabulary as the doctor grid — "Duty", "Duty (2nd)", clinic type name — via the existing `RoleLabel` component (export it from `RotaGrid.tsx`; it is currently module-private). This is a deliberate upgrade over GAS's DD/DH/SC/ST two-letter codes. A supervising session keeps its "Supervising" badge (plain "Supervising" is sufficient here — do not thread the supervisee-count memo through; that detail lives on the doctor grid).

4. **Leave holders render as occupants with a LEAVE badge, not as available.** After the leave-frees-rooms ticket, an on-leave session holding a room should be rare on drafts — but remains reachable on committed rotas when leave is added post-commit (that ticket's endpoint side effect is draft-only). When `session.is_on_leave` is true, render the doctor code plus a LEAVE badge on the occupied (red) background. Rationale: on a committed rota nothing can be reassigned anyway, so "available" would be a false promise; showing the holder honestly is cheap. WFH-with-room is unreachable (PATCH clears the room, set-room clears the flag, generation never rooms a WFH slot) — no WFH branch is needed, but if `is_wfh` were somehow true, the generic occupied rendering is an acceptable fallback.

5. **Colour language is availability-first, not Q13.** Occupied: `bg-red-100`. Available: `bg-green-100` with an "Available" label. Closed-day cells: grey (`bg-gray-200`), no label per cell (the column header carries "closed"/the closure name). This deliberately diverges from the doctor grid's Q13 palette (where green = clinic): the room view's single job is instant yes/no room availability, and red/green is unambiguous for that. Consequence accepted: green means different things in the two views. Room-type font colouring is dropped entirely — the row *is* the room, so the encoding is redundant; use default ink.

6. **Closed days: the date decides, not data absence.** Phase 2 creates no sessions on closed dates, so every room cell in a closed column is naturally empty — which means the occupancy lookup alone would render a closed day as a full column of green "Available" cells. The component must therefore compute the day's closed status first (via `rotaDate` from `weekDates.ts` against a `Set` of `rota.closed_dates` — the snapshot, authoritative, same as `RotaGrid`) and short-circuit to the grey closed cell before any occupancy lookup. The header grey/label duplicates `RotaGrid`'s header logic including the cosmetic live `useClosures()` name lookup; this small duplication is accepted rather than extracting a shared day-header component (two call sites, divergent `<th>` styling contexts).

7. **Layout per week tab: Morning block then Afternoon block, rooms x days.** Matches the GAS sheet layout, adapted to per-week tabs instead of all-weeks-side-by-side. Each block: a "Morning" / "Afternoon" heading row, then one row per room (sticky room-code column on the left), Monday-Friday columns. Heavier dividers between room_type groups, mirroring the doctor grid's per-doctor group dividers. Both blocks repeat the day header row (each block is its own `<table>` or `<thead>` section — implementer's choice, but day headers must appear above both blocks so the Afternoon block is readable without scrolling up).

8. **`activeWeek` lifts to `RotaDetailPage`; `onNavigateToWeek` stays unwired.** `RotaDetailPage` owns `const [activeWeek, setActiveWeek] = useState(1)` and passes `activeWeek`/`onWeekChange` to whichever grid is mounted, so toggling views preserves the selected week. IssuesPanel's `onNavigateToWeek` prop is deliberately still not passed: its `navigateTo` runs `document.querySelector` synchronously after the callback, before React re-renders the target week's cells, so wiring it naively would change the tab but fail the scroll/flash. Making cross-week navigation actually work needs a deferred query (effect or rAF) and is a separate small ticket. Same-week navigation continues to work in both views via Decision 9. NOTE: IssuesPanel.tsx's docstring claims this wiring exists ("Task 4 wiring"); the project copies of RotaDetailPage/RotaGrid show it does not. Confirm against the repo before starting Task 2 — if the wiring exists there, Task 2's RotaDetailPage half is already done and this decision's rationale should be re-checked against the real implementation.

9. **IssuesPanel navigation works in room view via the same attribute.** Every room cell — occupied, available, and closed — carries `data-week-day-period="{week}-{day}-{period}"`, exactly as every doctor-grid cell (including absent ones) does. `navigateTo`'s `querySelector` takes the first DOM match; on the doctor grid that is already "first row of the relevant column", so the room view inherits identical semantics (first room row of the relevant block) with zero IssuesPanel changes.

10. **The toggle is page-level, plain buttons, available for drafts and committed rotas alike.** `view: "doctor" | "room"` state in `RotaDetailPage`; two buttons above the grid area ("Doctor view" / "Room view", `aria-pressed`, styled like the existing secondary buttons). The room view is read-only regardless of rota status, so no `editable` prop, no `DndContext`, no popover — structurally closer to `ReadOnlyGridCell` than to `EditableGridCell`. The toggle does not persist across navigation; every visit starts on the doctor view.

11. **Rooms with no sessions anywhere still render.** Rows come from `useRooms()` (all 14), not from the session list — a room unused all rota reads as a full row of "Available", which is the point of the view.

# Task 1: pivotRoomRota lib

A. State of the world: nothing for this feature exists yet. This task creates the pure transformation module; no UI, no page changes. It is independently shippable.

B. Files and deliverables:
- Create frontend/src/lib/pivotRoomRota.ts
- Create frontend/src/lib/pivotRoomRota_test.ts
- Read for reference: frontend/src/lib/pivot.ts (conventions to mirror), frontend/src/api/types.ts (RotaSession, Room, RoomType, Day, Period)

C. Instructions:

Export from pivotRoomRota.ts:

ROOM_TYPE_ORDER: RoomType[] = ["D", "C", "W", "SR"]
compareRoomDisplayOrder(a: Room, b: Room): number — index in ROOM_TYPE_ORDER first, then code with localeCompare (numeric-aware compare is unnecessary at 14 rooms with single-digit codes, but localeCompare(b.code, undefined, { numeric: true }) is fine and future-proof; either is acceptable, pick one and test it).
interface PivotedRoomGrid { rows: Room[]; cells: Map<string, RotaSession>; }
pivotRoomRota(sessions: RotaSession[], rooms: Room[]): PivotedRoomGrid — rows are the full rooms list sorted by compareRoomDisplayOrder; cells map roomKey(room_id, week, day, period) to the session for every session whose room_id is non-null. Sessions with room_id === null are skipped (they have no home in a room-keyed view; unresolved-room warnings surface via the IssuesPanel, not here).
getRoomCell(grid, roomId, week, day, period): RotaSession | undefined
Reuse DAYS, PERIODS, weekNumbers from pivot.ts by import at call sites — do not re-export or duplicate them here.
The cells docstring must state the single-occupancy invariant per Design Decision 2, including where it is enforced (engine _room_occupancy index at generation; displacement in set-room via _find_room_holder, swap semantics in swap-rooms, clear-only behaviour in set-role), and that a duplicate would be silently last-write-wins — a documented reliance, not handled code.

Tests (pivotRoomRota_test.ts, Vitest, mirror pivot_test.ts style; reuse or extend session builders from frontend/src/test/fixtures/rota.ts and room fixtures from the reference fixtures module if present — check frontend/src/test/fixtures/ before writing new builders):

Sort order: given rooms shuffled across all four types, rows comes back D-rooms by code, then C, then W, then SR. Include a site-order trap: a C room and a D room where site-alphabetical order would differ from type order, proving type wins.
Occupancy: a session with a room lands under the right key; getRoomCell returns it; a different (week/day/period) misses.
Null rooms skipped: a session with room_id: null produces no cell.
Room with no sessions: still present in rows.

# Task 2: Controlled week state and WeekTabs extraction

A. State of the world: Task 1 is complete (pivotRoomRota.ts exists, tested). RotaGrid currently owns activeWeek in local useState and renders its own tab strip inline; RotaDetailPage passes no week state. This task makes week selection page-owned so Task 4's toggle preserves it, and extracts the tab strip for reuse by Task 3. PRE-FLIGHT: confirm against the repo that RotaDetailPage does not already own activeWeek / pass onNavigateToWeek (see Design Decision 8's stale-file note). If it does, skip the RotaDetailPage half and only do the WeekTabs extraction plus prop-threading.

B. Files and deliverables:
- Create frontend/src/components/WeekTabs.tsx
- Edit frontend/src/components/RotaGrid.tsx (controlled week props; export RoleLabel)
- Edit frontend/src/routes/RotaDetailPage.tsx (own activeWeek)
- Edit frontend/src/components/RotaGrid_test.tsx, frontend/src/routes/RotaDetailPage_test.tsx as needed

C. Instructions:

WeekTabs.tsx: props { weeks: number[]; activeWeek: number; onWeekChange: (week: number) => void }. Move the existing tab-strip JSX from RotaGrid verbatim (role="tablist", aria-selected, identical classes), including the "tabs always render even for one week" behaviour and its comment.

RotaGrid.tsx:
- Replace the internal useState with props: activeWeek: number, onWeekChange: (week: number) => void. Keep computing weeks internally from rota.num_weeks (the page doesn't need it). Render <WeekTabs> where the inline strip was.
- Defensive clamp: if activeWeek exceeds rota.num_weeks (cannot happen from this page's wiring, but props are props), render week content for Math.min(activeWeek, rota.num_weeks) or simply trust the caller — pick trusting the caller and note it; the page initialises to 1 and only sets values from the tabs.
- Export RoleLabel (needed by Task 3). No behaviour change.

RotaDetailPage.tsx: add const [activeWeek, setActiveWeek] = useState(1); pass both props to RotaGrid. Do NOT wire onNavigateToWeek on IssuesPanel (Design Decision 8).

Tests: update RotaGrid_test.tsx renders to supply the new props (a tiny stateful wrapper component in the test file where tab-clicking is exercised); RotaDetailPage_test.tsx should still pass unchanged or with minimal prop-plumbing fixes. Add one page-level assertion: clicking Week 2 then re-rendering keeps Week 2 selected (this becomes the toggle-persistence test's foundation in Task 4).

# Task 3: RoomRotaGrid component

A. State of the world: Tasks 1-2 complete — `pivotRoomRota` exists, `WeekTabs` exists, `RotaGrid` is week-controlled, `RoleLabel` is exported. This task builds the room view component in isolation; it is not yet reachable from any page.

B. Files and deliverables:
- Create `frontend/src/components/RoomRotaGrid.tsx`
- Create `frontend/src/components/RoomRotaGrid_test.tsx`
- Read for reference: `RotaGrid.tsx` (header/closure logic to mirror, divider conventions), `pivotRoomRota.ts`, `weekDates.ts`, `api/rooms.ts`, `api/closures.ts`

C. Instructions:

Props: `{ rota: Rota; activeWeek: number; onWeekChange: (week: number) => void }`. No mutation callbacks, no editable flag.

Data: `useRooms()` (loading guard like RotaGrid's), `useClosures()` (name lookup only). Memoise `pivotRoomRota(rota.sessions, rooms ?? [])`, `closedDatesSet` from `rota.closed_dates`, and `closureNameByDate` from live closures — the last two copied from `RotaGrid` with their docstrings (authoritative-snapshot vs cosmetic-name distinction preserved verbatim; accepted duplication per Design Decision 6).

Render: `<WeekTabs>` then, per Design Decision 7, a Morning block and an Afternoon block. Each block: heading ("Morning" / "Afternoon"), day header row with the closed grey + closure-name treatment copied from `RotaGrid`'s header, then one row per `grid.rows` room — sticky left cell with `room.code`, heavier `border-b-2 border-ink/40` divider on the last row of each room_type group (compute group boundaries from consecutive rows' `room_type`).

Cell logic, in this order:
1. Closed date (`closedDatesSet.has(rotaDate(rota.start_date, activeWeek, day))`) → grey `bg-gray-200` empty cell. This check MUST precede the occupancy lookup (Design Decision 6 — otherwise closed days render as available).
2. `getRoomCell(...)` hit → occupied: `bg-red-100`, doctor code (font-medium), `<RoleLabel role={session.role} clinicName={session.clinic_type_name} />`, a LEAVE badge when `session.is_on_leave` (Design Decision 4), a "Supervising" badge when `session.is_supervising` (plain text, no count).
3. Miss → available: `bg-green-100`, small "Available" label.

Every cell in all three branches carries `data-week-day-period={"${activeWeek}-${day}-${period}"}` (Design Decision 9). Add `data-testid={"room-cell-${roomId}-${activeWeek}-${day}-${period}"}` on occupied/available cells for tests, mirroring the doctor grid's convention.

Tests (`RoomRotaGrid_test.tsx`, RTL + fixtures; MSW handlers for `/rooms` and `/closures` already exist in `frontend/src/test/msw/handlers.ts` — extend only if the fixtures lack what's needed):
- Row order: rendered room codes appear in D, C, W, SR order.
- Occupied cell: doctor code and role label ("Duty" / clinic name) visible, red background class present.
- Available cell: "Available" label, green background class.
- Leave holder: `is_on_leave: true` session with a room renders code + LEAVE badge, not "Available".
- Closed day: with a `closed_dates` entry, that day's header is greyed/labelled and its cells are grey with no "Available" text — the regression test for Design Decision 6.
- Both Morning and Afternoon blocks render; an AM-only occupied session shows in Morning and the same room reads Available in Afternoon.
- Cells carry `data-week-day-period` attributes.

# Task 4: Toggle wiring in RotaDetailPage

A. State of the world: Tasks 1-3 complete — the room view component exists and is tested standalone; `RotaDetailPage` owns `activeWeek` but always renders `RotaGrid`. This task adds the view toggle and finishes the feature.

B. Files and deliverables:
- Edit `frontend/src/routes/RotaDetailPage.tsx`
- Edit `frontend/src/routes/RotaDetailPage_test.tsx`

C. Instructions:

Add `const [view, setView] = useState<"doctor" | "room">("doctor")`. Above the grid/IssuesPanel row, render two buttons "Doctor view" / "Room view" with `aria-pressed` reflecting the active one, styled consistently with the existing secondary buttons (border-border pattern). Render `RotaGrid` or `RoomRotaGrid` accordingly, both receiving `activeWeek`/`onWeekChange`. IssuesPanel stays mounted in both views unchanged. Undo/Commit/Scrap buttons remain rendered per existing draft/committed logic regardless of view — they are page-level actions, not grid features (undo still replays fine while the room view is showing; the cache splice re-renders both views' source data).

Tests: toggle switches which grid renders (assert on a room-view-only element like an "Available" cell vs a doctor-grid-only element); selecting Week 2, toggling to room view, and toggling back stays on Week 2; committed rota also offers the toggle.