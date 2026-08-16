"""Audit capture: the request context, the ASGI middleware, and redaction.

One row per non-GET request that reaches the app, written automatically so
that coverage cannot drift as endpoints are added. The purpose is
debugging -- reconstructing "the rota looks wrong, what happened to it?"
from the sequence of requests that touched it -- so entries are HTTP-shaped
(method, templated route, path params, request body, status) rather than
field-level before/after diffs.

Why middleware rather than per-endpoint calls
---------------------------------------------
There are ~81 non-GET endpoints across 22 routers. Instrumenting them one
by one would be default-OPEN: the next POST anyone adds is unaudited until
somebody remembers the call, and no test catches it. This is the same
argument main.py already makes for attaching require_write_access at
include_router time. It is also why the request body is captured here
rather than by per-endpoint enrichment: 81 hand-written calls would
reintroduce exactly the property this design exists to avoid.

Why pure ASGI rather than BaseHTTPMiddleware
--------------------------------------------
BaseHTTPMiddleware runs the downstream app in a spawned anyio task, which
complicates both contextvar propagation and request-body handling. A plain
`async def __call__(self, scope, receive, send)` avoids both. The status
code is read off the `http.response.start` message via a wrapped `send`,
and `scope["route"]` / `scope["path_params"]` are read AFTER awaiting
downstream, because routing mutates the same scope dict.

`scope["route"]` is set by *FastAPI* (`APIRoute.matches`), not by Starlette
-- so the version risk here is a FastAPI risk. It is read defensively
(`getattr(route, "path", None)`) so a FastAPI upgrade degrades the log
rather than breaking requests. Note also that `route.path` is router-local:
the value for `PATCH /api/v1/rota/12/sessions/45` is
`/rota/{rota_id}/sessions/{session_id}`, because `include_router(prefix=)`
prefixes are not part of it and `scope["root_path"]` is "". `path` carries
the real requested path, prefix included.

THE CONTEXTVAR RULE: MUTATE, NEVER `.set()` FROM AN ENDPOINT
------------------------------------------------------------
Every router in this codebase is `def`, not `async def`, so FastAPI runs
endpoints in a threadpool. anyio's `run_sync_in_worker_thread` executes the
function via `context.run(func)` on a **copy** of the context, which means
a `ContextVar.set()` performed inside an endpoint (or inside a dependency
that runs threadpooled) is **invisible** to this middleware afterwards.

Therefore the middleware calls `.set()` exactly once, with a mutable
`AuditContext`, before calling downstream. Endpoints, dependencies and
exception handlers reach it via `current_audit_context()` and **mutate its
fields**. Mutation is visible because it is the same object; rebinding is
not. Getting this backwards produces a log that silently records nothing
extra, with tests that pass.

Best-effort, never fatal
------------------------
The row is written in its own session and transaction, after the endpoint's
transaction has committed and after the response has been flushed, so it
adds no user-visible latency. Any exception during the write is logged and
swallowed: a database problem loses entries silently, which is far better
than an audit outage taking down rota generation.

A request that 500s still produces a row, but only because the downstream
await is wrapped in `try/except BaseException`. `app.add_middleware` places
this middleware *inside* Starlette's ServerErrorMiddleware but *outside*
its ExceptionMiddleware, so an unhandled endpoint exception propagates up
through here as an exception -- `http.response.start` is never sent and the
wrapped `send` never fires. Without the explicit catch there would be no
row at all.

This module must NOT import `deps` -- `deps` imports it (to record the
acting user from `get_current_user`), and the reverse dependency would be a
circular import. The safe-method set is therefore defined locally rather
than reused from `deps._SAFE_METHODS`.
"""
import contextvars
import datetime
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import anyio.to_thread

logger = logging.getLogger(__name__)

# Defined locally rather than imported from deps -- see module docstring.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Bodies larger than this are replayed downstream normally but stored as a
# marker rather than content.
_MAX_BODY_BYTES = 16 * 1024

_MAX_DETAIL_CHARS = 2000

