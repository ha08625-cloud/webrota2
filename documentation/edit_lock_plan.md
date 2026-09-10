# Provisional Plan — Editing control (pessimistic lock) with advisory banner

Output of a discussion chat. **This is a provisional plan, not an
implementation plan**: it is meant to be pasted into a fresh chat, reviewed,
corrected and expanded before any code is written. Every code fact in "State
of the world" was read off the file it names during that chat; everything in
"Design Decisions" is a proposal, and several are marked `TODO(decide)`.

## Gate before any code is written

Read this first. The feature is worth building only if the answer to all
three is still yes after reading them.

1. **This is not a data-integrity fix.** Postgres already serialises writes,
   and every mutating rota endpoint already re-checks state server-side
   (`_require_draft`, `_require_committed`) rather than trusting the client.
   Two people editing at once cannot corrupt a row today. What they *can* do
   is silently overwrite each other's work while looking at stale screens.
   This plan addresses that, and nothing else.
2. **It makes the app less available, on purpose.** That is what a
   pessimistic lock is. New failure modes arrive with it: someone takes
   editing control and goes to lunch; someone's laptop sleeps mid-edit; the
   practice manager holds the lock on the one afternoon they are off. The
   expiry and force-takeover design below exists entirely to soften these,
   and it will not soften them completely. A cheaper alternative — polling
   for freshness plus a presence banner with no enforcement — was discussed
   and rejected in favour of this. That trade is the thing to re-confirm.
3. **The advisory banner is doing most of the useful work.** In a practice
   of a handful of people, "Kristel has the rota open" is usually enough,
   because they will simply speak to each other. The enforcement is a
   backstop for the case where they don't. If review decides to ship the
   banner and drop the enforcement, that is a coherent, much smaller
   ticket — see "Reduced-scope fallback" at the end.

## Plan

A single-holder editing lock over a small, fixed set of named editing
surfaces. A user with write access clicks **Take editing control**; from
then on only they may issue non-GET requests against that surface. Everyone
else keeps full read access, sees the grid in a read-only state, and sees a
banner naming the holder and when they took control. The lock expires on its
own if the holder's browser stops heartbeating, and can be taken over
deliberately with a confirmation.

Reading is never blocked. Nothing about the existing 409 state guards
changes — the lock is an additional, earlier gate, not a replacement.

## Scope

**In:**

- A `edit_locks` table and its lazy-expiry rules.
- Acquire / heartbeat / release / force-take endpoints and a read endpoint.
- Registration-time enforcement of the lock on unsafe methods, for the
  lockable routers only.
- A banner plus read-only rendering on the affected pages.
- Audit coverage of lock transitions (free — see below).

**Out:**

- Real-time push. Everyone learns about lock changes by polling, not by
  WebSocket.
- Locking the reference-data pages (Doctors, Clinic Types, Rooms, School
  Holidays, Users, Signatures). These are low-contention, mostly-append
  forms where last-write-wins is genuinely fine, and locking them would make
  the app feel broken for no gain.
- Per-row or per-cell locking. See Design Decisions.
- Any change to the existing `_require_draft` / `_require_committed` /
  singleton-staging guards. They stay exactly as they are.
- Field-level merge or conflict resolution. There is none: the lock holder
  is authoritative for the duration.

## State of the world

Read during the discussion chat; re-verify anything load-bearing before
building on it.

- **Auth.** `backend/app/api/deps.py` — `get_current_user` resolves a bearer
  token to a `User` row on every request and already holds that row (it is
  what feeds the audit log). `User.name` and `User.email` exist
  (`backend/app/models/user.py`, lines ~144–145), so a holder's display name
  needs no new column.
- **Gating shape to mirror.** `backend/app/api/main.py` `_AREA` maps each
  router module to a permission area at `include_router` time, using a
  **direct subscript** so a new router is a `KeyError` at import until
  somebody classifies it, plus two module-level assertions catching stale
  entries. `require_access` in `deps.py` is a dependency *factory* closing
  over the area, and discriminates safe vs unsafe methods off
  `request.method`. This plan copies that shape deliberately.
- **Existing concurrency guards.** `backend/app/engine/generate.py`
  `get_active_draft` / `get_active_staging` — at most one draft and one
  active staging exist globally. `routers/staging.py` `create_staging` 409s
  on an active draft, an active staging, a committed-rota overlap, or a
  non-unique active template. `routers/rota.py` `_require_draft` /
  `_require_committed` guard every mutating rota endpoint.
- **Lazy-expiry precedent.** `password_reset_tokens` stores only a digest,
  expires after an hour, and is **swept lazily on the next request for that
  user rather than by a cron job** (architecture.md). The lock table should
  copy this exactly — Railway runs a single uvicorn process
  (`railway.toml` `startCommand`) with no scheduler, and adding one for this
  would be disproportionate.
