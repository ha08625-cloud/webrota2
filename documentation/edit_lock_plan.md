# Implementation Plan — Section editing lock (shared-drive model)

Supersedes the provisional plan of the same name. Every code fact below was
read off the file it names during the review chat; line numbers are
indicative and should be re-checked, but the shapes they describe were
verified.

## Plan

One editing lock per section — **clinical** and **reception**, two locks
total. The first person with write access to enter a section holds it. Anyone
else entering that section gets a one-time dialog naming the holder and is
downgraded to read-only for as long as the holder has it. The lock releases
when the holder leaves the section or logs out, and otherwise becomes
takeable after 15 minutes with no edits.

The model is a Word document on a shared drive. There is no "take editing
control" button and no way to force a takeover: the 15-minute idle rule is
the only route back in, which is precisely what makes the absence of a
takeover button safe.

Reading is never blocked, for anyone, ever.

## Scope

**In:**

- An `edit_locks` table (two rows maximum) with idle-based takeover,
  evaluated lazily.
- Three endpoints: read all locks, acquire one, release one.
- Server-side enforcement on unsafe methods for every clinical and
  reception router, wired at router registration.
- Frontend: acquire on section entry, release on exit/logout, the
  entry dialog, a standing banner, and lock-awareness folded into the
  existing write gate.

**Out:**

- Any heartbeat, ping or liveness traffic. The timer measures edits, not
  browsers. This is deliberate and load-bearing — see Design Decision 4.
- Force takeover, and therefore any question of who may perform one.
- Real-time push. The banner polls.
- Per-page or per-row locking. Two locks, section-wide.
- Any change to the existing `_require_draft` / `_require_committed` /
  singleton-staging 409s. The lock is an earlier, additional gate.
- Locking the signatures, study-EOI and user-admin areas. They are boolean
  permissions with no read level to downgrade to (see Design Decision 2).

## State of the world

Verified during review. Re-check anything load-bearing before building on it.

- **`main.py` registration loop** (lines ~223–229) includes every router with
  `dependencies=[Depends(require_access(_AREA[module]))]`, except the three
  in `_UNGATED`. `_AREA[module]` is a **direct subscript** so a new router is
  a `KeyError` at import until classified; two module-level assertions catch
  stale entries. This plan extends that loop rather than adding a parallel
  table.
- **`_AREA` already is the section map.** Its values are exactly the
  permission areas — `clinical`, `reception`, `signatures`, `study_eoi`,
  `user_admin`. Because the lock is per section, the lock surface **is**
  `_AREA[module]`. No `_LOCK_SURFACE` dict is needed; the provisional plan's
  proposal for one is dropped.
- **`require_access(area)`** (`deps.py:203`) is a dependency factory closing
  over the area, discriminating safe vs unsafe off `request.method`
  (`_SAFE_METHODS = {"GET","HEAD","OPTIONS"}`). `require_edit_lock` copies
  this shape exactly.
- **`_UNGATED`** (`main.py:~171`) holds `auth`, `users`, `calendar`. `users`
  is the precedent this plan follows for the locks router: a router that
  cannot be described by one area gates itself per endpoint.
- **Datetime round-tripping.** SQLite does not round-trip tzinfo on
  `DateTime(timezone=True)`. `routers/auth.py:103` has `_as_utc` and
  `deps.py:~160` repeats the fix inline. Any comparison against
  `last_activity_at` must do the same or it will `TypeError` under the test
  suite while working in production.
- **Lazy sweep precedent.** `auth.py:191` (sessions) and `auth.py:259`
  (reset tokens) delete expired rows on the next relevant request rather
  than by cron. Railway runs a single uvicorn process with no scheduler
  (`railway.toml`), so this plan does the same.
- **Audit.** `AuditMiddleware` (`audit.py:257`) writes one row per non-GET
  with no exclusions. This is why there is no heartbeat endpoint: a 60s ping
  would add ~480 audit rows per user per day and bury the real entries.
  Acquire and release are ~2 rows per section visit, which is fine.
- **`client.ts:70`** fires the global unauthorized listener on **any** 401,
  bouncing the user to the login form. The lock must therefore answer 409,
  never 401.