# Keys whose values are replaced with "[redacted]", matched case-insensitively
# and recursively through dicts and lists. Every password field across
# LoginIn, UserIn, UserPatch and UserSelfPatch is named `password`, so this
# covers the current surface; keep it as the single place a new
# secret-bearing schema registers itself.
#
# Residual leak, stated rather than defended: a user who types their
# password into the email box on the login form puts it in `email`, which is
# not redacted. Bodies are "what was sent", and that includes mistakes.
_REDACTED_KEYS = frozenset({
    "password",
    "new_password",
    "current_password",
    "token",
    "password_hash",
})

_REDACTED = "[redacted]"


@dataclass
class AuditContext:
    """Per-request scratch space for the audit row.

    MUTATE, DO NOT REBIND. The middleware sets this object on the contextvar
    once; everything downstream mutates its fields in place. A
    `ContextVar.set()` from an endpoint is invisible here because endpoints
    run threadpooled on a copied context. See the module docstring.
    """

    method: str
    path: str
    client_ip: str | None = None

    # Filled by the middleware after the downstream call.
    route: str | None = None
    path_params: dict[str, Any] | None = None
    request_body: dict | None = None
    status_code: int | None = None
    duration_ms: int | None = None

    # Filled downstream: get_current_user (identity), the exception handlers
    # and the login endpoint (outcome_detail / identity). See Task 2b.
    user_id: int | None = None
    user_email: str | None = None
    user_access_level: str | None = None
    outcome_detail: str | None = None

    at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )


_audit_context: contextvars.ContextVar[AuditContext | None] = contextvars.ContextVar(
    "audit_context", default=None
)


def current_audit_context() -> AuditContext | None:
    """The current request's audit context, or None if there isn't one
    (a GET, a non-HTTP scope, or code running outside a request)."""
    return _audit_context.get()


# ---------------------------------------------------------------------------
# Session factory
# ---------------------------------------------------------------------------
# Middleware runs outside FastAPI's dependency system, so it cannot use
# `get_db` or benefit from `app.dependency_overrides` -- which is the entire
# reason this module-level indirection exists. main.py points it at
# SessionLocal; the API test suite points it at the per-test engine.
#
# None means DISABLED: the middleware does everything else and skips the
# write. That is the default, so importing this module never writes anywhere
# by accident.
_session_factory: Callable[[], Any] | None = None


def set_session_factory(factory: Callable[[], Any] | None) -> None:
    global _session_factory
    _session_factory = factory


def get_session_factory() -> Callable[[], Any] | None:
    return _session_factory


# ---------------------------------------------------------------------------
# Body handling
# ---------------------------------------------------------------------------


