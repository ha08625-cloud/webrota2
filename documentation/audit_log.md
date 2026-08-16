# Audit Log — Implementation Plan

Status: **implementation plan**. Reviewed and expanded from the provisional
plan. Each task below is intended to be handed to a fresh chat as its own
context.

## Plan

Record one row per write request to the API — who made it, which route, which
entity, what they sent, and what happened — captured automatically by
middleware so that coverage cannot drift as endpoints are added. Surface it as
a manager-only, filterable, paginated page.

The stated purpose is **debugging**: reconstructing "the rota looks wrong —
what happened to it?" from the sequence of requests that touched it. That
drives every decision below, most visibly the choice to make `path` a
substring-searchable column so `/rota/12/` retrieves the whole history of one
rota in one filter, and the decision to capture request bodies so the log can
answer "what did they change it *to*?".

## Scope

### In

- A new `audit_log` table and Alembic migration `003`.
- ASGI middleware capturing every non-GET request that reaches the app:
  timestamp, user, method, templated route, actual path, path params,
  JSON request body (redacted), status code, error detail, duration, client IP.
- A hook in `get_current_user` so the acting user is recorded with no extra
  query.
- Two exception handlers (`HTTPException`, `RequestValidationError`) so the
  reason for a 4xx is captured, and explicit 500 capture in the middleware.
- Enrichment of `POST /auth/login` on success, the one endpoint where a user
  is resolved without `get_current_user` running.
- `GET /audit` — manager-only, paginated, filtered.
- `AuditLogPage` at `/clinical/audit`, manager-only, hidden from nav below
  manager, matching how `Users` already behaves.

### Out

- **Before/after field diffs.** Would require the SQLAlchemy `before_flush`
  approach, a per-table allowlist, and a story for generation runs writing
  thousands of session rows at once. Several times the work of everything
  else here combined. The captured request body gets most of the way there
  for a fraction of the cost.
- **GET auditing.** The app holds staff scheduling data, not patient data, so
  read auditing would be pure noise. Excluded deliberately, not by oversight.
- **Multipart bodies.** `POST /signatures/{doctor_id}` and
  `POST /signatures/{doctor_id}/apply` upload documents. Their bodies are not
  buffered at all — see Design Decision 8.
- **Retention / pruning.** Nothing is deleted. See Design Decision 9.
- **Editing or deleting audit rows.** There is no write API for this table at
  all; the only writer is the middleware.

## Design Decisions

### 1. Middleware, not per-endpoint calls

There are 81 non-GET endpoints across 22 routers. Instrumenting them
individually would be default-OPEN: the next `POST` anyone adds is unaudited
until somebody remembers the call, and no test catches it. This is the same
argument `main.py` already makes for attaching `require_write_access` at
`include_router` time rather than per-endpoint, and it applies unchanged.
Middleware makes a new router — and a new endpoint on an existing router —
audited by default.

The cost is that entries are HTTP-shaped, not domain-shaped: the log says
`PATCH /rota/{rota_id}/sessions/{session_id} → 200` with the JSON that was
sent, not "moved Dr AB from room 3 to room 5". Accepted, given the debugging
purpose.

The rejected third option was SQLAlchemy `before_flush` diffing. It produces
genuinely better entries — real old and new values — but has no notion of
intent, so one rota generation would emit thousands of rows for a single user
action.

This decision is also why request bodies are captured *in the middleware*
rather than by per-endpoint enrichment calls (Design Decision 8): enriching
81 endpoints by hand would reintroduce exactly the default-OPEN property this
decision exists to avoid.

### 2. Pure ASGI middleware, not `BaseHTTPMiddleware`

`BaseHTTPMiddleware` runs the downstream app in a spawned anyio task, which
complicates contextvar propagation and request-body handling. A plain
`async def __call__(self, scope, receive, send)` class avoids both. The status
code is captured by wrapping `send` and reading the `http.response.start`
message.

Reading `scope["route"]` and `scope["path_params"]` **after** awaiting the
downstream app gives the templated route and the entity ids, because the same
`scope` dict is mutated during routing.

