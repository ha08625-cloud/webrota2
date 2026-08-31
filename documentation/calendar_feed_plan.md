# Calendar Feed — Provisional Plan

**Status: provisional.** This is the output of the discussion phase. It records scope, design decisions and open questions; it is not yet broken into implementation tasks. The next step is to review and expand it into an implementation plan with the `#Task N` structure.

## Problem

Once a rota is committed, doctors have no way to see their sessions anywhere but in the web app. They want their rota in the calendar they already use — on their phone, alongside everything else.

## Approach: an ICS subscription feed

Each doctor gets a private, unguessable web address returning their own sessions in `.ics` format. The doctor pastes it into Google Calendar ("Other calendars" → "+" → "From URL") once. Google re-fetches it periodically and the calendar stays current by itself.

We never call Google. Google comes to us. There is no OAuth, no Google Cloud project, no stored third-party credentials, and nothing Google-specific — the same URL works in Outlook, Apple Calendar and NHSmail.

### Rejected alternative: Google Calendar API push

Writing events directly via the Google Calendar API was considered and rejected for now. It buys faster updates (seconds vs. Google's own poll interval, typically 8–24 hours), working event reminders, and proper free/busy blocking — subscribed calendars in Google support none of those. It costs an OAuth consent flow, encrypted refresh-token storage, a session→event-id mapping table, rate-limit and retry handling, full reconciliation on every edit/rollback/delete, and a permanent maintenance commitment to a third-party API. Roughly 2–3 weeks against 3–5 days, and Google-only.

The feed is the right first move: it delivers most of the value, and if the missing reminders or the refresh latency turn out to be unacceptable in practice, the API push can be built later without unwinding any of it.

**Worth confirming before building:** that the doctors are actually on Google, and that a once-daily refresh with no per-session alerts meets what they want. If they expect their phone to alert them before each session, the feed will disappoint them.

## Scope

**In scope**

- Per-doctor `.ics` feed of sessions on **committed** clinical rotas
- Token generation, display and rotation
- A frontend page where a logged-in user picks a doctor and copies that doctor's feed URL
- Practice-wide AM/PM session times

**Out of scope**

- Any link between `User` and `Doctor` — see "No identity link" below
- The reception rota. The same design generalises (a token column on `reception_staff`, a second feed route), but it is a separate ticket
- Draft rotas, and any push-based or Google-specific integration
- Per-clinic-type or per-doctor session times

## Design Decisions

### 1. No identity link between users and doctors

The feed is identified by a per-doctor token, not by who is logged in. The UI is: any logged-in user opens the calendar page, picks a doctor from a list, and copies that doctor's URL. Dr Smith is expected to pick Dr Smith; if they pick wrong they get the wrong rota in their calendar, notice immediately, and re-subscribe.

This is consistent with the existing authorization model rather than an exception to it. Every rota surface in the app — `DoctorsPage`, `RotaGrid`, the master rota, the leave planner — is already readable at every access tier; viewers see the whole app with write controls disabled. "Any logged-in user can see any doctor's rota" is how the system already works, so a per-doctor feed exposes nothing new internally.

The alternative — a real `User.doctor_id` link — would drag in a set of questions this feature does not need answered: whether one login can map to several doctor rows, whether every doctor gets a login, what the link means when a doctor is soft-deleted, and who may change it.

**This does not create debt.** If an identity link is ever wanted for something else (self-service leave requests, "email me my week", a doctor-scoped rota view), it can be added then and the token column here carries on working unchanged. The one thing it costs today is that nothing can be sent *to* a doctor automatically, because the system does not know their email address — the doctor must pull the URL themselves. That is inherent to the feed model anyway.

### 2. The token is unguessable, and each feed carries exactly one doctor

The feed URL cannot be authenticated: Google will not send a bearer token when it fetches. It is therefore a public URL on the open internet, and its only protection is being unguessable.

The framing "the rota contains no sensitive information" is not quite right and should not be leaned on. The feed reveals a named individual's working pattern and, by absence, when they are on leave. That is low-sensitivity staff personal data, but it is still personal data under UK GDPR. Two consequences:

- The token is a long random string (`secrets.token_urlsafe(32)`, matching the session-token generation already in `routers/auth.py`), not a doctor code or an id.
- Each feed contains **only that doctor's** sessions, so a leaked URL exposes one person's schedule rather than the whole practice's.

Rotation is the revocation path: issuing a new token immediately dead-ends the old URL. That covers both a leaver and a URL shared somewhere it shouldn't have been.

Note that any logged-in user can read any doctor's feed URL from the page. That is deliberate and follows from Decision 1 — the token defends against outsiders, not against colleagues, which is exactly the boundary the app already draws.

### 3. Tokens exist for every doctor from creation; the page is a pure read

Access levels run `manager > admin > doctor = nurse`, and `require_write_access` is attached globally in `main.py`, so a doctor-tier user cannot make *any* non-GET request outside `/auth` and `PATCH /users/me`. If "link my calendar" generated a token on click, a doctor could not click it.

So tokens are not generated on demand. Every doctor row has a token from creation, exactly as `routers/doctors.py` already guarantees every doctor row has one `SystemCounter` per type — same invariant shape, same place, and the same backfill-script pattern for existing rows (see `seed/backfill_system_counters.py` as the precedent). The calendar page then only ever performs a GET, and the write-gating problem disappears.

Rotation stays a write and is manager-only.

### 4. The public route is one GET in its own router

`main.py`'s docstring states the invariant that there is no fail-open mode and every router endpoint requires a valid session. An unauthenticated feed endpoint is a genuine, deliberate hole in that, and it needs to be structurally impossible to widen by accident.

- The feed lives in a **new router containing exactly one GET endpoint**, whose handler takes no `Depends(get_current_user)`.
- That router is added to `_UNGATED` in `main.py` — the third entry in a list whose comment says not to extend it without a specific reason. The reason: a calendar client fetching the feed cannot present a session token, so the token in the path *is* the credential.
- **All token management lives on the existing `doctors` router**, authenticated and write-gated normally.

That split is the point: the ungated surface is one route that cannot grow without someone consciously adding to it, and no authenticated endpoint is ever a near-neighbour of it.

Authentication in this codebase is per-endpoint (`Depends(get_current_user)` on each handler), not a router-level dependency, so this needs no change to how any existing router is wired.

### 5. Committed rotas only, recomputed on every request

Nothing is pre-generated or cached. Each request queries the current database state and builds the file fresh.

This is what makes the whole feature cheap, and it dissolves the hardest problem in the push-based design. `is_on_leave` is not stored — it is derived from `leave_entries` at read time — so a doctor's rota can change after commit with no `rota_sessions` row changing. Add rollback-commit, force-delete and post-commit leave edits, and a push model needs real reconciliation logic. A recomputed feed just tells the truth every time it is asked.

Consequences that fall out for free:

- A rolled-back rota reverts to `draft` and its sessions stop appearing.
- A force-deleted rota's sessions stop appearing.
- Leave added after commit removes the affected sessions.
- **Archived rotas are included.** `archived_at` is a pure UI visibility flag with no effect on the data; an archived rota is still a real committed rota, and its dates are usually in the past anyway.
- Drafts are excluded, because a draft changes constantly and publishing it would be noise.

Committed rotas cannot overlap (`find_overlapping_committed_rota` enforces this at generation), so no slot can produce two events.

Load is a non-issue at practice scale: a few dozen doctors, polled by Google a couple of times a day. If it ever mattered, an ETag is the cheap fix.

### 6. Session times are practice-wide constants

`Period` is `AM`/`PM` only — the system holds no clock times at all — but calendar events need them. There is no settings table in the schema and this does not justify creating one.

AM/PM start and end times become module-level constants with environment-variable overrides, following the `DOC_LOCK_PASSWORD` / `SOFFICE_BIN` precedent. Provisional defaults 09:00–13:00 and 14:00–18:00, to be confirmed with the practice.

All-day events were considered and rejected: two all-day blobs per day read badly in every calendar app and convey less than timed events.

### 7. Times are emitted in UTC, converted via `zoneinfo`

Sessions are stored as dates with no timezone. Emitting floating local times would be *nearly* correct for a single-site practice but breaks for anyone travelling. Emitting explicit UTC (`DTSTART:...Z`), converted from `Europe/London` via the standard-library `zoneinfo`, handles BST correctly, needs no `VTIMEZONE` block, and adds no dependency.

### 8. Stable event UIDs come from `rota_sessions.id`

Calendar clients update an existing event rather than duplicating it when the UID matches. `rota_sessions` has a standing invariant that a row exists iff a template entry existed at generation time — **edits mutate rows but never create or delete them** — so the row id is stable across every edit a rota can undergo. `<session_id>@<host>` is therefore a naturally stable UID with nothing extra to store.

### 9. Use a library for ICS serialisation

Recommend adding `icalendar` to the backend dependencies rather than hand-rolling the format. The event structure is trivial, but the serialisation rules are not: CRLF line endings, line folding at 75 octets, and escaping commas, semicolons and backslashes in text fields. Room codes and free-text `notes` will contain exactly those characters, and getting it wrong produces a file Google silently refuses to parse — a failure mode that is painful to diagnose because the only symptom is a calendar that never appears.

## Open Questions

These need answers before the implementation plan is finalised.

1. **What should a leave day show?** Options: omit the session entirely (the doctor is not working, so nothing appears); or omit the session and emit an all-day "Annual leave" event. Recommend the second — a blank day is ambiguous, and seeing leave confirmed in your own calendar is useful. Needs a decision because it changes the query shape.
2. **What should the event title be?** Available: room code, clinic type name, session role, WFH flag, supervising flag, free-text notes. Recommend `"<Room code> — <Clinic type>"` as the summary with the rest in the description, but this is worth showing a doctor before building.
3. **What are the actual AM/PM times?** Defaults above are placeholders.
4. **How far back should the feed reach?** Emitting all history forever makes the file grow without bound. Recommend a rolling window — everything future, plus roughly the last 8 weeks.
5. **Closed slots.** `RotaClosure` snapshots closures per rota by `(date, period)`. Confirm that sessions in a closed slot should be omitted (near-certainly yes) and that reading the snapshot rather than the live closure table is correct here, matching `GET /rota/{id}`.
6. **Should WFH sessions appear differently?** They are real working sessions with no room. Probably a title prefix; needs a decision.

## Provisional Task Breakdown

Rough shape only — to be expanded, with file lists and deliverables, in the implementation plan.

1. **Data model** — `calendar_token` column on `doctors` (nullable, unique, indexed), Alembic migration, token generated at doctor creation in `routers/doctors.py`, backfill script for existing rows.
2. **Feed builder** — a pure module that takes a doctor and a date window and returns ICS bytes: query committed rotas, derive dates (`engine/week_map.build_week_dates` is directly reusable and has no engine-context dependency), subtract leave and closures, apply session times, serialise. Unit-testable with no HTTP involved.
3. **Public route** — the single-endpoint ungated router, `_UNGATED` registration, 404 on unknown or rotated tokens, correct `text/calendar` content type. Tests must cover that the endpoint needs no auth *and* that nothing else in the app became reachable without it.
4. **Token management** — `GET /doctors/{id}/calendar-feed` returning the URL (any tier), rotation endpoint (manager-only).
5. **Frontend** — a page under the clinical shell with a doctor picker, the URL, a copy button, rotation for managers, and per-app subscription instructions for Google, Outlook and Apple. Route and nav entry in `App.tsx`.
6. **Documentation** — fold the design decisions into `documentation/architecture-clinical.md` (feature) and `documentation/architecture.md` (the `_UNGATED` exception, which is shared-infrastructure information), then delete this plan.

## Estimate

3–5 days, assuming the open questions are answered up front.