- **`useCanWrite()`** (`AuthContext.tsx:152`) resolves the area from
  `PermissionAreaContext` and returns `canWriteArea(permissions, resolved)`.
- **`useWriteGate()`** (`AuthContext.tsx:178`) is built on `useCanWrite` and
  returns `{}` or `{disabled: true, title: NO_WRITE_ACCESS_TITLE}`. It is
  used in ~20 components and routes — every grid, every cell popover, every
  reference-data page. **Lowering `useCanWrite` therefore locks the entire
  UI with no per-component work.** This is the single most important fact in
  this plan.
- **`RotaGrid.tsx:108–109`** computes `editable = rota.status === "draft" &&
  canWrite` and, when false, mounts a different read-only cell component with
  no drag sources and no popover (`:481`). It gets the stronger read-only
  treatment from the same change, free.
- **Shells.** `App.tsx` has four shells sharing one `ShellHeader` (`:207`).
  `ClinicalShell` (`:235`) and `ReceptionShell` (`:380`) each wrap their
  routes in `PermissionAreaProvider`. Nav filtering and route guards use the
  plain `canWriteArea()` function, **not** the hook — so lowering the hook
  will not hide nav entries or trigger redirects. That is the desired
  behaviour and must not regress.
- **`useHandleLogout`** (`App.tsx:~185`) is shared by all four shells and is
  where logout release hooks in.
- **Next migration is `014`** (last is `013_counter_opening_balance.py`).
- **No OpenAPI codegen or shared types** between backend and frontend. Any
  shared constant is two literals plus a test, not one source.

## Design Decisions

1. **Two locks, one per section.** `clinical` and `reception`. Coarser than
   the provisional plan's five named surfaces, chosen deliberately: the
   mental model is "someone is in the clinical rota", the same thing
   `_AREA` already encodes, and it eliminates the provisional plan's
   unanswered question about ten unclassified routers. The accepted cost is
   that editing the master rota blocks leave entry in the same section.
2. **Lockable areas are exactly the levelled areas.** `LOCKABLE_AREAS =
   ("clinical", "reception")`. These coincide with `AREA_KEYS` today, and
   the reason is structural rather than coincidental: being locked out means
   being downgraded to read-only, and only a levelled permission has a read
   level to be downgraded to. A boolean area (signatures, study EOI, user
   admin) has no such state, so it cannot be locked. Define the constant
   separately from `AREA_KEYS` with that reason written down, and assert it
   is a subset.
3. **Acquisition is automatic, on entering a section.** No button. The
   frontend acquires when a lockable shell mounts, if the login has write
   access to that area. A read-only login never acquires and never blocks
   anyone.
4. **The idle timer measures edits, not browsers.** `last_activity_at` is
   stamped by writes that pass the lock gate — nothing else. There is no
   heartbeat, no ping, and an open browser does not keep a lock alive. This
   is what makes the absence of a force-takeover button safe: the timer is
   the only escape hatch, so it must not be defeatable by leaving a tab
   open.
5. **Staleness is evaluated only when someone else wants in.** A lock older
   than 15 minutes of inactivity is *takeable*, not automatically deleted.
   The holder keeps it indefinitely while nobody else asks, so they never
   lose it to an empty room; the moment another user tries to enter or
   write, the stale row is replaced. `GET /locks` reports an `idle` flag but
   deletes nothing, so polling has no side effects.
6. **A write with no lock takes the lock.** If no row exists, the enforcing
   dependency creates one for the writer and allows the write. This is safe
   (nobody else holds it) and self-healing: a failed acquire call, a stale
   tab, or any non-browser client can never end up permanently unable to
   write with no button to press. Acquire-on-entry is a UX nicety; the
   dependency is the boundary.
7. **Enforcement extends the existing registration loop.** `require_edit_lock`
   is added alongside `require_access` when `_AREA[module]` is lockable.
   Because `_AREA` is already a mandatory direct subscript, a new clinical
   or reception router is locked automatically the moment it is classified —
   no second table to forget.
8. **`require_access` runs first.** A login with no clinical permission gets
   403, not 409. Order the `dependencies` list accordingly and test it.