Two things about this that the provisional plan got wrong, both verified
against the installed versions (FastAPI 0.139.2, Starlette 1.3.1):

- **`scope["route"]` is set by FastAPI, not Starlette.** Starlette's
  `Route.matches` returns only `endpoint` and `path_params`; it is
  `fastapi.routing.APIRoute.matches` that adds `child_scope["route"] = self`.
  The version risk is therefore a *FastAPI* risk — and a live one, since
  0.139 has just restructured router inclusion into nested `_IncludedRouter`
  objects rather than flattened routes. Implement with a fallback to the raw
  path and cover it with a test, so a FastAPI upgrade degrades the log rather
  than breaking requests.
- **`route.path` does not include the `/api/v1` prefix.** The measured value
  for `PATCH /api/v1/rota/12/sessions/45` is
  `/rota/{rota_id}/sessions/{session_id}`. The `include_router(prefix=...)`
  prefix is not part of `route.path`, and `scope["root_path"]` is `""`, so
  there is nothing to reconstruct it from short of hardcoding the constant.
  Store what the scope gives and document it; the router prefixes (`/rota`,
  `/auth`, `/doctors`, …) are in there, so routes are still unambiguous.

Also measured, and worth knowing before writing assertions:
`scope["path_params"]` values are **strings** (`{'rota_id': '12'}`) — FastAPI
coerces to `int` at the endpoint, not in the scope.

### 3. Enrichment via a mutable context object, never `contextvar.set()`

Every router in this codebase is `def`, not `async def`, so FastAPI runs
endpoints in a threadpool. `anyio`'s `run_sync_in_worker_thread` executes the
function via `context.run(func)` on a **copy** of the context, which means a
`contextvar.set()` performed inside an endpoint is **invisible** to the
middleware afterwards.

Therefore: the middleware sets the contextvar **once**, to a mutable dataclass,
before calling downstream. Endpoints, dependencies and exception handlers
mutate that object's fields. Mutation is visible because it is the same
object; rebinding is not.

Getting this backwards produces a log that silently records nothing extra,
with tests that pass. It is the single most important line in this document.

### 4. The acting user comes from `get_current_user`, not a second lookup

The middleware could re-resolve the bearer token itself, but that is a second
indexed `SELECT` on every write request. `get_current_user` already runs on
every gated endpoint and already has the `User` row in hand, so it writes
`user_id`, `email` and `access_level` into the audit context as it returns.
Zero extra queries.

When `get_current_user` raises 401 no user is recorded, which is correct —
there wasn't one.

**Consequence for tests:** `get_current_user` is dependency-overridden by
every fixture in `tests/test_api/conftest.py` except `client_no_auth`, so this
hook never runs for the great majority of the API suite. Any test that asserts
user capture must go through `client_no_auth` with a real seeded user and a
real login, or it will assert nothing while appearing to pass.

### 5. Identity fields are frozen snapshots, and `access_level` is a plain string

`user_email` and `user_access_level` are copied into the row at write time
rather than joined from `users` at read time, so an entry still reads correctly
after a user is renamed or demoted. This copies `RotaGenerationLogEntry`'s
"frozen prose, never re-derived" convention.

`user_access_level` is a `String`, **not** `enum_col(AccessLevel)`. A native
Postgres enum would turn any future tier rename or removal into a migration
against historical rows that are, by definition, meant to be immutable. It
also keeps `downgrade()` to a plain `drop_table` with no `DROP TYPE` cleanup.

`user_id` does get a real FK to `users.id`, unlike `RotaGenerationLogEntry`'s
deliberately FK-free columns: there is no `DELETE /users` endpoint (the router
has GET, POST, and two PATCHes, nothing else) and users are never hard-deleted,
so the FK adds no delete-blocker surface. Nullable, for requests with no
authenticated actor.

### 6. Filter by `path` substring, and do not index it

The key debugging question is "show me everything that touched rota 12".
`path_params` is stored as `sa.JSON` for display, but filtering it would need
`->>` on Postgres and `json_extract` on SQLite — a portability wrinkle in a
codebase that runs SQLite in tests and Postgres in production.

