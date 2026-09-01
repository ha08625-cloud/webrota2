# Calendar Feed — Implementation Plan

**Status: ready to implement.** Expanded from the provisional plan after a code review of the surfaces it touches. All six open questions are answered below and folded into the design decisions; the task breakdown is the delivery order.

## Plan

Once a rota is committed, doctors have no way to see their sessions anywhere but in the web app. Each doctor gets a private, unguessable URL returning their own sessions in `.ics` format. The doctor pastes it into Google Calendar ("Other calendars" → "+" → "From URL") once; Google re-fetches it periodically and the calendar stays current by itself.

We never call Google. Google comes to us. There is no OAuth, no Google Cloud project, no stored third-party credentials, and nothing Google-specific — the same URL works in Outlook, Apple Calendar and NHSmail.

### Rejected alternative: Google Calendar API push

Writing events directly via the Google Calendar API was considered and rejected for now. It buys faster updates (seconds vs. Google's own poll interval, typically 8–24 hours), working event reminders, and proper free/busy blocking — subscribed calendars in Google support none of those. It costs an OAuth consent flow, encrypted refresh-token storage, a session→event-id mapping table, rate-limit and retry handling, full reconciliation on every edit/rollback/delete, and a permanent maintenance commitment to a third-party API. Roughly 2–3 weeks against 3–5 days, and Google-only.

The feed is the right first move: it delivers most of the value, and if the missing reminders or the refresh latency turn out to be unacceptable in practice, the API push can be built later without unwinding any of it.

**Worth confirming with the practice before this ships** (it does not block building): that a once-or-twice-daily refresh with no per-session alerts meets what the doctors want. If they expect their phone to alert them before each session, the feed will disappoint them, and that is a push-model requirement rather than a feed one.

## Scope

**In scope**

- Per-doctor `.ics` feed of sessions on **committed** clinical rotas
- Token generation at doctor creation, display, and manager-only rotation
- A frontend page under the clinical shell where a logged-in user picks a doctor and copies that doctor's feed URL
- Practice-wide AM/PM session times as constants with env-var overrides
- All-day and half-day annual-leave events derived from suppressed sessions

**Out of scope**

- Any link between `User` and `Doctor` — see Decision 1
- The reception rota. The same design generalises (a token column on `reception_staff`, a second feed route), but it is a separate ticket
- Draft rotas, and any push-based or Google-specific integration
- Per-clinic-type or per-doctor session times
- Reminders (`VALARM`), free/busy semantics, `ETag`/conditional GET

## Design Decisions

### 1. No identity link between users and doctors

The feed is identified by a per-doctor token, not by who is logged in. Any logged-in user opens the calendar page, picks a doctor from a list, and copies that doctor's URL. Dr Smith is expected to pick Dr Smith; if they pick wrong they get the wrong rota in their calendar, notice immediately, and re-subscribe.

This is consistent with the existing authorization model rather than an exception to it. Every rota surface in the app — `DoctorsPage`, `RotaGrid`, the master rota, the leave planner — is already readable at every access tier; viewers see the whole app with write controls disabled. "Any logged-in user can see any doctor's rota" is how the system already works, so a per-doctor feed exposes nothing new internally.

The alternative — a real `User.doctor_id` link — would drag in a set of questions this feature does not need answered: whether one login can map to several doctor rows, whether every doctor gets a login, what the link means when a doctor is soft-deleted, and who may change it.

**This does not create debt.** If an identity link is ever wanted for something else (self-service leave requests, "email me my week", a doctor-scoped rota view), it can be added then and the token column here carries on working unchanged. The one thing it costs today is that nothing can be sent *to* a doctor automatically, because the system does not know their email address — the doctor must pull the URL themselves. That is inherent to the feed model anyway.

### 2. The token is unguessable, and each feed carries exactly one doctor

The feed URL cannot be authenticated: Google will not send a bearer token when it fetches. It is therefore a public URL on the open internet, and its only protection is being unguessable.

The framing "the rota contains no sensitive information" is not quite right and should not be leaned on. The feed reveals a named individual's working pattern and, by absence, when they are on leave. That is low-sensitivity staff personal data, but it is still personal data under UK GDPR. Two consequences:

- The token is a long random string — `secrets.token_urlsafe(32)`, reusing `app/api/auth_utils.py`'s `new_session_token()` rather than a second generator, so there is one definition of "unguessable token" in the codebase.
- Each feed contains **only that doctor's** sessions, so a leaked URL exposes one person's schedule rather than the whole practice's.

Rotation is the revocation path: issuing a new token immediately dead-ends the old URL. That covers both a leaver and a URL shared somewhere it shouldn't have been.

Note that any logged-in user can read any doctor's feed URL from the page. That is deliberate and follows from Decision 1 — the token defends against outsiders, not against colleagues, which is exactly the boundary the app already draws.

No constant-time comparison and no rate limiting. The token is 256 bits of randomness looked up through a unique index; timing tells an attacker nothing they could use, and guessing is not a threat worth engineering against at this entropy.

### 3. Tokens exist for every doctor from creation, and the migration is what guarantees it

Access levels run `manager > admin > doctor = nurse`, and `require_write_access` is attached globally in `main.py`, so a doctor-tier user cannot make *any* non-GET request outside `/auth` and `PATCH /users/me`. If "link my calendar" generated a token on click, a doctor could not click it.

So tokens are not generated on demand. Every doctor row has a token from creation, exactly as `routers/doctors.py` already guarantees every doctor row has one `SystemCounter` per type — same invariant shape, same place.

**Unlike the counter invariant, the backfill happens inside the migration rather than in a separate script.** `seed/backfill_system_counters.py` exists because that invariant was violated in production before it was enforced; this column has no such history. The migration adds the column nullable, generates a token per existing row, then batch-alters it to `NOT NULL` — so no database can ever hold a doctor without a token, and the feed route needs no "null token" branch. A `NOT NULL` column with no server default is the correct shape here precisely because there is no single value the existing rows could share.

Rotation stays a write and is **manager-only**. Revoking a doctor's calendar link is a user-management-shaped action, not routine data entry, and it is silently destructive — the doctor's calendar simply stops updating with no error anywhere.

### 4. The public route is one GET in its own router, and `_UNGATED` is genuinely required

`main.py`'s docstring states the invariant that there is no fail-open mode and every router endpoint requires a valid session. An unauthenticated feed endpoint is a genuine, deliberate hole in that, and it needs to be structurally impossible to widen by accident.

- The feed lives in a **new router containing exactly one GET endpoint**, whose handler takes no `Depends(get_current_user)`.
- That router is added to `_UNGATED` in `main.py` — the third entry in a list whose comment says not to extend it without a specific reason. **This is load-bearing, not cosmetic:** `require_write_access` is itself declared `user: User = Depends(get_current_user)`, so the global gate 401s an unauthenticated request *before* it ever reaches the method check. A GET-only router registered in the normal loop would therefore still require a session. `_UNGATED` is the only way out.
- **All token management lives on the existing `doctors` router**, authenticated and write-gated normally.

That split is the point: the ungated surface is one route that cannot grow without someone consciously adding to it, and no authenticated endpoint is ever a near-neighbour of it.

The residual risk — someone later adding a `POST` to the ungated router, which would be both unauthenticated *and* world-writable — is already covered: `tests/test_api/test_authorization.py`'s sweep enumerates every non-GET route in the OpenAPI schema and asserts 403 for a viewer, and the calendar router is not in its `_EXEMPT_PREFIXES`. A write added there fails that test on the first run. Say so in the router's docstring so the next person knows the tripwire exists.

The converse hole is real and currently untested: that sweep covers non-GET routes only, so **nothing in the suite proves that authenticated GETs still require authentication.** Task 3 adds that sweep, which is what makes "we opened one hole, not a class of them" a checked property rather than a claim.

### 5. Committed rotas only, recomputed on every request

Nothing is pre-generated or cached. Each request queries the current database state and builds the file fresh.

This is what makes the whole feature cheap, and it dissolves the hardest problem in the push-based design. `is_on_leave` is not stored — it is derived from `leave_entries` at read time — so a doctor's rota can change after commit with no `rota_sessions` row changing. Add rollback-commit, force-delete and post-commit leave edits, and a push model needs real reconciliation logic. A recomputed feed just tells the truth every time it is asked.

Consequences that fall out for free:

- A rolled-back rota reverts to `draft` and its sessions stop appearing.
- A force-deleted rota's sessions stop appearing.
- Leave added after commit removes the affected sessions (and adds a leave event — Decision 8).
- **Archived rotas are included.** `archived_at` is a pure UI visibility flag with no effect on the data; an archived rota is still a real committed rota, and its dates are usually in the past anyway.
- Drafts are excluded, because a draft changes constantly and publishing it would be noise.

Committed rotas cannot overlap (`find_overlapping_committed_rota` enforces this at generation), so no slot can produce two events.

Load is a non-issue at practice scale: a few dozen doctors, polled by Google a couple of times a day. If it ever mattered, an `ETag` over a hash of the rendered bytes is the cheap fix, and it is deliberately not built now.

### 6. Which sessions become events

`rota_sessions` holds a row for every template entry, including ones the doctor does not attend, so the feed needs an inclusion predicate. It reads the row's own persisted `template_type`, plus `is_wfh`:

| `template_type` | In the feed? |
|---|---|
| `REQUIRES_ROOM`, `PRE_ASSIGNED` | Yes — the core clinical sessions |
| `ADMIN_TIME` | Yes — the doctor is due in, just not in clinic |
| `WFH` (or any row with `is_wfh` true) | Yes, with a `WFH` title prefix and no room |
| `NO_SURGERY` | **No** — the doctor is not working that session |
| `null` (legacy rows) | Yes — reads as a normal session, the same fallback used everywhere else |

This is exactly `app/leave_charging.py`'s chargeable set, and for the same reason: both ask "was the doctor due at work?" rather than `leave_planning`'s narrower "is a clinician available to see patients?". **The two are deliberately not merged into a shared predicate.** `leave_charging` answers the question against the *live week-1 master template* by weekday, because it is asked about a bare date with no rota; the feed answers it against the *persisted `template_type` snapshot* on a real rota row. Sharing a function would force one of them onto the wrong source. Each module's docstring should name the other and state that alignment is intentional but not shared.

Closed slots are omitted, read from the rota's own `RotaClosure` snapshot rather than the live `PracticeClosure` table — the same rule `GET /rota/{id}` and `rebuild_rota_grid()` follow, so a closure edited after commit cannot retroactively change what a historical rota's feed says. The filter order is **closure → session type → leave**, so a `NO_SURGERY` slot on a leave day produces neither a session event nor a leave event.

### 7. Session times are practice-wide constants

`Period` is `AM`/`PM` only — the system holds no clock times at all — but calendar events need them. There is no settings table in the schema and this does not justify creating one.

AM is **08:30–12:30**, PM is **13:30–18:00**, as module-level constants with environment-variable overrides, following the `DOC_LOCK_PASSWORD` / `SOFFICE_BIN` precedent. One env var per boundary (`CALENDAR_AM_START`, `CALENDAR_AM_END`, `CALENDAR_PM_START`, `CALENDAR_PM_END`), parsed as `HH:MM`, so changing the practice's hours is a Railway variable and a redeploy rather than a migration.

All-day events for working sessions were considered and rejected: two all-day blobs per day read badly in every calendar app and convey less than timed events. All-day is used only for a full day of leave, where it is the honest shape.

### 8. Leave produces its own events, derived from suppressed sessions

A blank day is ambiguous — the doctor cannot tell leave from a feed that failed to refresh — so leave is emitted positively.

**A leave event exists only where a session was suppressed.** That rule is what keeps the leave query bounded: the feed never scans `leave_entries` for dates the doctor was not rostered on, so a part-timer's non-working day, a weekend, and a date outside every committed rota all stay silent. It also means leave inherits the closure and session-type filters for free.

- Both periods of a date suppressed by leave → **one all-day `VEVENT`, "Annual leave"** (`DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` on the following day, per RFC 5545's exclusive end).
- One period suppressed → **a timed `VEVENT`, "Annual leave (AM)" / "(PM)"**, using that period's own times. A half day of leave is a real half day at work, and an all-day blob would misstate it.

### 9. Times are emitted in UTC, converted via `zoneinfo`

Sessions are stored as dates with no timezone. Emitting floating local times would be *nearly* correct for a single-site practice but breaks for anyone travelling. Emitting explicit UTC (`DTSTART:...Z`), converted from `Europe/London` via the standard-library `zoneinfo`, handles BST correctly, needs no `VTIMEZONE` block, and adds no dependency. `X-WR-TIMEZONE: Europe/London` rides along as a display hint.

### 10. Stable event UIDs come from `rota_sessions.id` and a **constant** domain

Calendar clients update an existing event rather than duplicating it when the UID matches. `rota_sessions` has a standing invariant that a row exists iff a template entry existed at generation time — **edits mutate rows but never create or delete them** — so the row id is stable across every edit a rota can undergo.

The UID is `<session_id>@<CALENDAR_UID_DOMAIN>`, where the domain is a **hardcoded constant, never the request's host**. Deriving it from `request.base_url` would change every UID the day the app moves domain or someone subscribes via the Railway URL instead of the practice one, and every event in every subscriber's calendar would duplicate rather than update. The constant makes the UID a property of the data, which is what a UID is for.

Leave events need their own stable ids in the same namespace: `leave-<doctor_id>-<YYYYMMDD>@<domain>` for an all-day event, `leave-<session_id>@<domain>` for a half-day one.

### 11. The absolute URL is composed client-side

`GET /doctors/{id}/calendar-feed` returns the token and the feed's **path**, not an absolute URL. The frontend prepends `window.location.origin`.

Building it server-side would mean reading `request.base_url`, which behind Railway's proxy reports whatever the proxy forwarded — a scheme mismatch there produces an `http://` URL that a subscriber pastes into Google and that silently fails or downgrades. The browser already knows the origin it is talking to, correctly, in dev (Vite proxy) and production (same-origin static mount) alike. This is one line of client code buying the removal of a whole class of deployment bug.

### 12. Use a library for ICS serialisation

Add `icalendar` to the backend dependencies rather than hand-rolling the format. The event structure is trivial, but the serialisation rules are not: CRLF line endings, line folding at 75 octets, and escaping commas, semicolons and backslashes in text fields. Room codes and free-text `notes` will contain exactly those characters, and getting it wrong produces a file Google silently refuses to parse — a failure mode that is painful to diagnose because the only symptom is a calendar that never appears.

### 13. A rolling window, not all history

Everything from **56 days ago onward**, with no upper bound (committed rotas only extend a few weeks out anyway). `CALENDAR_FEED_HISTORY_DAYS` overrides the 56. Emitting all history forever makes the file grow without bound for no benefit — nobody subscribes to a calendar to read last year.

The window is applied to the rota range, not per session: a rota whose range ends before the cutoff is not queried at all.

## Task 1: Data model

**A.** The feature is unbuilt; this is the first task. Deliverable: every `Doctor` row carries a unique, unguessable `calendar_token`, from creation, on a fresh database and an existing one alike.

**B. Files**

- `backend/app/models/doctor.py` — the column
- `backend/alembic/versions/007_doctor_calendar_token.py` — new migration
- `backend/app/api/routers/doctors.py` — generate at creation
- `backend/app/api/schemas/doctor.py` — **no change** (see below)
- `backend/tests/test_models.py`, `backend/tests/test_api/test_doctors.py` — tests

**C. Instructions**

1. Add to `Doctor`: `calendar_token: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)` with a `UniqueConstraint`/index named in the existing `uq_doctors_*` / `ix_*` style. No `server_default` — Decision 3 explains why, and the migration is what makes that safe.
2. New migration `007`, revises `006`. Follow `006_reception_displaced_role.py`'s shape and docstring conventions:
   - `op.add_column` nullable.
   - Backfill: select every `doctors.id`, and for each issue an `UPDATE` setting `calendar_token` to `secrets.token_urlsafe(32)`. Per-row, in Python — there is no SQL expression that produces a distinct random urlsafe token per row portably across SQLite and Postgres, and the row count here is dozens.
   - `op.batch_alter_table` to set `nullable=False` (dev SQLite cannot alter in place — the project-wide rule).
   - Create the unique index.
   - `downgrade()` drops the index and the column; note in the docstring that the tokens are unrecoverable and every subscriber would need to re-subscribe after a downgrade-then-upgrade.
3. In `create_doctor`, set `calendar_token=new_session_token()` (imported from `..auth_utils`) on the `Doctor` before the flush. Extend the router's module docstring: it already documents the counter invariant, and this is a second invariant of the same shape maintained in the same place.
4. **Do not add `calendar_token` to `DoctorOut` or `DoctorDetailOut`.** The token reaches the frontend only through the dedicated endpoint in Task 4. Keeping it off the general doctor payloads means it does not end up in the rota grid's caches, the audit log's request bodies, or anywhere else a doctor payload travels.
5. Tests: creating a doctor via the API yields a non-null token; two doctors get different tokens; a duplicate token raises `IntegrityError`. CI's Postgres upgrade/downgrade/upgrade round trip covers the migration itself — but run the round trip locally against SQLite once before pushing, because the `batch_alter_table` step is the part most likely to be wrong.

## Task 2: Feed builder

**A.** Task 1 is done: every doctor has a `calendar_token`. This task builds the pure module that turns a doctor plus a date window into `.ics` bytes. No HTTP is involved and no endpoint exists yet.

**B. Files**

- `backend/pyproject.toml` — add `icalendar` to `dependencies`
- `backend/app/calendar_feed.py` — new; the whole builder
- `backend/app/leave_charging.py` — docstring cross-reference only (Decision 6)
- `backend/tests/test_calendar_feed.py` — new
- Reused unchanged: `app/engine/week_map.py` (`build_week_dates`), `app/models/*`

**C. Instructions**

`app/calendar_feed.py` sits top-level under `app/` alongside `master_template.py` and `leave_charging.py` — it queries, so it is not FastAPI-free-and-DB-free like `leave_entitlement.py`, but it must not import from `app/api/`.

1. **Constants**, all env-overridable, all module-level:
   - `AM_START`/`AM_END`/`PM_START`/`PM_END` — `datetime.time`, defaults `08:30`, `12:30`, `13:30`, `18:00`, read from `CALENDAR_AM_START` etc. as `HH:MM`.
   - `HISTORY_DAYS = int(os.environ.get("CALENDAR_FEED_HISTORY_DAYS", 56))`.
   - `UID_DOMAIN` — a hardcoded constant string (e.g. `"rota.local"`); Decision 10 explains why it is not the request host. Not env-overridable: changing it would duplicate every event.
   - `PRACTICE_TZ = ZoneInfo("Europe/London")`.
2. **`build_feed(db: Session, doctor: Doctor, today: date) -> bytes`** — `today` is a parameter, not `date.today()`, so the window is testable without freezing the clock.
   - `window_start = today - timedelta(days=HISTORY_DAYS)`.
   - Select committed rotas joined to their `RotaConfig` where the rota's range end (`start_date + num_weeks * 7` days) is after `window_start`. `status == RotaStatus.COMMITTED` only; `archived_at` is not filtered on (Decision 5).
   - For each such rota: `build_week_dates(config.start_date, config.num_weeks)` gives `(week, day) -> date`.
   - One query for this doctor's `RotaSession` rows across those rota ids; one for their `RotaClosure` rows, as a `{(rota_id, date, period)}` set; one for `LeaveEntry` rows for this doctor between `window_start` and the latest rota range end, as a `{(date, period)}` set. Four queries total regardless of rota count — do not query per rota.
   - For each session: resolve its date; drop it if before `window_start`; drop it if `(rota_id, date, period)` is closed; drop it if `template_type is NO_SURGERY`; then, if `(date, period)` is on leave, record it as a suppressed-leave slot instead of building an event.
   - Group suppressed-leave slots by date: both periods → one all-day leave event; one period → one timed leave event. Decision 8.
3. **Event shape.** `SUMMARY` is `"<Room code> — <Clinic type>"`, with these rules: a duty role renders as `Duty` / `Duty (2nd)` in the clinic-type position; a row with no room omits the room and the dash; a WFH row is prefixed `WFH: `. `LOCATION` is the room code when there is one. `DESCRIPTION` carries the doctor code, the session's `notes`, and `Supervising` when `is_supervising`. `UID` per Decision 10. `DTSTAMP` is the build time. `TRANSP: OPAQUE`.
4. **Calendar shape.** `PRODID`, `VERSION: 2.0`, `CALSCALE: GREGORIAN`, `METHOD: PUBLISH`, `X-WR-CALNAME: "<doctor code> rota"`, `X-WR-TIMEZONE: Europe/London`, and both `REFRESH-INTERVAL;VALUE=DURATION:PT12H` and `X-PUBLISHED-TTL:PT12H` (clients honour one or the other, neither universally).
5. **Timezone**: build a naive local `datetime`, attach `PRACTICE_TZ`, convert to UTC, hand `icalendar` the aware value so it emits `...Z`. Include a test with a date inside BST and one outside it, asserting the UTC hour differs by one — this is the assertion that catches a `zoneinfo`/`utcoffset` mistake.
6. **Tests** (`tests/test_calendar_feed.py`, no `TestClient`): a committed rota produces one `VEVENT` per included session; a draft rota produces none; an archived rota produces events; a `NO_SURGERY` slot produces none; a closed slot produces none, and the closure is read from `RotaClosure` and not from a `PracticeClosure` added afterwards; full-day leave produces one all-day event and no session events; half-day leave produces one timed leave event and one session event; a session outside the history window is absent; the UID equals `<session_id>@<UID_DOMAIN>` and is unchanged after an edit to the session row; a room code or note containing a comma, semicolon and backslash round-trips (parse the output back with `icalendar` and compare strings — the whole reason the library is here); BST vs GMT as above.

## Task 3: Public route

**A.** Tasks 1–2 are done: doctors carry tokens and `build_feed()` returns bytes. This task exposes it as the one unauthenticated endpoint in the app.

**B. Files**

- `backend/app/api/routers/calendar.py` — new, one endpoint
- `backend/app/api/main.py` — import, `_ALL_ROUTERS`, `_UNGATED`, and the comment above `_UNGATED`
- `backend/tests/test_api/test_calendar_feed_route.py` — new
- `backend/tests/test_api/test_authorization.py` — the new GET sweep

**C. Instructions**

1. `router = APIRouter(prefix="/calendar", tags=["calendar"])`, one handler:

   ```
   @router.get("/{token}.ics")
   def calendar_feed(token: str, db: Session = Depends(get_db)) -> Response
   ```

   The literal `.ics` suffix in the path parses unambiguously: `secrets.token_urlsafe` emits only `[A-Za-z0-9_-]`, so the greedy path param cannot swallow the dot. The suffix is there because several desktop clients decide how to handle a URL by its extension.

   No `Depends(get_current_user)`. Look the doctor up by `calendar_token`; **404 on no match**, with a generic detail — never distinguish "no such token" from "rotated" from "inactive doctor". Return `Response(content=..., media_type="text/calendar; charset=utf-8")` with a `Content-Disposition: inline; filename="rota.ics"` header.

   A soft-deleted (`active=False`) doctor still serves their feed. Deactivation is not revocation — rotation is (Decision 2) — and a leaver's committed past sessions are real. Say so in the handler's docstring so nobody "fixes" it later.

2. The module docstring is the important deliverable here. It must state: that this is the only unauthenticated endpoint in the app; that the token in the path *is* the credential, because a calendar client cannot present a bearer token; that the router is in `_UNGATED` because `require_write_access` depends on `get_current_user` and would otherwise 401 even a GET; and that adding any non-GET endpoint to this router is both unauthenticated and unauthorized, which `test_authorization.py`'s sweep will catch.
3. In `main.py`: add to `_ALL_ROUTERS` and to `_UNGATED`, and **extend the `_UNGATED` comment** with the third entry's reason in the same form as the two already there. Update the count in the module docstring's prose if it names one.
4. **Route tests**: use `client_no_auth`, never `client` — the `client` fixture overrides `get_current_user` wholesale, so a test using it proves nothing about whether auth was required. Assert: a valid token with no `Authorization` header returns 200 and `text/calendar`; the body starts `BEGIN:VCALENDAR` and parses; an unknown token 404s; a rotated token 404s; the response for doctor A contains no session belonging to doctor B.
5. **The GET sweep** (new, in `test_authorization.py`, modelled on `test_viewer_cannot_write`): enumerate every GET route in the OpenAPI schema, call each with `client_no_auth` and no header, and assert **401** — with an explicit allowlist of exactly the calendar feed path. Add a floor assertion like the existing `_MIN_SWEPT_ROUTES` so a broken collection cannot pass over zero routes. Extend the module docstring to explain that this sweep is the guard on the hole Decision 4 opened, and that adding a path to its allowlist is a decision, not a test fix.

## Task 4: Token management

**A.** Tasks 1–3 are done: the feed is live and reachable by token. Nothing in the UI can yet find a token. This task adds the two authenticated endpoints on the existing `doctors` router.

**B. Files**

- `backend/app/api/routers/doctors.py` — two endpoints
- `backend/app/api/schemas/doctor.py` — `CalendarFeedOut`
- `backend/app/api/schemas/__init__.py` — export it
- `backend/tests/test_api/test_doctors.py` — tests
- `backend/tests/test_api/test_authorization.py` — one `_MANAGER_ONLY` entry

**C. Instructions**

1. `CalendarFeedOut`: `doctor_id: int`, `token: str`, `feed_path: str`. `feed_path` is the app-relative path (`/api/v1/calendar/<token>.ics`), composed from `API_PREFIX`-equivalent knowledge in the router — do not hardcode the string in two places; derive it from the calendar router's prefix. Decision 11 explains why there is no absolute URL here.
2. `GET /doctors/{doctor_id}/calendar-feed` → `CalendarFeedOut`. Ordinary `Depends(get_current_user)`; readable at every tier, like every other GET. 404 for an unknown doctor via the existing `_get_or_404`.
3. `POST /doctors/{doctor_id}/calendar-feed/rotate` → `CalendarFeedOut`. Adds `Depends(require_manager)` **on top of** the global write gate (Decision 3). Generates a fresh `new_session_token()`, commits, returns the new value. This is the second place in the codebase using `require_manager` outside `routers/users.py`; note in the docstring that the global gate is not enough here and why.
4. Add `("POST", "/api/v1/doctors/1/calendar-feed/rotate")` to `_MANAGER_ONLY` in `test_authorization.py`. Without it the existing sweep fails: it asserts an admin gets *past* the gate on every non-GET route not in that set, and this one will 403 an admin by design.
5. Tests: the GET returns a path containing the doctor's stored token; rotation changes the token and the old value no longer resolves through the Task 3 route; a viewer can GET but not rotate; an admin cannot rotate; a manager can.

## Task 5: Frontend

**A.** Tasks 1–4 are done: the backend is complete and tested. This task is the page a doctor is pointed at.

**B. Files**

- `frontend/src/api/types.ts` — `CalendarFeed` mirror
- `frontend/src/api/calendarFeed.ts` — new; `useCalendarFeed(doctorId)`, `useRotateCalendarFeed()`
- `frontend/src/routes/CalendarFeedPage.tsx` — new
- `frontend/src/routes/CalendarFeedPage.test.tsx` — new
- `frontend/src/api/calendarFeed.test.tsx` — new
- `frontend/src/App.tsx` — route + nav entry
- `frontend/src/App.test.tsx` — nav assertion
- `frontend/src/test/msw/` — handlers for the two new endpoints

**C. Instructions**

1. Hooks follow `api/doctors.ts`'s conventions exactly: a `calendarFeedKeys` hierarchy, `useQuery` keyed on the doctor id and `enabled` only once one is picked, and a `useMutation` for rotation that invalidates that key. Reference data, so invalidate rather than splice.
2. The page: a doctor `<select>` (from `useDoctors(true)` — active doctors only; a leaver is not being handed a subscription link), then, once one is picked, the absolute URL as selectable text plus a **Copy** button (`navigator.clipboard.writeText`, with the text still selectable as the fallback for a browser that refuses).
3. Absolute URL is `` `${window.location.origin}${feed.feed_path}` `` — Decision 11. Compute it in the component, not the hook, so the hook stays a plain wire mirror.
4. **Rotation** is a manager-only control: gate it with `useWriteGate()`/`useIsManager()` from `auth/AuthContext` — the disabled-with-tooltip pattern the rest of the app uses — behind a confirm dialog that says plainly that the old link stops working and anyone using it must re-subscribe. This is a destructive action whose damage is silent, which is exactly the case the confirm pattern exists for.
5. **Subscription instructions** are the part that decides whether this feature actually gets used. Include short, literal, per-app steps for Google Calendar ("Other calendars → + → From URL"), Apple Calendar ("File → New Calendar Subscription"), and Outlook ("Add calendar → Subscribe from web"), plus one sentence setting the expectation that updates arrive within a day rather than immediately, and one saying the link is private and should not be forwarded.
6. Route `/clinical/calendar` inside `ClinicalShell`'s `<Routes>`, and a `CLINICAL_NAV_ITEMS` entry — "Calendar Feed", `end: false`, **not** `managerOnly` (Decision 1: every tier reads it; only the rotate button is gated). Do not put it in the Session Management group: that group is the five session-planning pages, and this is not one of them.
7. Tests: the page renders no URL before a doctor is picked; picking one shows the URL built from `window.location.origin`; the copy button calls the clipboard API; the rotate control is absent or disabled below manager and fires the mutation for a manager after confirming; `App.test.tsx` gains the nav entry and route assertion in the existing style.

## Task 6: Documentation

**A.** Tasks 1–5 are done and the feature is shipped. This task records the decisions and removes the plan.

**B. Files**

- `documentation/architecture-clinical.md`
- `documentation/architecture.md`
- `documentation/calendar_feed_plan.md` — delete

**C. Instructions**

1. In `architecture-clinical.md`, add a **Calendar Feed** section after "Signatures and documents". Record, in that document's voice — decisions and reasoning, never a restatement of what the code says: no identity link and why it is not debt (Decision 1); the token as the sole credential and rotation as the revocation path (2); the invariant maintained at creation and backfilled in the migration rather than by a script, with the contrast to `backfill_system_counters.py` (3); committed-only, recompute-per-request, and what that dissolves versus a push model (5); the inclusion predicate and its deliberate non-sharing with `leave_charging` (6); constants-not-a-settings-table (7); leave events derived from suppressed sessions (8); UTC via `zoneinfo` (9); the constant UID domain and what a host-derived one would break (10); client-side URL composition and the proxy-header trap (11); and the library choice (12).
   Add a `/calendar` row to the router-surface table, and a `/doctors` note about the two feed endpoints.
2. In `architecture.md`, add the shared-infrastructure fact only: `_UNGATED` now has a third entry, the reason it must be there rather than in the normal loop (`require_write_access` depends on `get_current_user`, so the gate 401s a GET too), and the two sweeps in `test_authorization.py` that hold the line — the existing non-GET one and the new unauthenticated-GET one. This belongs there rather than in the clinical doc because it is a property of the whole API surface.
3. Follow the citation rule: write the decision, never "calendar feed plan, Decision 4".
4. Delete `documentation/calendar_feed_plan.md`.

## Estimate

3–5 days. Task 2 is the bulk of it; Tasks 1, 3 and 4 are each half a day or less; Task 5 is a day, most of it the instructions copy.