9. **Rejections answer 409 with a structured detail.** Not 401 (`client.ts`
   would bounce them to the login form), not 403 (which means "never", not
   "not now"). 409 rather than 423 for consistency with every other
   state-conflict refusal in these routers. The detail carries the holder's
   name so the UI can say something useful.
10. **The locks router gates itself**, joining `_UNGATED` with the same
    justification `users` carries: it spans two areas, so no single `_AREA`
    entry describes it.
11. **The lock lowers `useCanWrite`, it does not add a parallel concept.**
    One question — "may I write here, right now" — with two inputs. Every
    existing call site inherits it. No new props are threaded into any grid.
12. **The banner polls every 25 seconds.** No WebSocket. A holder who loses
    their lock sees their screen go read-only within one poll.

## What this deliberately does not solve

State these when describing the feature, or it will be oversold.

- **A reader's screen is not kept fresh.** Someone watching read-only sees
  whatever their last refetch returned. The lock poll refreshes the banner,
  not the grid.
- **Losing the lock mid-edit discards unsaved input.** The popover unmounts
  with the read-only switch. One cell's worth.
- **The holder can block the section all day** by continuing to edit. That
  is the design. The banner names them; the answer is to go and ask.
- **`sendBeacon` release is best-effort.** A crashed tab or a closed laptop
  releases nothing; the 15-minute rule is the real answer.

---

# Task 1: Data model and the staleness primitive

**A. State of the world.** Nothing has been built. This task produces the
table and the one piece of logic every later task consumes, with its own
tests, so nothing downstream has to re-derive it.

**B. Files and deliverables.**

- `backend/app/models/edit_lock.py` (new) — the `EditLock` model.
- `backend/app/models/__init__.py` — export it.
- `backend/app/models/permissions.py` — `LOCKABLE_AREAS` and the timeout.
- `backend/alembic/versions/014_edit_locks.py` (new).
- `backend/tests/test_models.py` or a new `test_edit_lock.py` — unit tests
  for the staleness helper.

**C. Instructions.**

1. In `models/permissions.py`, beside `AREA_KEYS`, add:

   ```python
   LOCKABLE_AREAS: tuple[str, ...] = ("clinical", "reception")
   ```

   Document why it is defined separately from `AREA_KEYS` rather than
   aliased, using Design Decision 2's reasoning: being locked out is a
   downgrade to read-only, and only a levelled permission has a read level to
   downgrade to. Add `assert set(LOCKABLE_AREAS) <= set(AREA_KEYS)` at module
   level. Keep this module free of FastAPI and SQLAlchemy imports, as its
   docstring requires.

2. Also in `permissions.py` (or `models/edit_lock.py` if you prefer the
   timeout beside the model — pick one and say why in the docstring):

   ```python
   EDIT_LOCK_IDLE_TIMEOUT = datetime.timedelta(minutes=15)
   ```

3. `models/edit_lock.py`: an `EditLock` model on table `edit_locks`.

   - `area: Mapped[str] = mapped_column(String, primary_key=True)` — the
     primary key, which is what structurally guarantees at most one lock per
     section. Values are constrained to `LOCKABLE_AREAS` in application code,
     not by a DB enum, so adding a section later needs no migration.
   - `user_id` — FK to `users.id`, not null. No cascade delete: users are
     deactivated rather than deleted in this codebase, and a lock row whose
     user vanished should be a visible problem, not a silent one.
   - `acquired_at`, `last_activity_at` — `DateTime(timezone=True)`, not null.

   Write the module docstring to state the two facts a reader needs: the
   timer measures edits (Design Decision 4), and staleness is evaluated only
   when another user asks (Design Decision 5).

4. In the same module, the staleness helper:

   ```python
   def is_stale(lock: EditLock, now: datetime.datetime) -> bool:
   ```

   It must normalise `last_activity_at` with the `_as_utc` treatment from
   `routers/auth.py:103` — copy the helper or lift it somewhere shared. A
   naive datetime read back from SQLite compared against an aware `now`
   raises `TypeError`, and the whole test suite runs on SQLite. This is the
   single most likely way for this task to look correct and fail in CI.