A `path LIKE '%/rota/12/%'` substring filter is portable, needs no extra
columns, and is exactly the query a human debugging an incident wants.
`sa.JSON` rather than `JSONB` for the same SQLite-parity reason.

But: **`path` is deliberately not indexed.** A leading-wildcard `LIKE` cannot
use a B-tree index, so an index there would cost a write on every audited
request and serve no read. Making it fast would need `pg_trgm`, which breaks
the SQLite parity this decision exists to protect. The filter is a sequential
scan and that is accepted.

Two wrinkles to write into the UI copy rather than engineer around:

- The substring has no word boundaries, so `/rota/12` also matches `/rota/120`
  and `/rota/125`. Searching `/rota/12/` avoids it for sub-resources but not
  for a request to the rota itself.
- User input goes through `.contains(value, autoescape=True)`. Without
  `autoescape`, a `%` or `_` typed into the filter box silently changes the
  query.

Only `at` and `user_id` are indexed. `status_code` is low-cardinality and its
filter is a range that Postgres will serve off the `at` index ordering anyway.

### 7. Audit failures never fail the request

The middleware's write happens in its own session, in its own transaction,
after the endpoint's transaction has already committed **and after the
response has been flushed to the client** — so it adds no user-visible
latency. Any exception is caught and logged, never re-raised.

Two consequences worth stating plainly:

- The log is **best-effort**, not guaranteed. A database problem loses entries
  silently. Given the debugging purpose, an audit outage taking down rota
  generation would be the worse failure.
- A request that 500s and rolls back its own transaction still produces an
  audit row recording the 500 — but **only because the middleware catches the
  exception explicitly**. This does not happen for free, and the provisional
  plan was wrong to assume it did.

  `app.add_middleware` places this middleware *inside* Starlette's
  `ServerErrorMiddleware` but *outside* its `ExceptionMiddleware`. An
  unhandled endpoint exception therefore propagates up through this middleware
  as an exception; `http.response.start` is never sent and the wrapped `send`
  never fires. Verified empirically against the real app. The middleware must
  wrap the downstream await in `try / except BaseException`, record status 500
  and the exception repr, write the row, and re-raise.

### 8. Request bodies are captured, redacted, in the middleware

The provisional plan excluded bodies and then said, correctly, that this was
the weakest fit for a debugging-first log: knowing that someone sent
`PATCH /rota/12/sessions/45` and got a 200 does not tell you what the cell was
set *to*, and that is the next question after almost every lookup. Reversed on
review.

Capture happens in the middleware, not per-endpoint, for the Design Decision 1
reason: 81 hand-written enrichment calls would be default-OPEN. The middleware
drains `receive`, keeps the bytes, and hands downstream a replacement
`receive` that replays them.

Four rules keep this cheap and safe:

- **JSON only.** If `content-type` is not `application/json`, the body is not
  buffered at all and `receive` is passed through untouched. This is what
  keeps the two `signatures` document uploads out of memory and out of the
  log.
- **16 KiB cap.** Larger bodies are replayed downstream normally but stored as
  a `{"_audit": "body too large", "bytes": N}` marker rather than content.
- **Redaction by key name**, recursively through dicts and lists:
  `password`, `new_password`, `current_password`, `token`, `password_hash`
  become `"[redacted]"`. Every password field across `LoginIn`, `UserIn`,
  `UserPatch` and `UserSelfPatch` is named `password`, so this covers the
  whole surface; the list is a single module constant so a new secret-bearing
  schema has one place to register.
- **Unparseable JSON** is stored as `{"_audit": "unparsed body"}` rather than
  raw bytes.

The honest caveat that survives: this is *what was sent*, not *what changed*.
A no-op PATCH and a real one look identical, and a 200 does not prove the
field the body names is the field that moved. It is a large improvement on
nothing, not a substitute for diffs.

