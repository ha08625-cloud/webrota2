# Audit Log — Provisional Plan

Status: **provisional**. This is the output of the discussion phase. It needs
review and expansion into an implementation plan before any code is written.

## Plan

Record one row per write request to the API — who made it, which route, which
entity, and what happened — captured automatically by middleware so that
coverage cannot drift as endpoints are added. Surface it as a manager-only,
filterable, paginated page.

The stated purpose is **debugging**: reconstructing "the rota looks wrong —
what happened to it?" from the sequence of requests that touched it. That
drives every decision below, most visibly the choice to make `path` a
substring-searchable column so `/rota/12/` retrieves the whole history of one
rota in one filter.

## Scope

### In

- A new `audit_log` table and Alembic migration `003`.
- ASGI middleware capturing every non-GET request that reaches the app:
  timestamp, user, method, templated route, actual path, path params, status
  code, error detail, duration.
- A hook in `get_current_user` so the acting user is recorded with no extra
  query.
- Enrichment of `POST /auth/login` and `POST /auth/logout`, the only two
  endpoints where the middleware cannot work out who the actor is.
- `GET /audit` — manager-only, paginated, filtered.
- `AuditLogPage` at `/clinical/audit`, manager-only, hidden from nav below
  manager, matching how `Users` already behaves.

### Out

- **Request bodies.** See Design Decision 8 — this is the one scope line worth
  re-examining at review, because it is the one that most limits the log's
  value for the stated debugging purpose.
- **Before/after field diffs.** Would require the SQLAlchemy `before_flush`
  approach, a per-table allowlist, and a story for generation runs writing
  thousands of session rows at once. Several times the work of everything
  else here combined.
- **GET auditing.** The app holds staff scheduling data, not patient data, so
  read auditing would be pure noise. Excluded deliberately, not by oversight.
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
`PATCH /rota/{rota_id}/sessions/{session_id} → 200`, not "moved Dr AB from
room 3 to room 5". Accepted, given the debugging purpose: for reconstructing a
sequence, the route and the entity ids are most of the value.

The rejected third option was SQLAlchemy `before_flush` diffing. It produces
genuinely better entries — real old and new values — but has no notion of
intent, so one rota generation would emit thousands of rows for a single user
action.

### 2. Pure ASGI middleware, not `BaseHTTPMiddleware`

`BaseHTTPMiddleware` runs the downstream app in a spawned anyio task, which
complicates contextvar propagation and request-body handling. A plain
`async def __call__(self, scope, receive, send)` class avoids both. The status
code is captured by wrapping `send` and reading the `http.response.start`
message — about ten lines.

Reading `scope["route"]` and `scope["path_params"]` **after** awaiting the
downstream app gives the templated route and the entity ids, because Starlette
mutates the same `scope` dict during routing. This is version-dependent
behaviour: implement it with a fallback to the raw path and cover it with a
test, so a Starlette upgrade degrades the log rather than breaking requests.

### 3. Enrichment via a mutable context object, never `contextvar.set()`

Every router in this codebase is `def`, not `async def`, so FastAPI runs
endpoints in a threadpool. The context is *copied* into the worker thread,
which means a `contextvar.set()` performed inside an endpoint is **invisible**
to the middleware afterwards.

Therefore: the middleware sets the contextvar **once**, to a mutable dataclass,
before calling downstream. Endpoints and dependencies mutate that object's
fields. Mutation is visible because it is the same object; rebinding is not.

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

### 5. Identity fields are frozen snapshots, and `access_level` is a plain string

`user_email` and `user_access_level` are copied into the row at write time
rather than joined from `users` at read time, so an entry still reads correctly
after a user is renamed or demoted. This copies `RotaGenerationLogEntry`'s
"frozen prose, never re-derived" convention.

`user_access_level` is a `String`, **not** `enum_col(AccessLevel)`. A native
Postgres enum would turn any future tier rename or removal into a migration
against historical rows that are, by definition, meant to be immutable.

`user_id` does get a real FK to `users.id`, unlike `RotaGenerationLogEntry`'s
deliberately FK-free columns: there is no `DELETE /users` endpoint and users
are never hard-deleted, so the FK adds no delete-blocker surface. Nullable, for
requests with no authenticated actor (a failed login).

### 6. Filter by `path` substring, not by JSON query

The key debugging question is "show me everything that touched rota 12".
`path_params` is stored as `sa.JSON` for display, but filtering it would need
`->>` on Postgres and `json_extract` on SQLite — a portability wrinkle in a
codebase that runs SQLite in tests and Postgres in production.

A `path LIKE '%/rota/12/%'` substring filter is portable, needs no extra
columns, and is exactly the query a human debugging an incident wants. Simpler
and better, not simpler and worse.

`sa.JSON` rather than `JSONB` for the same SQLite-parity reason.

### 7. Audit failures never fail the request

The middleware's write happens in its own session, in its own transaction,
after the endpoint's transaction has already committed. Any exception is
caught and logged, never re-raised.

Two consequences worth stating plainly:

- The log is **best-effort**, not guaranteed. A database problem loses entries
  silently. Given the debugging purpose, an audit outage taking down rota
  generation would be the worse failure.
- A request that 500s and rolls back its own transaction still produces an
  audit row recording the 500 — which is precisely what you want when
  debugging.

### 8. Request-level only — and the honest caveat

Per the scope decision, no request bodies are stored. This has one real
benefit: passwords cannot leak into the audit log by construction, so no
redaction logic exists to get wrong.