5. Migration `014_edit_locks.py`, numbered after
   `013_counter_opening_balance.py`, with a working downgrade that drops the
   table. Follow the existing migrations' style for naming constraints
   explicitly.

6. Tests for `is_stale`: fresh lock is not stale; a lock 15 minutes and one
   second idle is stale; a lock with a naive `last_activity_at` (the SQLite
   read-back shape) is handled and does not raise. Construct the naive case
   explicitly — do not rely on the ORM to produce it.

Run `uv run pytest backend/tests/test_models.py` (or your new file) and
`uv run alembic upgrade head` against a scratch database.

---

# Task 2: The locks router

**A. State of the world.** Task 1 is complete: the `edit_locks` table,
`LOCKABLE_AREAS`, `EDIT_LOCK_IDLE_TIMEOUT` and `is_stale` exist and are
tested. This task makes locks readable and writable through the API. It does
**not** make them binding — nothing is enforced until Task 3.

**B. Files and deliverables.**

- `backend/app/api/routers/locks.py` (new).
- `backend/app/api/schemas/` — the lock schemas, following the existing
  layout in that package.
- `backend/app/api/main.py` — import, `_ALL_ROUTERS`, `_UNGATED`.
- `backend/tests/test_api/test_locks.py` (new).
- `backend/tests/test_api/test_authorization.py` — update whatever it
  asserts about `_UNGATED` membership.

**C. Instructions.**

1. Router at prefix `/locks`. Three endpoints:

   **`GET /locks`** — every current lock, for the areas the caller can
   *read*. Filter by the caller's own permissions; a reception-only login
   must not learn who is in the clinical rota. Each entry:
   `{area, user_id, user_name, acquired_at, last_activity_at, idle}` where
   `idle` is `is_stale(...)`. **Deletes nothing** (Design Decision 5).
   `user_name` comes from `User.name`, which exists (`models/user.py:144`).

   **`POST /locks/{area}`** — acquire.
   - 422 if `area` not in `LOCKABLE_AREAS`.
   - Requires write access to that area — see step 2.
   - No row exists → create, `acquired_at = last_activity_at = now`, 200.
   - Row is the caller's → 200, returning it unchanged. **Do not bump
     `last_activity_at`**: re-entering a section is not editing, and bumping
     here would let someone hold a lock indefinitely by navigating around.
   - Row is another user's and `is_stale` → delete it, create the caller's,
     200.
   - Row is another user's and fresh → **409** (step 3).

   **`DELETE /locks/{area}`** — release. 204. If the caller does not hold it
   (expired, or never had it), still 204: releasing something you do not hold
   is not an error, and this keeps the page-unload beacon path trivial.

2. The router is **not** classifiable in `_AREA` — `require_access` takes one
   area and this router spans two. Add it to `_UNGATED` and gate each
   endpoint itself, exactly as `users.py` does. The required area is the
   `{area}` path parameter, so a small helper that resolves
   `require_access(area)`-equivalent logic per request is appropriate; do not
   duplicate the permission logic — reuse `canWriteArea`'s backend
   counterpart in `models/permissions.py`. Extend `_UNGATED`'s docstring in
   `main.py` with a justification as specific as the three already there.
   Every endpoint must have a gate; add a test that asserts this, mirroring
   whatever shape `test_authorization.py` already uses for `users`.

3. The 409 body. `HTTPException(status_code=409, detail={...})` — FastAPI
   accepts a dict detail and the frontend reads `body.detail`
   (`client.ts:~85`). Shape:

   ```python
   {
       "message": "Kristel Smith is editing the clinical rota",
       "code": "edit_lock_held",
       "area": "clinical",
       "holder_user_id": 3,
       "holder_name": "Kristel Smith",
       "acquired_at": "...",
       "last_activity_at": "...",
   }
   ```

   Task 3 raises the identical shape, so define it once in a shared helper in
   this module and import it there. `code` exists so the frontend can
   distinguish a lock 409 from the several other 409s these routers already
   return (`_require_draft`, staging conflicts) without string-matching.

