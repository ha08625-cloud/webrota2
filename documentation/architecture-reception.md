# Reception Rota — Architecture

A second, independent rota type for reception staff, living under `/reception`. One day at a time, hourly divisions 8am–6pm (10 slots), one role per staff member per hour (`phones`/`other`), validated against a configurable minimum phone-coverage rule.

Nothing is shared with the clinical rota (`architecture-clinical.md`) except auth, the app shell, the HTTP client, and deployment — no doctors, rooms, clinic types, counters, leave, closures, duty, staging, or generation-engine code is touched or reused, in either direction. Full history and the decision-by-decision rationale behind everything below lives in `documentation/completed/reception_rota.md` (the implementation plan this feature was built from); this document records only what reading the code will not tell you.

## Why a separate `reception_staff` table

Reception staff are never doctors and never appear on a clinical rota. `reception_staff` (`id`, `code` unique, `name`, `active`) has none of the fields that exist to serve the generation engine — no employment window, no `sessions_per_week`, no preferred rooms, no supervision, no signature, no counters. The nav deliberately labels this page "Reception Staff", not "Staff" — the clinical nav already uses "Staff" for doctors, and a second page with the same label in a sibling shell is a support-conversation footgun.

## Hour model

Hours are a plain integer 8–17 (one column, `hour = 8` means the 8–9am slot), not a ten-member enum — a Postgres `CREATE TYPE` would carry no semantics the integer lacks and would sort by declaration order rather than naturally. Check-constrained (`ck_rms_hour`/`ck_rrs_hour`/`ck_rcr_hour`, `hour BETWEEN 8 AND 17`) on every table that carries one.

The range lives in exactly one place, `RECEPTION_FIRST_HOUR`/`RECEPTION_LAST_HOUR`/`RECEPTION_HOURS` in `backend/app/models/reception.py`, imported by the seed, every router, and the tests; the frontend mirrors it in `frontend/src/lib/receptionHours.ts`. **Widening the practice's opening hours is therefore a migration** (loosening the constraint) plus new coverage-rule seed rows — accepted for v1 because the alternative, opening hours as runtime configuration, would force every read path to resolve them dynamically for a change that happens approximately never.

## The weekday template has no header, deliberately

`reception_master_sessions` is `(staff_id, day, hour, role, note)`, unique on `(staff_id, day, hour)` — **one template with a `day` column, not five per-weekday templates, and no header/version table at all.** This is a deliberate divergence from `master_rota_templates`: reception has no active/inactive concept and no staging, so a header would only reproduce `MasterRotaTemplate.is_active`'s known ambiguity (not schema-enforced unique, readers resolve deterministically — see `architecture-clinical.md`) for nothing gained. If template versioning is ever wanted, adding a header later is a straightforward additive migration.

Row existence is the data, exactly as on `master_rota_sessions`: a staff member with no row for `(Tuesday, 14)` is not expected at 2pm on Tuesdays. Editing a working pattern means creating/deleting rows, not just updating them.

There is deliberately **no displacement rule** on this template's write surface, unlike the clinical master rota's. The clinical template needs one because a room can be held by only one doctor; a reception hour has no exclusive resource, so several staff sharing a `(day, hour)` slot is the normal case, not a conflict.

## `role` + `note`, not a wider enum

`ReceptionRole` is deliberately two values (`phones`/`other`) — the coverage rule only ever asks "is this person on phones or not", so two values is the correct modelling of the *rule*. A nullable free-text `note` (`String(200)`, on both the template row and the day row) carries what `other` actually means in a slot — "post", "training", "GP meeting" — as pure annotation with no behaviour attached, mirroring `RotaSession.notes`. This is what keeps the first "we need a third category" request a data entry, not a migration. A `note` on a `phones` row is legal and displays the same way; nothing validates the pairing.

## A generated day has a header despite having no lifecycle

`reception_rotas` (header: `id`, `date` unique, `created_at`) plus `reception_rota_sessions` (`(rota_id, staff_id, hour, role, note)`, unique `(rota_id, staff_id, hour)`, ORM-cascade from the header) is the whole of a generated day. There is no `status`, no `committed_at`, no snapshot table — no lifecycle exists to track, unlike `generated_rotas`.

The header exists for exactly one reason: **without it, "this date has never been generated" and "this date was generated and then every row was deleted" are indistinguishable**, and the day page cannot decide whether to offer "Generate" or "you are editing an existing day". `GET /reception/rota?date=` 404ing is the page's entire signal.

Day rows are self-contained snapshots, copied from the template at generate time and never re-derived — the same principle as `RotaSession.template_type`. A template edit made after a day is generated does not change that day.