But it should be said clearly, once: **request-level detail is the weakest fit
for a debugging-first audit log.** Knowing that someone sent
`PATCH /rota/12/sessions/45` and got a 200 does not tell you what the cell was
set *to*. The next question after almost every debugging lookup will be "yes,
but what did they change it to?", and this design cannot answer it.

Storing the validated Pydantic payload as JSON would answer it, and it is a
genuinely small increment: one nullable JSON column, one enrichment call, and a
password-redaction rule for the two auth schemas. The plan is therefore
structured so that this is additive — nothing below needs redesigning to add it
later, and Task 1 should size the table with that column in mind even if it
ships unused.

Recommendation: reconsider this at implementation-plan review. Proceeding as
specified.

### 9. Nothing is pruned

This is the only table in the schema that grows without bound. At this
practice's scale that is tens of thousands of rows a year, which is nothing for
Postgres, and pruning a debugging log is self-defeating the first time you need
last quarter. Index `at` and revisit if it ever becomes a real problem rather
than a theoretical one.

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

## Task Breakdown (sketch — to be expanded at review)

### Task 1: Data model and migration

Files: `backend/app/models/audit.py` (new), `backend/app/models/__init__.py`,
`backend/alembic/versions/003_audit_log.py` (new).

`AuditLogEntry` on table `audit_log`:

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `at` | `DateTime(timezone=True)` | indexed; UTC, aware — note `deps.py`'s warning that SQLite does not round-trip tzinfo |
| `user_id` | int FK `users.id`, nullable | indexed |
| `user_email` | String, nullable | frozen snapshot |
| `user_access_level` | String, nullable | frozen snapshot, deliberately not `enum_col` |
| `method` | String(10) | |
| `route` | String | templated, e.g. `/api/v1/rota/{rota_id}/sessions/{session_id}` |
| `path` | String | actual, indexed — the substring filter target |
| `path_params` | `sa.JSON`, nullable | display only |
| `status_code` | int | indexed |
| `outcome_detail` | Text, nullable | `HTTPException.detail` on non-2xx |
| `duration_ms` | int, nullable | |
| `client_ip` | String, nullable | from `X-Forwarded-For` first, Railway sits behind a proxy |

Deliverable: model, re-export, migration with a working `downgrade()` (the CI
Postgres job runs upgrade/downgrade/upgrade).

### Task 2: Capture — context, middleware, `get_current_user` hook

Files: `backend/app/api/audit.py` (new), `backend/app/api/main.py`,
`backend/app/api/deps.py`.

- `AuditContext` mutable dataclass + module-level `ContextVar`.
- `AuditMiddleware` as pure ASGI: skip safe methods; set the context; await
  downstream wrapping `send` to capture status; read `scope["route"]` /
  `scope["path_params"]` with a raw-path fallback; write the row; swallow all
  exceptions.
- An `HTTPException` handler that records `detail` into the context, so the
  error text is captured without buffering the response stream.
- `_session_factory` module-level indirection with a `set_session_factory()`
  setter, because middleware cannot use `get_db` dependency overrides.
- `get_current_user` mutates the context with the resolved user.
- Register the middleware in `main.py`.

Cross-cutting test-suite hazard: this middleware runs on **every** request in
the existing API suite. `backend/tests/test_api/conftest.py` needs an
**autouse** fixture pointing `_session_factory` at the per-test engine, or the
whole existing suite starts writing audit rows into the developer's real
database. Treat this as part of the task, not follow-up.

### Task 3: Auth endpoint enrichment

Files: `backend/app/api/routers/auth.py`.

The only two endpoints where the middleware cannot determine the actor:
`POST /auth/login` runs before any session exists, and both success and failure
need explicit enrichment (on failure, record the attempted email — "the user
says they can't log in" is a debugging question). `POST /auth/logout` already
has a user via `get_current_user`, so it needs nothing; confirm and move on.

### Task 4: Read API

Files: `backend/app/api/routers/audit.py` (new),
`backend/app/api/schemas/audit.py` (new), `backend/app/api/main.py`.

`GET /audit` with `limit`, `offset`, `user_id`, `path_contains`, `method`,
`status_min`/`status_max`, `since`, `until`; returns `{items, total}`.

Gating: `dependencies=[Depends(require_manager)]` on the `APIRouter` itself —
every endpoint here is manager-only regardless of method, so unlike
`users.py` there is no per-endpoint exception to carve out. Still register it
in `main.py`'s normal gated loop rather than `_UNGATED`, so the default-deny
property survives if a non-GET is ever added.

### Task 5: Frontend data layer

Files: `frontend/src/api/audit.ts` (new), `frontend/src/api/types.ts`.

`AuditLogEntry` and `AuditLogPage` wire types mirroring the Pydantic schemas,
and a `useAuditLog(filters)` hook with `placeholderData: keepPreviousData`.

### Task 6: Frontend page and nav

Files: `frontend/src/routes/AuditLogPage.tsx` (new), `frontend/src/App.tsx`,
plus tests.

Manager-only page reusing `UsersPage`'s no-access pattern verbatim (the route
stays registered so a deep link lands somewhere sane, and fires no request).
Filter bar, table, prev/next paging. One nav entry in `CLINICAL_NAV_ITEMS` with
`managerOnly: true`; `App.test.tsx` covers nav visibility per tier.

### Task 7: Documentation

Files: `documentation/architecture.md`.

The audit log is shared infrastructure across both rota types, so it belongs in
the hub doc under the Authentication Boundary section, not in either domain
doc. Record the capture mechanism, the mutable-context rule, the best-effort
guarantee, and the unbounded-growth property. Delete this plan file once the
work ships.