4. Tests: acquire on a free area; acquire twice as the same user is a no-op
   that does not move `last_activity_at`; acquire while another holds it
   fresh gives 409 with the right `code` and `holder_name`; acquire while
   another holds it stale succeeds and replaces the row; `GET /locks` shows
   only areas the caller can read; `GET /locks` does not delete a stale row;
   release by the holder clears it; release by a non-holder is 204 and leaves
   the row alone; a read-only login cannot acquire (403).

Run `uv run pytest backend/tests/test_api/test_locks.py
backend/tests/test_api/test_authorization.py`.

---

# Task 3: Enforcement

**A. State of the world.** Tasks 1–2 are complete: locks can be read,
acquired and released, but nothing consults them. This task makes them
binding on every clinical and reception write.

**B. Files and deliverables.**

- `backend/app/api/deps.py` — `require_edit_lock`.
- `backend/app/api/main.py` — the registration loop.
- `backend/tests/test_api/test_edit_lock_enforcement.py` (new).

**C. Instructions.**

1. `require_edit_lock(area: str)` in `deps.py`, a dependency factory
   mirroring `require_access` (`deps.py:203`) in shape and in docstring
   style. Validate `area in LOCKABLE_AREAS` in the factory, not the closure,
   so a typo fails at import.

   The returned dependency takes `request: Request`,
   `user: User = Depends(get_current_user)` and `db: Session =
   Depends(get_db)`. FastAPI caches sub-dependencies within a request, so
   `get_current_user` resolves once even though `require_access` also asks
   for it.

   Logic:
   - `request.method in _SAFE_METHODS` → return immediately. Reading is never
     blocked.
   - Load the row for `area`.
   - No row → create one for this user (Design Decision 6), commit, allow.
   - Row is this user's → set `last_activity_at = now`, commit, allow. This
     bump *is* the idle timer.
   - Row is another user's and `is_stale` → delete, create this user's,
     commit, allow.
   - Row is another user's and fresh → raise the shared 409 from Task 2.

   Commit explicitly in the dependency. The endpoint may not commit, and on
   the 409 path it never runs. A bump that survives a subsequent endpoint
   error is correct: attempting an edit is activity.

2. The registration loop in `main.py`. Replace the `dependencies` expression
   with something of this shape, keeping the existing comments about
   default-deny intact and adding one for the lock:

   ```python
   for module in _ALL_ROUTERS:
       if module in _UNGATED:
           dependencies = []
       else:
           area = _AREA[module]  # direct subscript: see above
           dependencies = [Depends(require_access(area))]
           if area in LOCKABLE_AREAS:
               dependencies.append(Depends(require_edit_lock(area)))
       app.include_router(module.router, prefix=API_PREFIX, dependencies=dependencies)
   ```

   Note in the comment why there is **no** separate lock-surface table: the
   lock is per section, `_AREA` already records the section, and a second
   mandatory classification would be a second thing to forget. Order matters
   — `require_access` first, so a permission failure is 403 rather than 409
   (Design Decision 8).

3. Tests. These are the ones that matter:
   - GET on a locked area, by a non-holder, succeeds. Do this for both
     sections.
   - PATCH/POST on a locked area by a non-holder → 409, `code` is
     `edit_lock_held`, `holder_name` is right.
   - The holder's write succeeds and moves `last_activity_at`.
   - A write when no lock exists succeeds and creates the lock for the
     writer.
   - A write against a stale lock held by someone else succeeds and takes it
     over.
   - A login with no clinical permission gets **403, not 409**, even when
     someone else holds the lock — this asserts dependency order.
   - A clinical lock does not block reception writes, and vice versa.
   - Signatures, EOI and audit routers are unaffected.
   - A new router classified `clinical` in `_AREA` is lock-gated with no
     other change — assert by inspecting the registered dependencies rather
     than by adding a fake router, if that is cleaner in this suite.

Run `uv run pytest backend/tests/test_api/`.

---

# Task 4: Frontend lock state, folded into the write gate

**A. State of the world.** Tasks 1–3 are complete: the backend enforces the
lock, and a non-holder's writes 409. The frontend knows nothing about it, so
users currently get rejected writes with a generic error. This task makes the
UI lock-aware. It is invisible-plumbing work; the banner and dialog are
Task 5.

