"""FastAPI app: CORS, router registration, health check, frontend mount.

CORS origins come from CORS_ORIGINS (comma-separated), defaulting to "*" for
development. All routers are registered under /api/v1.

Registration is also where authorization is enforced. Every router except
the three in _UNGATED is included with
`dependencies=[Depends(require_access(_AREA[module]))]`. The area is
resolved HERE because it cannot be resolved per request: FastAPI wraps each
include_router call in an opaque _IncludedRouter, so a running request
cannot ask which router served it. See deps.py for what each area admits.

Gating here rather than per endpoint makes the API default-DENY: a new POST
on an existing router is gated the moment it is written. `_AREA[module]` is
a direct subscript, not `.get()`, for the other half of that property -- a
new router is a KeyError at import until somebody classifies it. The
assertions below catch the reverse, a stale entry for a router that no
longer exists.

AuditMiddleware is registered here for the same reason: one row per non-GET
request that reaches the app, so new endpoints are audited without anyone
remembering a call. Its DB session factory is set here too, since middleware
runs outside the dependency system and cannot use get_db (see api/audit.py).
The rows are read back through the audit router, gated in the normal loop
under `user_admin`.

The two exception handlers enrich that log: without them a 4xx row records
the status and nothing about the reason. Each records into the audit context
and delegates to FastAPI's own handler, so response behaviour is unchanged.

If a built frontend exists (FRONTEND_DIST, defaulting to
<repo root>/frontend/dist) it is mounted at "/" AFTER all API routes, with
an index.html SPA fallback for unknown non-API paths. /api/* 404s stay real
404s, and the mount is skipped entirely when the directory is absent.
"""
import os
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

from ..database import SessionLocal
from .audit import AuditMiddleware, current_audit_context, set_session_factory
from .deps import require_access
from .routers import (
    audit as audit_router,
    auth,
    calendar,
    clinic_types,
    closures,
    counters,
    doctors,
    duty,
    eoi,
    extra_sessions,
    leave,
    leave_entitlement,
    leave_planning,
    master_rota,
    reception_counters,
    reception_leave,
    reception_master,
    reception_rota,
    reception_staff,
    recurring_notes,
    rooms,
    rota,
    school_holidays,
    signatures,
    staging,
    users,
)

app = FastAPI(title="Rota Generator API", version="0.1.0")

_origins = [
    o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False if _origins == ["*"] else True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Neither is CORS-safelisted, so without this the browser hides them
    # cross-origin: the EOI tab needs X-EOI-Unmatched, and the signature
    # flow's filename parsing needs Content-Disposition.
    expose_headers=["Content-Disposition", "X-EOI-Unmatched"],
)

# add_middleware PREPENDS, so registering audit after CORS makes audit the
# OUTER of the two. Deliberate: either order works, but outermost means the
# status recorded is the one actually sent to the client.
app.add_middleware(AuditMiddleware)

# Middleware cannot use the get_db dependency, so the audit session factory
# is set explicitly. Tests override it (see tests/conftest.py).
set_session_factory(SessionLocal)

# Password-reset configuration is checked here, at import time, so a deploy
# that forgot a variable complains in its own startup log rather than
# looking healthy until the day somebody is locked out and the email never
# arrives. It logs and continues -- see routers/auth.py check_config for
# why a missing variable must not take the whole rota offline.
auth.check_config()


# ---------------------------------------------------------------------------
# Audit enrichment: why a 4xx happened
# ---------------------------------------------------------------------------
# Both run inside Starlette's ExceptionMiddleware, itself inside the audit
# middleware and on the same task, so mutating the context object is visible
# to it. Neither truncates -- the middleware does that once, at write time.


@app.exception_handler(HTTPException)
async def audit_http_exception_handler(
    request: Request, exc: HTTPException
) -> Response:
    """Record the detail of an HTTPException, then behave exactly as before.

    Registered against STARLETTE's HTTPException, not FastAPI's subclass:
    registering for the subclass would leave the 401s, 403s and 404s the
    framework itself raises -- every unmatched route included -- with no
    detail recorded.
    """
    ctx = current_audit_context()
    if ctx is not None:
        ctx.outcome_detail = str(exc.detail)
    return await http_exception_handler(request, exc)


@app.exception_handler(RequestValidationError)
async def audit_validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> Response:
    """Record which field failed validation and why (the 422 case).

    Separate because an HTTPException handler never sees a
    RequestValidationError. Rendered as text, not JSON: `exc.errors()` can
    carry non-serialisable exception objects in its `ctx` entries.
    """
    ctx = current_audit_context()
    if ctx is not None:
        ctx.outcome_detail = "; ".join(
            f"{'.'.join(str(p) for p in error.get('loc', ()))}: {error.get('msg', '')}"
            for error in exc.errors()
        )
    return await request_validation_exception_handler(request, exc)


API_PREFIX = "/api/v1"

_ALL_ROUTERS = (auth, rota, clinic_types, doctors, leave, leave_entitlement, leave_planning, extra_sessions, duty, rooms, counters, master_rota, staging, closures, school_holidays, signatures, users, recurring_notes, reception_staff, reception_master, reception_rota, reception_leave, reception_counters, audit_router, calendar, eoi)