- **Audit.** `AuditMiddleware` writes one row per non-GET request that
  reaches the app, registered in `main.py` for the same
  new-endpoints-covered-automatically reason as `_AREA`. Lock acquire /
  release / force-take are all non-GET, so they are audited without any new
  code — provided each is its own endpoint (see Design Decisions).
- **Frontend query layer.** `frontend/src/main.tsx` creates one
  `QueryClient` overriding only `retry`; `staleTime` (0) and
  `refetchOnWindowFocus` (true) are TanStack Query v5 defaults, so queries
  already refetch on tab focus. `frontend/src/api/client.ts` throws a
  structured `ApiError` carrying `status` for any non-2xx, and fires a
  global `onUnauthorized` listener on **any** 401 — which is why the lock
  must answer **409/423, never 401**, or a rejected write would bounce the
  user to the login form.
- **Surfaces and their size.** Mutating endpoint counts, for sizing:
  `rota.py` 12, `staging.py` 9, `reception_rota.py` 6, `leave.py` 4,
  `master_rota.py` 3, `reception_master.py` 3. Enforcement is at router
  registration, so these counts are informational, not per-endpoint work.
- **Shells.** `App.tsx` mounts `ClinicalShell`, `ReceptionShell`,
  `SignaturesShell`, `AdminShell`, each owning its own header and nav, with
  **no component shared between shells**. A banner therefore has to be added
  per shell (or per page), not once globally.

## Design Decisions

All proposals.

1. **The lock is over a named surface, not a row.** A small fixed set of
   string keys — provisionally `clinical.rota` (covering both the staging
   grid and the draft rota, which are one workflow and already singletons),
   `clinical.master`, `clinical.leave`, `reception.master`,
   `reception.rota`. Per-row locking was rejected: the draft and the staging
   are already globally unique, so per-row buys nothing there, and it would
   multiply the UI story from one banner into one per grid cell.
   `TODO(decide)`: whether `clinical.leave` belongs in the set at all. Leave
   entry is the one high-traffic, genuinely multi-person surface, and it is
   also the one where being locked out is most annoying.
2. **The lock key is per surface and the holder is per USER, not per
   session.** The same person logged in on a laptop and a phone holds one
   lock and can edit from both. This costs nothing and removes a whole class
   of "why am I locked out of my own lock" confusion.
3. **Enforcement mirrors `_AREA`, at `include_router` time.** A
   `_LOCK_SURFACE` dict in `main.py` maps every router module to a surface
   key **or to an explicit `None`** meaning "not lockable", read with a
   direct subscript and guarded by the same style of assertion. The explicit
   `None` is the point: a `.get()` defaulting to unlocked would make a new
   router silently unlockable, which is the same default-OPEN failure
   `_AREA` was designed to avoid. A new router stays a `KeyError` at import
   until somebody classifies it either way.
4. **Only unsafe methods are gated.** `require_lock_held(surface)` is a
   dependency factory closing over the surface key, discriminating on
   `request.method` exactly as `require_access` does. GET/HEAD/OPTIONS never
   consult the lock. Reading is never blocked, for anyone, ever.
5. **Acquisition is explicit, never implicit-on-first-write.** Implicit
   acquisition would mean a stray drag silently seizes control, and would
   make the banner lie — it would say "someone is editing" when they had
   only opened a page. The cost is that everyone must remember to click; the
   mitigation is that the grid renders visibly read-only with the **Take
   editing control** button as the obvious next action.
6. **Expiry by heartbeat, swept lazily.** Columns: `acquired_at`,
   `last_heartbeat_at`. The frontend PUTs a heartbeat every 60s while a
   locked page is mounted and visible. A lock whose `last_heartbeat_at` is
   older than the timeout is treated as expired by any request that reads
   the table, and is deleted then and there — no cron, matching the
   `password_reset_tokens` precedent. `TODO(decide)`: the timeout. **5
   minutes** is the provisional value. Shorter frees a stranded lock faster;
   longer survives a laptop lid closing over a coffee break.
7. **Force-takeover is available to any user with write access on that
   area, behind a confirmation dialog naming the holder.** Restricting it to
   `user_admin` was considered and rejected: in a practice this size the
   administrator is often the person who is out, and the correct enforcement
   for "don't stomp on Kristel" is social, not technical — the dialog says
   whose work is about to be interrupted, which is enough. `TODO(decide)`:
   confirm this is acceptable to the practice manager; the alternative is a
   one-line change.
8. **Release is explicit, with two best-effort backstops.** A **Release
   editing control** button; plus a `navigator.sendBeacon` on page unload
   and a release on logout. Both backstops are best-effort and must never be
   relied upon — beacons are dropped routinely, and a crashed tab sends
   nothing. Expiry (6) is the real answer; the backstops only make the
   common case tidy.
