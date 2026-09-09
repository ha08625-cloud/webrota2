"""Audit capture: the request context, the ASGI middleware, and redaction.

One row per non-GET request, written by middleware rather than per-endpoint
calls so that coverage cannot drift as endpoints are added. Entries are
HTTP-shaped (method, templated route, path params, request body, status)
rather than field-level diffs -- the purpose is reconstructing "what
happened to this rota?" from the requests that touched it.

Pure ASGI, not BaseHTTPMiddleware: the latter runs downstream in a spawned
anyio task, complicating contextvar propagation and body handling. The
status code is read off `http.response.start` via a wrapped `send`;
`scope["route"]` and `scope["path_params"]` are read AFTER awaiting
downstream, because routing mutates the same scope dict.

`scope["route"]` is set by FastAPI (`APIRoute.matches`), not Starlette, and
is read defensively so a FastAPI upgrade degrades the log rather than
breaking requests. `route.path` is router-local -- no `include_router`
prefix -- while `path` carries the full requested path.

THE CONTEXTVAR RULE: MUTATE, NEVER `.set()` FROM AN ENDPOINT
------------------------------------------------------------
Routers here are `def`, so FastAPI runs them threadpooled, and anyio
executes them on a *copy* of the context: a `ContextVar.set()` inside an
endpoint or threadpooled dependency is invisible to this middleware. The
middleware therefore `.set()`s a mutable `AuditContext` once; everything
downstream reaches it via `current_audit_context()` and mutates its fields.
Getting this backwards logs nothing extra, with tests that still pass.

Writes are best-effort: own session and transaction, after the response is
flushed, with every exception logged and swallowed. Losing entries beats an
audit outage taking down rota generation.

A request that 500s still produces a row, but only via the
`try/except BaseException` around the downstream await: `add_middleware`
places this inside Starlette's ServerErrorMiddleware but outside its
ExceptionMiddleware, so an unhandled exception arrives here with
`http.response.start` never sent.

This module must NOT import `deps` -- `deps` imports it, so the reverse
would be circular. Hence the local safe-method set.
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

# Values under these keys become "[redacted]", matched case-insensitively and
# recursively through dicts and lists. The single place a new secret-bearing
# schema registers itself. Note a password typed into the login form's email
# box lands in `email` and is not redacted: bodies are "what was sent".
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

    MUTATE, DO NOT REBIND -- see the contextvar rule in the module docstring.
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

    # Filled downstream by get_current_user (identity), the exception
    # handlers and the login endpoint (outcome_detail / identity).
    user_id: int | None = None
    user_email: str | None = None
    user_access_level: str | None = None
    # Compact JSON of the acting user's permission set; see models/audit.py.
    user_permissions: str | None = None
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
# Middleware runs outside the dependency system, so it can use neither
# `get_db` nor `app.dependency_overrides` -- hence this module-level
# indirection. main.py points it at SessionLocal; tests point it at the
# per-test engine. None means DISABLED (the default), so importing this
# module never writes anywhere by accident.
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
                # This middleware sits outside ExceptionMiddleware, so an
                # unhandled endpoint exception arrives here with no response
                # started. Without this branch a 500 produces no row.
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
        # after the downstream call. `route` is absent for a request that
        # matched no route, hence the defensive read.
        route = scope.get("route")
        ctx.route = getattr(route, "path", None)
        path_params = scope.get("path_params")
        ctx.path_params = dict(path_params) if path_params else None

        # The session is synchronous, so the write goes to a worker thread
        # rather than blocking the event loop. The response is already
        # flushed, so this costs the client nothing.
        await anyio.to_thread.run_sync(self._write, ctx)

    def _write(self, ctx: AuditContext) -> None:
        factory = _session_factory
        if factory is None:
            return
        try:
            # Imported here, not at module scope: app.models pulls in much
            # of the ORM layer and deps.py imports this module.
            from ..models import AuditLogEntry

            db = factory()
            try:
                db.add(AuditLogEntry(
                    at=ctx.at,
                    user_id=ctx.user_id,
                    user_email=ctx.user_email,
                    user_access_level=ctx.user_access_level,
                    user_permissions=ctx.user_permissions,
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