One residual leak: a user who types their password into the email box on the
login form puts it in `email`, which is not redacted. The provisional plan's
"passwords cannot leak into the audit log by construction" claim is therefore
dropped rather than defended.

### 9. Nothing is pruned

This is the only table in the schema that grows without bound. At this
practice's scale that is tens of thousands of rows a year, which is nothing for
Postgres, and pruning a debugging log is self-defeating the first time you need
last quarter.

The thing that degrades first is not storage, it is the `total` count: every
page view runs a `COUNT(*)` which, under a `path_contains` filter, is a full
scan (Design Decision 6). At tens of thousands of rows a year that is fine for
a long time. Revisit when it is a real problem rather than a theoretical one —
the cheap fix at that point is to stop returning an exact `total`, not to
prune.

### 10. `/clinical/audit`, following `Users`

The audit log is cross-cutting — it covers reception and signatures too — so
`/clinical/` is not a perfect home. But `Users` is not clinical either and
already lives at `/clinical/users` with `managerOnly: true`, and
`CLINICAL_NAV_ITEMS` already has the filtering machinery. Consistency with the
existing precedent beats a fourth top-level shell for one page.

### 11. First paginated list in the app

Every other resource in this frontend is fetched wholesale, because reference
data is small. The audit log is not, so `GET /audit` is server-paginated
(`limit`/`offset` with a total count) and the page uses
`placeholderData: keepPreviousData` so paging does not flash empty. This is a
new pattern for the codebase and should be written to be copied.

Ordering is `at DESC, id DESC`. The tiebreak is not decorative: timestamps
collide at millisecond resolution under a burst, and without it offset
pagination can repeat or skip rows between pages. Rows written while a user
is paging still shift the window; that is inherent to offset pagination and
is accepted.

---

# Task 1: Data model and migration

**A. State of the world.** Nothing of this plan has been implemented yet. This
is the first task: the table and its migration, with no code reading or
writing it.

**B. Files and deliverables.**

- `backend/app/models/audit.py` (new) — `AuditLogEntry`.
- `backend/app/models/__init__.py` — import and add to `__all__`.
- `backend/alembic/versions/003_audit_log.py` (new) — `down_revision = "002"`
  (002 is currently head), with a working `downgrade()`.
- `backend/tests/test_models.py` — one round-trip test for the new model.

**C. Instructions.**

Create `AuditLogEntry` on table `audit_log`:

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `at` | `DateTime(timezone=True)`, not null, **indexed** | UTC, aware. Set in Python, no server default. Note `deps.py`'s warning that SQLite does not round-trip tzinfo — a value read back on SQLite is naive and must be treated as UTC |
| `user_id` | int FK `users.id`, nullable, **indexed** | |
| `user_email` | `String`, nullable | frozen snapshot |
| `user_access_level` | `String`, nullable | frozen snapshot, deliberately **not** `enum_col` — see Design Decision 5 |
| `method` | `String(10)`, not null | |
| `route` | `String`, nullable | templated, router-local, e.g. `/rota/{rota_id}/sessions/{session_id}` — **no `/api/v1` prefix**, see Design Decision 2. Null when no route matched (404) |
| `path` | `String`, not null, **not indexed** | actual path, the substring filter target — see Design Decision 6 for why there is no index |
| `path_params` | `sa.JSON`, nullable | display only; values are strings |
| `request_body` | `sa.JSON`, nullable | redacted JSON body, or a `{"_audit": ...}` marker — see Design Decision 8 |
| `status_code` | int, not null | |
| `outcome_detail` | `Text`, nullable | `HTTPException.detail`, a rendered validation error, or an exception repr |
| `duration_ms` | int, nullable | |
| `client_ip` | `String`, nullable | first `X-Forwarded-For` entry, else `scope["client"][0]` |

Write the module docstring in the style of `models/generation_log.py`: state
that rows are written only by the audit middleware, that there is no write API
for this table, that identity fields are frozen snapshots, and that
`user_access_level` is a plain string so historical rows never need a migration
when a tier is renamed. Record the reasoning, not a pointer to this plan file —
see the "do not cite plan documents" rule at the end of
`documentation/architecture.md`.