## Generate is a copy; regenerating 409s

`POST /reception/rota` (body `{date}`) creates the header and copies every `reception_master_sessions` row for that date's weekday, **active staff only**, into `reception_rota_sessions`. A weekend date is 422 (mirrors `ClosureIn`'s validator). **A date that already has a header is a 409 naming the existing rota — never a silent overwrite of hand-edited rows.**

Clearing is explicit: `DELETE /reception/rota/{id}` hard-deletes the header (sessions cascade), and the date becomes generatable again. "Regenerate" in the UI is delete-then-generate behind a confirm dialog, not a force flag on the POST — the confirm is where the user is told edits will be lost; the server enforces no part of the confirm itself.

## No engine, no phases, no `RotaConfig`

There is no eligibility to resolve, no room to allocate, no counter to balance, no fairness to enforce — nothing that would justify a pipeline. The entire "generation" is the copy loop in `reception_rota.py`'s `POST ""` handler. Nothing under `backend/app/engine/` is imported by, or aware of, any reception code (the one shared import, `engine.week_map.DAY_ORDER`, is a plain weekday-ordering constant, not engine logic).

## Coverage rules are keyed `(day, hour)`, not `hour` alone

`reception_coverage_rules`: `(day, hour, min_phones_staff)`, unique `(day, hour)`. Monday 9am and Friday 3pm are not the same staffing problem, and a rule table that couldn't express the difference would need the `day` column added within the first month of real use — a migration, a seed backfill, and a rules-page rework, versus one extra column and 40 more seed rows up front. Seeded at 3 staff for hours 9 and 10, 2 for every other hour, across all five weekdays (`seed_reception_coverage.py`, 50 rows, not idempotent — reruns fail on `uq_rcr_slot`, the same incidental protection every other seeder relies on).

**A missing `(day, hour)` rule row reads as "no minimum" (no warning possible) — not as zero-required-and-therefore-satisfied.** Same practical outcome, but stated so the empty-table case has a defined meaning rather than being an accident.

Editable via `PATCH /reception/coverage-rules/{id}` only — deliberately **no POST, no DELETE**: the row set is fixed by the seed at one row per `(day, hour)`, and the only meaningful edit is the number.

## Validation: a read-time derivation, not a stored state

`compute_coverage_issues()` (in `routers/reception_rota.py`) counts `phones` sessions per hour off the rota's already-loaded sessions (no per-hour requery) and emits one `ValidationIssueOut` per hour short of its `(day, hour)` rule — `severity="warning"`, `phase="coverage"`, `check="phones_shortfall"`. Nothing is persisted; there is no `severity="error"` path anywhere in this feature, and nothing here can block a save. `ValidationIssueOut` is reused verbatim from `schemas/common.py` (day plus the existing severity/phase/check/message fields) rather than adding a near-duplicate schema for one integer.

Every mutating endpoint except the two 204 deletes returns `{session, issues}` with issues recomputed in the same transaction as the write — this is what lets the frontend splice both the cell and the warnings from one response, with no second request. `GET /reception/rota/{id}` (and `?date=`) return the same freshly computed issues, so a freshly loaded page is already correct.

## Absence is invisible until the row is deleted — a stated v1 limitation

Reception leave/absence tracking is out of scope for v1. Coverage counts **anybody holding a `phones` row** for an hour; a receptionist who calls in sick still reads as covering that hour until their rows for that day are deleted. Deleting the row **is** the absence mechanism — `DELETE /reception/rota/{id}/sessions/{sid}` — mirroring the clinical rota's "cell absence is data" convention exactly, but this is a real limitation of the current system, not an oversight, and should be treated as one if it surfaces as a support report. Adding a reception leave table later would become an additional filter inside `compute_coverage_issues`, with no other change to anything described above.

## Router surface

Four routers under `/reception`, one module each, mirroring the codebase's one-router-per-resource convention:

| Router | Responsibility | Key behaviour |
|---|---|---|
| `/reception/staff` | Reception staff CRUD | `GET` active-only by default, `include_inactive` query param (this page is the only reactivation path — unlike `DoctorsPage`, there is no committed-rota concept to gate reactivation behind). `DELETE` is unconditionally a soft delete (`active=False`, 204) — no blocking logic, since there is nothing for a deactivated staff member to be blocking |
| `/reception/coverage-rules` | Coverage rule read/patch | `GET` all rules (ordered `day, hour` — sorted in Python, since `Day` is stored by value and an SQL `ORDER BY day` would give alphabetical, not weekday, order). `PATCH /{id}` sets `min_phones_staff` only |
| `/reception/master` | The weekday template's read/write surface | `GET ""` the full flat list joined to staff code/name, ordered `day, hour, staff_code`. `POST /sessions` pre-checks the `(staff_id, day, hour)` slot for a descriptive 409 (the same documented exception to catch-`IntegrityError` the clinical master-rota POST makes). `PATCH /sessions/{id}` is a verbatim `(role, note)` pair setter — both fields always required, undo-friendly. `DELETE /sessions/{id}` hard deletes, 204, nothing to cascade. Permissive by design (no active-staff check server-side), matching the clinical template's writers |
| `/reception/rota` | The day grid: generate, edit, coverage | `POST ""` generates (see above). `GET ""` (`?date=`, 404 if none) is how the page picks "Generate" vs "editing". `GET /{id}` the day. `POST/PATCH/{id}/sessions[/{sid}]` add/edit a slot, `{session, issues}`. `DELETE /{id}/sessions/{sid}` is the absence mechanism (204). `DELETE /{id}` deletes the whole day (sessions cascade), backing the regenerate-behind-a-confirm flow |

All four require a valid session (`Depends(get_current_user)`) — the same auth seam as every clinical router, no separate reception auth path.

## Data model

```
reception_staff              id, code (unique), name, active
reception_master_sessions    id, staff_id FK, day, hour, role, note
                              unique (staff_id, day, hour)   uq_rms_slot
                              check  hour BETWEEN 8 AND 17   ck_rms_hour
reception_rotas               id, date (unique), created_at
reception_rota_sessions       id, rota_id FK (ORM cascade), staff_id FK,
                              hour, role, note
                              unique (rota_id, staff_id, hour)  uq_rrs_slot
                              check  hour BETWEEN 8 AND 17      ck_rrs_hour
reception_coverage_rules      id, day, hour, min_phones_staff
                              unique (day, hour)             uq_rcr_slot
                              check  hour BETWEEN 8 AND 17   ck_rcr_hour
```

`ReceptionRole(str, enum.Enum)`: `PHONES = "phones"`, `OTHER = "other"` — in `models/enums.py` alongside the clinical enums, stored by value via the same `enum_col()` helper. `Day` is reused from `models/enums.py` (already Monday–Friday only); `Period` (AM/PM) is not used anywhere in this domain.

Five tables total, all additive in a single migration: **`018_reception_rota.py`** — the first migration since the `001` baseline to **create a new** Postgres enum type (`reception_role`) rather than reuse an existing one with `create_type=False`; it is also this migration's own to drop in `downgrade()`, since nothing else references it. `day` on `reception_master_sessions`/`reception_coverage_rules` reuses the existing `day` enum type via the same helper 011/014/015/016 use. No backfill anywhere — all five tables start empty.

Reception staff are **not seeded** (entered through the UI, like clinic types); coverage rules are seeded (`seed_reception_coverage.py`, registered in `run_all.py`).

## Frontend

`ReceptionShell` in `App.tsx` mounts at `/reception/*`, alongside `ClinicalShell` at `/clinical/*` — a separate nav (`RECEPTION_NAV_ITEMS`: Day Rota, Master Template, Reception Staff, Coverage Rules) built the same way as the clinical one, sharing only the header's "Switch app"/"Log out" chrome and `useHandleLogout`.

**The master template page and the day rota page share one grid stack** (`pivotReception.ts`, `ReceptionGrid.tsx`, `ReceptionCellPopover.tsx`) — a generic `PivotedReceptionGrid<T extends ReceptionCellData>` that both `ReceptionMasterSession` and `ReceptionRotaSession` satisfy structurally (the day-rota row simply has no `day` field, since the date is fixed by the rota it belongs to). This is deliberate, in-domain reuse: the two grids are the same `staff × hour` shape, just template rows vs. a dated snapshot.

That is a different call from the clinical boundary: **nothing in this stack is shared with `MasterRotaGrid`/`RotaGrid`/`CellEditPopover`**, even though those are also grids of cells with popovers. The axes differ (staff × hour vs. doctor × day/period), there is no drag-and-drop on the reception side, and no displacement rule to reconcile — forcing a shared abstraction across the domain boundary would make both harder to read for no benefit. Read the clinical components for style only, never for reuse.

`api/reception.ts` holds all four routers' TanStack Query hooks under one `receptionKeys` object (flat keys per resource, not nested — matching `rotaKeys`/`doctorKeys`/`masterRotaKeys`'s existing convention). Reference data (staff, coverage rules) invalidates-and-refetches; the day rota and master template splice the mutation response (`{session, issues}`) into the cache, same convention as the clinical grids.