def redact(value: Any) -> Any:
    """Recursively replace values under _REDACTED_KEYS with "[redacted]"."""
    if isinstance(value, dict):
        return {
            k: (_REDACTED if isinstance(k, str) and k.lower() in _REDACTED_KEYS
                else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def parse_body(raw: bytes) -> dict | None:
    """Turn buffered JSON request bytes into the value stored on the row.

    Returns None for an empty body. Oversized and unparseable bodies become
    `{"_audit": ...}` markers rather than content. A JSON body that is not
    an object (a bare list or scalar) is wrapped, because the column is a
    dict.
    """
    if not raw:
        return None
    if len(raw) > _MAX_BODY_BYTES:
        return {"_audit": "body too large", "bytes": len(raw)}
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return {"_audit": "unparsed body"}
    if isinstance(parsed, dict):
        return redact(parsed)
    return {"_audit": "non-object body", "value": redact(parsed)}


async def _drain(receive: Callable) -> tuple[bytes, bool]:
    """Read the whole request body off `receive`.

    Returns (body, disconnected). A `http.disconnect` arriving mid-drain
    ends the read and is reported so the replay can hand it back downstream
    rather than pretending the request was complete.
    """
    chunks: list[bytes] = []
    disconnected = False
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            disconnected = True
            break
        if message["type"] != "http.request":
            continue
        body = message.get("body", b"")
        if body:
            chunks.append(body)
        if not message.get("more_body", False):
            break
    return b"".join(chunks), disconnected


def _replay(body: bytes, disconnected: bool) -> Callable:
    """A `receive` that yields the buffered body once, then disconnects."""
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if disconnected:
            return {"type": "http.disconnect"}
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    return receive


def _client_ip(scope: dict) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"x-forwarded-for":
            first = value.decode("latin-1").split(",")[0].strip()
            if first:
                return first
    client = scope.get("client")
    if client:
        return client[0]
    return None


def _content_type(scope: dict) -> str:
    for name, value in scope.get("headers", []):
        if name == b"content-type":
            return value.decode("latin-1").lower()
    return ""


def _truncate(text: str | None) -> str | None:
    if text is None:
        return None
    return text[:_MAX_DETAIL_CHARS]


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


class AuditMiddleware:
    """Pure ASGI middleware writing one audit row per non-GET request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method", "").upper() in _SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        ctx = AuditContext(
            method=scope["method"].upper(),
            path=scope.get("path", ""),
            client_ip=_client_ip(scope),
        )
        token = _audit_context.set(ctx)
        started = time.monotonic()

        # JSON only. Anything else (notably the two multipart signature
        # document uploads) is passed straight through unbuffered, so it
        # never lands in memory or in the log.
        downstream_receive = receive
        if _content_type(scope).startswith("application/json"):
            raw, disconnected = await _drain(receive)
            ctx.request_body = parse_body(raw)
            downstream_receive = _replay(raw, disconnected)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                ctx.status_code = message["status"]
            await send(message)

        try:
            try:
                await self.app(scope, downstream_receive, send_wrapper)
            except BaseException as exc:
                # See the module docstring: this middleware sits outside
                # ExceptionMiddleware, so an unhandled endpoint exception
                # arrives here as an exception with no response started. A
                # 500 produces no row without this branch.
                ctx.status_code = 500
                if ctx.outcome_detail is None:
                    ctx.outcome_detail = _truncate(f"{type(exc).__name__}: {exc}")
                await self._finish(ctx, scope, started)
                raise

            await self._finish(ctx, scope, started)
        finally:
            _audit_context.reset(token)

    async def _finish(self, ctx: AuditContext, scope: dict, started: float) -> None:
        ctx.duration_ms = int((time.monotonic() - started) * 1000)

        # Routing mutates the same scope dict, so these are only meaningful
        # once the downstream call has returned. `route` is set by FastAPI,
        # not Starlette, and is read defensively so a FastAPI upgrade
        # degrades the log rather than breaking requests. It is absent for a
        # request that matched no route.
        route = scope.get("route")
        ctx.route = getattr(route, "path", None)
        path_params = scope.get("path_params")
        ctx.path_params = dict(path_params) if path_params else None

        # The session is synchronous, so the write goes to a worker thread
        # rather than blocking the event loop. The response has already been
        # flushed by this point either way, so this costs the client nothing.
        await anyio.to_thread.run_sync(self._write, ctx)

    def _write(self, ctx: AuditContext) -> None:
        factory = _session_factory
        if factory is None:
            return
        try:
            # Imported here rather than at module scope: app.models imports
            # a good deal of the ORM layer, and this module is imported by
            # deps.py.
            from ..models import AuditLogEntry

            db = factory()
            try:
                db.add(AuditLogEntry(
                    at=ctx.at,
                    user_id=ctx.user_id,
                    user_email=ctx.user_email,
                    user_access_level=ctx.user_access_level,
                    method=ctx.method,
                    route=ctx.route,
                    path=ctx.path,
                    path_params=ctx.path_params,
                    request_body=ctx.request_body,
                    status_code=ctx.status_code if ctx.status_code is not None else 0,
                    outcome_detail=_truncate(ctx.outcome_detail),
                    duration_ms=ctx.duration_ms,
                    client_ip=ctx.client_ip,
                ))
                db.commit()
            finally:
                db.close()
        except Exception:  # noqa: BLE001 -- audit failures never fail requests
            logger.exception("Failed to write audit log entry for %s %s",
                             ctx.method, ctx.path)