Add a one-line comment on `path` saying it is deliberately unindexed because
the only filter against it is a leading-wildcard `LIKE`.

The migration is a plain `op.create_table` plus two `op.create_index` calls
(`at`, `user_id`); `downgrade()` drops the indexes then the table. There is no
native enum here, so nothing else needs cleaning up — the CI Postgres job runs
upgrade/downgrade/upgrade and this must survive it.

Do **not** register the middleware or any router in this task.

---

# Task 2a: Capture — context, middleware, test wiring

**A. State of the world.** Task 1 is complete: the `audit_log` table, the
`AuditLogEntry` model and migration `003` exist. Nothing writes to it yet.
This task builds the capture mechanism itself. The enrichment hooks
(`get_current_user`, exception handlers, login) are Task 2b.

**B. Files and deliverables.**

- `backend/app/api/audit.py` (new) — `AuditContext`, the `ContextVar`,
  `AuditMiddleware`, `set_session_factory`, body redaction.
- `backend/app/api/main.py` — register the middleware, wire the session
  factory.
- `backend/tests/conftest.py` — project-level autouse fixture disabling audit
  writes.
- `backend/tests/test_api/conftest.py` — autouse fixture pointing the factory
  at the per-test engine.
- `backend/tests/test_api/test_audit.py` (new) — the capture tests.

**C. Instructions.**

**`audit.py` must not import `deps.py`.** Task 2b makes `deps.py` import this
module, so a dependency in the other direction is a circular import. Define the
safe-method set locally rather than reaching for `deps._SAFE_METHODS`.

*Context.* A mutable `@dataclass` `AuditContext` holding every field the row
needs, and a module-level `ContextVar[AuditContext | None]`. Export a
`current_audit_context()` helper returning the context or `None`. Put Design
Decision 3 in the module docstring in full — every router in this codebase is
`def`, so it runs in a threadpool on a *copied* context; mutate the object,
never call `.set()` from an endpoint. A comment saying "mutate, do not rebind"
on the dataclass itself as well.

*Session factory.* Module-level `_session_factory`, default `None`, with
`set_session_factory(factory)`. `None` means **disabled** — the middleware
does everything else and skips the write. `main.py` calls
`set_session_factory(SessionLocal)` explicitly at import. Middleware cannot use
`get_db` dependency overrides, which is the whole reason this indirection
exists; say so in a comment.

*Middleware.* Pure ASGI, `async def __call__(self, scope, receive, send)`:

1. Pass straight through for non-`http` scopes and for `GET`/`HEAD`/`OPTIONS`.
2. Build an `AuditContext`, `.set()` it on the contextvar, record a
   monotonic start time.
3. If `content-type` starts with `application/json`, drain `receive` into a
   single buffer and substitute a replay `receive` that yields one
   `http.request` message with `more_body: False` and then repeats
   `http.disconnect`. Handle a `http.disconnect` arriving during the drain.
   For any other content type, pass the original `receive` through untouched —
   this is what keeps the signature document uploads out of memory.
4. Wrap `send` to capture the status from `http.response.start`.
5. Await downstream inside `try / except BaseException`. On exception: set
   status 500 and `outcome_detail` to `f"{type(exc).__name__}: {exc}"`
   (truncated), write the row, **re-raise**. Do not let a failure in the write
   mask the original exception. See Design Decision 7 — this is not optional,
   the 500 case produces no row without it.
6. After a normal return, read `scope.get("route")` and
   `scope.get("path_params")`. `getattr(route, "path", None)` with a fallback
   to `None` — a FastAPI upgrade must degrade the log, not break requests.
7. Write the row via the session factory in its own session and transaction,
   inside a `try/except Exception` that logs and swallows. Never re-raise.

*Body redaction.* A module constant `_REDACTED_KEYS` (`password`,
`new_password`, `current_password`, `token`, `password_hash`) and a recursive
walker over dicts and lists replacing matched values with `"[redacted]"`.
Bodies over 16 KiB are stored as `{"_audit": "body too large", "bytes": N}`;
unparseable JSON as `{"_audit": "unparsed body"}`. One comment noting that a
password typed into the email box still lands in the log unredacted.