9. **Rejections answer 409, and carry the holder in the body.** Not 401
   (`client.ts` would bounce the user to the login form — see State of the
   world), not 403 (which the permission gates own, and which reads as "you
   may never do this" rather than "not right now"). 423 Locked is the
   semantically exact code and is a reasonable alternative; 409 is proposed
   because this router set already uses 409 for every other
   "state-conflict" refusal and consistency is worth more here than
   precision. The body should name the holder and the time, so the frontend
   can show a useful message rather than a generic error.
10. **Each transition is its own endpoint**, so the audit log reads
    distinctly: `POST /locks/{surface}` (acquire), `POST
    /locks/{surface}/heartbeat`, `DELETE /locks/{surface}` (release),
    `POST /locks/{surface}/force` (takeover). `GET /locks` returns all
    current holders in one call, so a shell can render its banner from one
    poll. The lock router itself is **not** lock-gated (obviously), and
    needs its own `_AREA` classification. `TODO(decide)`: which area — it
    spans clinical and reception, so it may need `_SHARED_READ`-style
    treatment or its own area.
11. **The banner polls; it does not push.** `GET /locks` on a
    `refetchInterval` of ~20–30s while a lockable page is mounted. Live
    push (WebSocket/SSE) was rejected as disproportionate: it would be the
    first stateful connection in the app and the first thing to break if
    the deployment ever moves past one process.
12. **Read-only rendering is a real state, not a disabled overlay.** When
    the lock is held by someone else, the grid's drag handlers, cell
    popovers and action buttons should not be mounted at all, rather than
    rendered-and-disabled. A disabled control that still fires on a stray
    keyboard path is how "read-only" quietly becomes "mostly read-only".

## What this deliberately does not solve

State these when the feature is described to users, or it will be
oversold.

- **It does not make a reader's screen fresh.** Someone watching read-only
  still sees whatever their last refetch returned. The 20–30s lock poll
  refreshes the *banner*, not the grid. If live-ish read freshness matters,
  that is a separate (and much cheaper) refetch-interval change.
- **It does not cover the reference-data pages**, by choice (see Scope).
  Two people can still both edit the doctor list.
- **It does not survive being forgotten.** The single most likely real-world
  outcome is somebody taking control and never releasing it. Expiry is the
  only defence, and it is a blunt one.
- **It does not help across the clinical/reception split**, which is already
  independent. The two sections were never in contention with each other.

## Task breakdown (provisional)

To be expanded into the implementation-plan template on review.

- **Task 1 — Data model.** `EditLock` model (`surface` PK or unique,
  `user_id` FK, `acquired_at`, `last_heartbeat_at`), Alembic migration
  (next number after `013_counter_opening_balance.py`), and the surface-key
  constant/enum in one place both backend and frontend can be checked
  against. Include the lazy-sweep helper here, with its own unit tests, so
  later tasks consume a tested primitive.
- **Task 2 — Lock router and endpoints.** The five endpoints of Design
  Decision 10, the 409 body shape, `_AREA` classification for the new
  router. No enforcement yet — this task ends with the lock readable and
  writable but not yet binding.
- **Task 3 — Enforcement.** `require_lock_held` in `deps.py`,
  `_LOCK_SURFACE` in `main.py` with the explicit-`None` assertions, wired
  at `include_router`. Tests must cover: a new router with no
  classification fails at import; GET is never blocked; a non-holder's
  PATCH 409s; the holder's PATCH succeeds; an expired lock does not block.
- **Task 4 — Frontend lock state and banner.** `api/locks.ts` query and
  mutations, the heartbeat effect, the banner component, and its placement
  in each affected shell (remembering shells share nothing).
- **Task 5 — Read-only grid states.** `RotaGrid`, `StagingGrid`,
  `MasterRotaGrid`, `ReceptionGrid` and their popovers. Likely the largest
  task and the one most worth splitting per grid.
- **Task 6 — Takeover and release UX**, including the confirmation dialog
  and the 409 message surfacing.
- **Task 7 — Review and documentation.** Update `architecture.md` with the
  lock's design decisions (and `architecture-clinical.md` /
  `architecture-reception.md` for the per-surface detail), then delete the
  implementation plan.

Task 5 is the bulk of the work and the part most likely to be
underestimated. If the ticket has to be cut, cut from there — locking one
grid well beats locking four badly.

## Reduced-scope fallback

If review decides the enforcement is not worth it, the banner alone is
Tasks 1, 2, 4 and 7 with the enforcement dependency dropped: an advisory
presence indicator showing who has each surface open, with nothing blocked.
That is perhaps a third of the work, carries none of the new
lockout failure modes, and in a practice this size may well capture most of
the benefit. It is a genuine option, not a consolation prize.