# The ONLY three routers that do not get a permission gate. Do not
# extend this without a reason as specific as these:
#   auth  -- POST /auth/login has no authenticated user by definition, and
#            POST /auth/logout must stay reachable by every login.
#   users -- gates itself per-endpoint (Depends(require_capability(
#            "user_admin")) on the three admin endpoints), because PATCH
#            /users/me is a write every login must be able to make on
#            their own row.
#   calendar -- Google/Outlook fetch the per-doctor .ics feed with no way to
#            present a bearer token, so its single GET must be reachable
#            unauthenticated; the path token is the credential. _UNGATED
#            rather than _SHARED_READ because the gate depends on
#            get_current_user and so 401s even a GET. The router must never
#            gain a non-GET endpoint -- test_authorization.py enforces both
#            halves. See routers/calendar.py.
_UNGATED = (auth, users, calendar)

# Router -> permission area, the one place a router's section is recorded.
# Every gated router appears exactly once. Only the last three are judgement
# calls: signatures (see models/permissions.py), eoi (the study EOI autofill
# tool), and audit -- reading who did what is user-administration business,
# and `user_admin` being a boolean is what gates its GETs too.
_AREA = {
    rota: "clinical",
    clinic_types: "clinical",
    doctors: "clinical",
    leave: "clinical",
    leave_entitlement: "clinical",
    leave_planning: "clinical",
    extra_sessions: "clinical",
    duty: "clinical",
    rooms: "clinical",
    counters: "clinical",
    master_rota: "clinical",
    staging: "clinical",
    closures: "clinical",
    school_holidays: "clinical",
    recurring_notes: "clinical",
    reception_staff: "reception",
    reception_master: "reception",
    reception_rota: "reception",
    reception_leave: "reception",
    reception_counters: "reception",
    signatures: "signatures",
    eoi: "study_eoi",
    audit_router: "user_admin",
}

# The KeyError in the loop below catches an unclassified router; these catch
# the reverse, a stale entry reading as coverage it no longer provides.
assert set(_AREA) | set(_UNGATED) == set(_ALL_ROUTERS), (
    "every router must be classified in _AREA or listed in _UNGATED"
)
assert not set(_AREA) & set(_UNGATED), (
    "a router in both _UNGATED and _AREA is ungated -- the loop below reads "
    "_UNGATED first -- so the _AREA entry would read as coverage it does "
    "not provide"
)

for module in _ALL_ROUTERS:
    # _AREA[module], not .get(): an unclassified router fails at import
    # rather than serving an unguarded section.
    dependencies = (
        [] if module in _UNGATED else [Depends(require_access(_AREA[module]))]
    )
    app.include_router(module.router, prefix=API_PREFIX, dependencies=dependencies)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Frontend static serving
# ---------------------------------------------------------------------------

def _is_api_path(path: str) -> bool:
    """True for anything the API owns, so the mount can decline it.

    Segment-aware rather than a bare prefix test: /api and /api/... are the
    API's, /apifoo.js is a static file. Takes the path in either shape --
    with the leading slash as `scope["path"]` carries it, or without as
    StaticFiles hands it to get_response.
    """
    return path.lstrip("/").split("/", 1)[0] == "api"


class SPAStaticFiles(StaticFiles):
    """StaticFiles with an index.html fallback for unknown non-API paths.

    Two guards, and both are needed. `get_response` withholds the SPA
    fallback from /api/* so a mistyped API path gets a real JSON 404
    rather than an HTML page a client cannot parse -- but it only ever
    runs for GET and HEAD, because StaticFiles answers every other method
    405 before calling it. For a static file that 405 is right; for an
    unmatched API path it is not, and it is what an unmatched
    `POST /api/v1/...` used to return once a dist was mounted, in
    production but never in CI, which never builds one.

    So `__call__` declines /api/* outright, before the method check, and
    lets the 404 propagate to the app's exception handlers -- the same
    answer an unmatched API path gets when no frontend is mounted at all,
    audit row included. The `get_response` guard stays as the backstop for
    the GET path: it works off the relative path StaticFiles resolved
    rather than off the raw scope, so it still holds if a future mount
    prefix or root_path changes the shape of `scope["path"]`.
    """

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and _is_api_path(scope.get("path", "")):
            raise HTTPException(status_code=404, detail="Not Found")
        await super().__call__(scope, receive, send)

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404 and not _is_api_path(path):
                return await super().get_response("index.html", scope)
            raise


def _default_dist() -> Path:
    # backend/app/api/main.py -> parents[3] is the repo root.
    return Path(__file__).resolve().parents[3] / "frontend" / "dist"


def mount_frontend(application: FastAPI, dist_dir: Path | None = None) -> bool:
    """Mount the built frontend at "/" if dist_dir exists, returning whether
    a mount happened. Mounts match after registered routes, so API routes and
    /health always win. A helper so tests can point it at a temp directory."""
    dist = Path(dist_dir) if dist_dir is not None else Path(
        os.environ.get("FRONTEND_DIST", _default_dist())
    )
    if not dist.is_dir() or not (dist / "index.html").is_file():
        return False
    application.mount("/", SPAStaticFiles(directory=dist, html=True), name="frontend")
    return True


mount_frontend(app)