*`main.py`.* Import and `app.add_middleware(AuditMiddleware)`, and call
`set_session_factory(SessionLocal)`. `add_middleware` prepends, so adding it
after `CORSMiddleware` makes the audit middleware **outermost** — it wraps CORS
rather than sitting inside it. Either order works; pick one and leave a comment
saying the choice was deliberate. Extend the module docstring to cover audit
registration alongside the existing write-gate explanation.

*Test wiring — treat this as part of the task, not follow-up.* This middleware
runs on **every** request in the existing API suite, and by default the session
factory would be the developer's real `rota.db`.

- `backend/tests/conftest.py`: an autouse fixture calling
  `set_session_factory(None)` for the duration of every test, restoring after.
  This is the safety net — no test anywhere can write audit rows into a real
  database by accident.
- `backend/tests/test_api/conftest.py`: an autouse fixture depending on
  `session_factory` that calls `set_session_factory(session_factory)`, so API
  tests do exercise the write path against the per-test engine. Autouse
  fixtures from the deeper conftest are instantiated after the root one, so
  this wins; add a comment saying the ordering is load-bearing.
- Document both in the `test_api/conftest.py` module docstring, which already
  lists the fixtures and their traps.

*Tests (`test_api/test_audit.py`).* Cover, at minimum: a `PATCH` writes exactly
one row with the templated route and path params; a `GET` writes none; a
successful login body is captured with `password` redacted and `email` intact;
a multipart upload writes a row with a null `request_body` and the upload still
succeeds (proves `receive` was not consumed); an endpoint raising an unhandled
exception still produces a row with `status_code` 500; a write failure (point
the factory at a broken session) does not fail the request; and an unmatched
path produces a row with `route` null.

---

# Task 2b: Enrichment — user, exception detail, login

**A. State of the world.** Tasks 1 and 2a are complete: the table, migration,
audit context, middleware and test wiring all exist, and rows are being written
for every non-GET request. Those rows currently have no user and no
`outcome_detail`. This task fills both in.

**B. Files and deliverables.**

- `backend/app/api/deps.py` — mutate the audit context in `get_current_user`.
- `backend/app/api/main.py` — two exception handlers.
- `backend/app/api/routers/auth.py` — enrich a successful login.
- `backend/tests/test_api/test_audit.py` — extend.

**C. Instructions.**

*`get_current_user`.* Immediately before returning the `User`, fetch the audit
context and, if present, set `user_id`, `user_email` and
`user_access_level` (as `user.access_level.value`, a plain string). Zero extra
queries — the row is already in hand. Nothing to do on the 401 paths: there
genuinely was no user. Extend the module docstring with a short paragraph.

*Exception handlers in `main.py`.* Two of them, each recording into the audit
context and then delegating to FastAPI's own handler so behaviour is
completely unchanged:

- `starlette.exceptions.HTTPException` — **not** `fastapi.HTTPException`.
  FastAPI registers its default handler under the Starlette class; registering
  for the FastAPI one leaves 401s, 403s and 404s raised by the framework
  itself uncovered. Record `exc.detail` (stringified) into `outcome_detail`.
  Delegate to `fastapi.exception_handlers.http_exception_handler`.
- `fastapi.exceptions.RequestValidationError` — a separate handler, because an
  `HTTPException` handler never sees it. This is the 422 case, and it matters:
  "my edit was rejected and I don't know why" is a core debugging question.
  Render `exc.errors()` compactly as text —
  `"; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" ...)`, then
  truncate. Do not try to JSON-serialise `exc.errors()` directly; its `ctx`
  entries can contain non-serialisable exception objects. Delegate to
  `fastapi.exception_handlers.request_validation_exception_handler`.

Both handlers run inside `ExceptionMiddleware`, which is inside the audit
middleware and in the same task, so mutating the context object works — see
Design Decision 3.