**B. Files and deliverables.**

- `frontend/src/api/locks.ts` (new) — query and mutations.
- `frontend/src/auth/AuthContext.tsx` — `EditLockProvider`, and
  `useCanWrite` / `useWriteGate` made lock-aware.
- `frontend/src/App.tsx` — provider placement in the two lockable shells.
- Tests alongside, following the existing `*.test.tsx` convention.

**C. Instructions.**

1. `api/locks.ts`:
   - `useLocks()` — `GET /locks`, `refetchInterval: 25_000`. Returns the
     array typed against the Task 2 response.
   - `useAcquireLock()`, `useReleaseLock()` — the two mutations.
   - A `isEditLockError(error)` type guard reading
     `error.status === 409 && error.detail?.code === "edit_lock_held"`.
     Everything else in the app that handles a 409 must keep working, so
     match on `code`, never on the message text.

2. `EditLockProvider` in `AuthContext.tsx` (same file as the permission
   context — it is the same question, and Design Decision 11 says do not
   create a parallel concept). It takes `area`, calls `useLocks()`, and
   exposes:

   ```ts
   { area, heldByOther: boolean, holderName: string | null, holderIsMe: boolean }
   ```

   On mount, if `canWriteArea(permissions, area)`, fire the acquire
   mutation. A 409 is an expected outcome, not an error — it means somebody
   else has it, and Task 5 renders the dialog for it. On unmount, fire the
   release mutation.

   Default context value: no lock held by anyone. A component rendered
   outside the provider must not be locked out — the deny-by-default
   reasoning that applies to permissions does **not** apply here, because
   the server is the boundary and a false "locked" in the UI is a bug that
   looks like an outage.

3. `useCanWrite()` — AND in the lock:

   ```ts
   const resolved = area ?? contextArea;
   const lock = useEditLock();
   if (resolved === null) return false;
   if (!canWriteArea(permissions, resolved)) return false;
   if (lock.area === resolved && lock.heldByOther) return false;
   return true;
   ```

   The `lock.area === resolved` check matters: `useCanWrite(area)` with an
   explicit argument asks about a *different* section (its docstring says
   so), and must not be answered with this section's lock.

4. `useWriteGate()` — when the block is the lock rather than permissions, the
   tooltip must say so. Add a second constant beside `NO_WRITE_ACCESS_TITLE`
   (`AuthContext.tsx:40`), e.g. `` `${holderName} is editing this section` ``.
   A user who is told "your permissions do not allow changes here. Ask a user
   administrator" when the real answer is "Kristel has it open" will raise a
   support request.

5. `App.tsx`: wrap `ClinicalShell`'s and `ReceptionShell`'s
   `PermissionAreaProvider` with `EditLockProvider area="clinical"` /
   `"reception"`. **Not** `SignaturesShell` or `AdminShell` — those areas are
   not lockable.

6. **Verify the negative cases**, which are the regression risk of touching
   a hook used in ~20 places:
   - Nav entries do **not** disappear when locked out. `ClinicalShell`'s nav
     filter uses `canWriteArea()` directly, not the hook, so this should hold
     — add a test that pins it.
   - Route guards do **not** redirect a locked-out writer to the reader home.
     Same reason, same treatment.
   - `SignaturesPage` and `EoiPage` are unaffected by a clinical lock.
   - `RotaGrid`'s `editable` goes false under a lock, so the read-only cell
     renders and no drag sources or popovers mount.

Run `npm run test -- src/auth src/api/locks src/App` plus the tests for any
grid you touched.

---

# Task 5: Entry dialog, banner, and the release paths

**A. State of the world.** Tasks 1–4 are complete: the backend enforces the
lock and the whole UI already renders read-only when someone else holds it.
What is missing is telling the user *why*, and letting go of the lock
promptly. This is the task that decides whether the feature feels like a
shared drive or like a bug.

**B. Files and deliverables.**

- `frontend/src/components/EditLockBanner.tsx` (new).
- `frontend/src/components/EditLockDialog.tsx` (new), or folded into the
  banner file if small.