*`POST /auth/login`.* On success only, after the user is resolved, set
`user_id` / `user_email` / `user_access_level` on the audit context. This is
the one endpoint that authenticates a user without `get_current_user` running.

The failure path needs **nothing**: the request body is already captured with
`password` redacted and `email` intact, so "the user says they can't log in"
is answerable from the row the middleware writes. The provisional plan's
separate failed-login enrichment is dropped as redundant. `POST /auth/logout`
already depends on `get_current_user` and needs nothing either — confirm and
move on.

*Tests.* User capture must go through `client_no_auth` with a real seeded user
and a real login — every other client fixture overrides `get_current_user`, so
the hook never fires and a test written against them asserts nothing while
passing (Design Decision 4). Cover: a real authenticated write records
`user_id`/`user_email`/`user_access_level`; a 401 records a row with no user; a
403 from `require_write_access` records the user *and* the forbidden-detail
string; a 422 records the field path and message in `outcome_detail`; a
successful login records the user it logged in.

---

# Task 3: Read API

**A. State of the world.** Tasks 1, 2a and 2b are complete: rows are being
written with user, body and outcome detail. Nothing reads them yet.

**B. Files and deliverables.**

- `backend/app/api/schemas/audit.py` (new) — `AuditLogEntryOut`,
  `AuditLogListOut`.
- `backend/app/api/schemas/__init__.py` — re-export.
- `backend/app/api/routers/audit.py` (new) — `GET /audit`.
- `backend/app/api/main.py` — register the router.
- `backend/tests/test_api/test_audit_api.py` (new).

**C. Instructions.**

`AuditLogEntryOut` mirrors the model column for column
(`model_config = {"from_attributes": True}`). `AuditLogListOut` is
`{items: list[AuditLogEntryOut], total: int}`.

`GET /audit` query parameters, all optional except the paging pair:

| Param | Type | Notes |
|---|---|---|
| `limit` | int, default 50, `ge=1`, `le=200` | |
| `offset` | int, default 0, `ge=0` | |
| `user_id` | int | |
| `path_contains` | str | `AuditLogEntry.path.contains(v, autoescape=True)` — **`autoescape` is required**, see Design Decision 6 |
| `method` | str | uppercased before comparison |
| `status_min` / `status_max` | int | inclusive range |
| `since` / `until` | datetime | inclusive range on `at` |

Build one filter list, apply it to both the `select` and a
`select(func.count())`, so the count always matches the filtered set. Order by
`at DESC, id DESC` — the `id` tiebreak is required for stable paging, see
Design Decision 11.

Gating: `dependencies=[Depends(require_manager)]` on the `APIRouter` itself.
Every endpoint here is manager-only regardless of method, so unlike `users.py`
there is no per-endpoint exception to carve out. Still register it in
`main.py`'s normal gated loop rather than `_UNGATED`, so the default-deny
property survives if a non-GET is ever added; `require_write_access` and
`require_manager` both depend on `get_current_user`, which FastAPI caches per
request, so this costs no extra query.

Docstring should state that there is no write API for this table at all and
that the only writer is the middleware.

Tests: filters individually and in combination; `total` reflects filters, not
the page; `limit`/`offset` paging returns disjoint stable pages; ordering is
`at DESC, id DESC` with a deliberate timestamp collision; a `%` in
`path_contains` is treated literally; manager gets 200 and admin/nurse both get
403 (this router is method-agnostically manager-only, unlike the rest of the
API where admin can write).

---

# Task 4: Frontend data layer

**A. State of the world.** The backend is complete: `GET /audit` is live,
manager-only, paginated and filtered. The frontend has no knowledge of it.

**B. Files and deliverables.**

- `frontend/src/api/types.ts` — `AuditLogEntry`, `AuditLogList`,
  `AuditLogFilters`.
- `frontend/src/api/audit.ts` (new) — `auditKeys`, `useAuditLog`.
- `frontend/src/api/audit.test.tsx` (new).

**C. Instructions.**

Wire types mirror the Pydantic schemas by hand, per the existing convention in
`types.ts` (`Out` suffixes dropped, enums mirrored by value). Note the naming:
the list wrapper is **`AuditLogList`**, not `AuditLogPage` — `AuditLogPage` is
the React component in Task 5 and the collision would be confusing in a file
that imports both. `path_params` and `request_body` are
`Record<string, unknown> | null`.

`useAuditLog(filters: AuditLogFilters)` follows the existing per-resource hook
shape: hierarchical `auditKeys` with the filter object in the key, query string
built with `URLSearchParams` (omitting undefined values) rather than template
concatenation, since this has far more parameters than the existing
`?year=${year}` cases.

Add `placeholderData: keepPreviousData` from `@tanstack/react-query`. Comment
why: this is the first server-paginated list in the app, and without it every
page change flashes an empty table. Write it to be copied.

There are no mutations — the table has no write API.

Tests with MSW covering: the query string is built from the filters; changing
filters produces a new query key; previous data is retained while the next page
loads.

---

# Task 5: Frontend page and nav

**A. State of the world.** Tasks 1–4 are complete: the backend is live and
`useAuditLog` exists. This task is the page and its nav entry.

**B. Files and deliverables.**

- `frontend/src/routes/AuditLogPage.tsx` (new).
- `frontend/src/App.tsx` — one route, one nav item.
- `frontend/src/routes/AuditLogPage.test.tsx` (new).
- `frontend/src/App.test.tsx` — extend.

**C. Instructions.**

`AuditLogPage` reuses `UsersPage`'s no-access pattern verbatim: `useIsManager()`
first, and below manager render a short explanatory block and fire no request.
The route stays registered so a deep link lands somewhere sane. Read
`UsersPage.tsx`'s top-level structure and copy it — the split into an outer
gate component and an inner data component is the pattern.

Page contents: a filter bar (path contains, method, user, status range, date
range), a results table, and prev/next paging showing "x–y of total". Render
`path_params` and `request_body` compactly — a truncated one-line JSON summary
in the row is enough, with the full value available on expand. `request_body`
is the column that makes this page worth having; do not bury it.

The route goes in the clinical `<Routes>` block as
`<Route path="audit" element={<AuditLogPage />} />`, and the nav entry at the
end of `CLINICAL_NAV_ITEMS`:
`{ to: "/clinical/audit", label: "Audit Log", end: false, managerOnly: true }`.
`managerOnly` is currently set on `Users` alone; the comment on the `NavItem`
interface says exactly that and needs updating to say "Users and Audit Log".

Tests: the page renders rows from a mocked response; filters drive the request;
paging works; a non-manager sees the no-access state and fires no request. In
`App.test.tsx`, extend the existing nav-visibility-per-tier coverage — that
file drives the real `App` through `window.history` because it owns its own
`BrowserRouter`.

---

# Task 6: Documentation

**A. State of the world.** Everything is implemented, tested and shipped.

**B. Files and deliverables.**

- `documentation/architecture.md` — updated.
- `documentation/audit_log.md` — deleted.

**C. Instructions.**

The audit log is shared infrastructure across both rota types and signatures,
so it belongs in the hub doc under the Authentication Boundary section, not in
either domain doc. Record:

- the capture mechanism (ASGI middleware, non-GET only, default-audited the
  same way `require_write_access` is default-deny);
- the mutable-context rule, and why `contextvar.set()` from an endpoint is
  invisible;
- that 500s are captured only because the middleware catches and re-raises;
- what is stored from the request body, and the redaction key list;
- the best-effort guarantee — audit failures never fail a request, so entries
  can be lost silently;
- the unbounded-growth property, and that `total` is what degrades first;
- `path` is unindexed on purpose.

Add the audit log to the "first paginated list" note if a frontend-patterns
section exists by then; otherwise a sentence in the API Communication bullet
pointing at `api/audit.ts` as the pagination precedent.

Write the reasoning, not citations — no "audit log plan, Design Decision 7"
references in code comments or docs, per the rule at the end of
`architecture.md`. Then delete this file.