- `frontend/src/App.tsx` — banner placement, logout release.
- `frontend/src/auth/AuthContext.tsx` — unload release.
- Tests alongside.

**C. Instructions.**

1. **The dialog.** When the acquire mutation from Task 4 comes back 409 on
   section entry, show a modal once: who has it, since when, and that the
   section is read-only until they finish. Dismiss-only — there is no
   takeover button (Design Decision: none exists). Show it **once per
   provider mount**, not per navigation within the section: the shell stays
   mounted as the user moves between pages, so this falls out naturally,
   but add a test for it. Nobody should see this dialog five times while
   clicking through Session Management.

2. **The banner.** A standing strip immediately below `ShellHeader`, inside
   `ClinicalShell` and `ReceptionShell` only. Two states worth rendering:
   - Held by someone else: name, and how long ago they started.
   - Held by me: a quiet confirmation. This is worth having — it is the only
     signal that explains why *other* people cannot edit, and it makes
     "please close the rota" a conversation people can have.

   Do not render anything when no lock exists.

3. **Release on exit.** Three paths, in descending reliability:
   - Provider unmount (leaving the section, switching apps) — the mutation
     from Task 4.
   - `useHandleLogout` in `App.tsx:~185`, shared by all four shells: release
     before clearing the token. It is best-effort, wrapped in try/catch
     exactly as the existing logout mutation is — a failure here must never
     block logout.
   - `navigator.sendBeacon` on `pagehide` for tab close. Note that beacon
     cannot set an `Authorization` header, so either accept that this path
     will not work with bearer-token auth and drop it, or take the small
     token-in-body endpoint variant — **decide explicitly and write down
     which**. Dropping it is defensible: the 15-minute rule already covers a
     closed tab, and a half-working beacon is worse than none.

4. **Handle the 409 when it arrives mid-session.** A holder who went idle for
   15 minutes and lost the lock will have a screen that still believes it can
   write. When any mutation fails `isEditLockError`, invalidate the `locks`
   query immediately so the banner and the read-only state update within a
   second rather than waiting up to 25 for the next poll, and surface the
   `message` from the detail rather than a generic error toast. Put this in
   one shared place; do not repeat it per mutation.

5. Tests: the dialog appears on a 409 acquire and not otherwise; it appears
   once across an in-section navigation; the banner renders both states and
   nothing when free; logout releases; a mid-session lock 409 flips the UI to
   read-only without waiting for the poll.

Run `npm run test -- src/components/EditLockBanner src/App src/auth`.

---

# Task 6: Review and documentation

**A. State of the world.** Tasks 1–5 are complete and the feature is live.
This task is for review and documentation only; write no feature code.

**B. Files and deliverables.**

- `documentation/architecture.md` — the design decisions.
- `documentation/architecture-clinical.md`,
  `documentation/architecture-reception.md` — a short pointer each.
- Delete `documentation/edit_lock_plan.md`.

**C. Instructions.**

1. Add a section to `architecture.md` covering, at the level of *why* rather
   than *what* (the code says what):
   - Two locks, one per section, keyed on the same areas `_AREA` already
     uses — and that this is why there is no separate lock-surface table.
   - That the idle timer measures **edits, not browsers**, and that this is
     what makes the absence of a force-takeover button safe. Anyone who later
     proposes adding a heartbeat needs to read this and understand they are
     removing the escape hatch.
   - That staleness is evaluated only when another user asks, so a holder
     never loses a lock to an empty room and `GET /locks` has no side
     effects.
   - That a write with no lock takes the lock, so there is no dead end.
   - That the lock is implemented as a lowering of `useCanWrite`, which is
     why every control in the app respects it without per-component work —
     and the corollary that anything bypassing `useCanWrite`/`useWriteGate`
     will silently bypass the lock too.
   - That 409 is forced by `client.ts` bouncing every 401 to the login form.
   - The lazy-sweep-not-cron precedent, consistent with sessions and reset
     tokens.

2. Two or three lines each in the clinical and reception architecture docs
   pointing at the above. Do not duplicate it.

3. Re-read the "What this deliberately does not solve" list above and carry
   anything still true into `architecture.md`, so the next person does not
   rediscover it as a bug.

4. Delete this file.
