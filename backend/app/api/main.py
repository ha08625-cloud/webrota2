"""FastAPI app: CORS, router registration, health check, frontend mount.

CORS origins come from the CORS_ORIGINS env var (comma-separated); default is
"*" for development. All routers are registered under /api/v1.

Router registration is also where authorization is enforced (fine-grained
permissions plan, D5). Every router except the three in _UNGATED is
included with `dependencies=[Depends(require_access(_AREA[module]))]` --
the gate for the permission area that router belongs to. The area is
resolved HERE, at registration time, because there is no way to resolve it
per request: FastAPI wraps each include_router call in an opaque
_IncludedRouter, so a running request cannot ask which router served it.
See deps.py for what each area admits.

Attaching the gate here rather than per-endpoint is what makes the API
default-DENY: a new POST on an existing router is gated the moment it is
written, without anyone having to remember a dependency. `_AREA[module]`
is a direct subscript rather than a `.get()` for the other half of that
property -- a new router is a KeyError at import until somebody classifies
it, so the app fails to start rather than serving an unguarded section.
The assertion below covers the reverse mistake, a stale entry for a router
that no longer exists. Adding a router to _UNGATED is the only way to opt
out, and doing so needs a reason as specific as the three already there.

Audit capture is registered the same way and for the same reason. The
AuditMiddleware writes one row per non-GET request that reaches the app, so
a new router -- or a new POST on an existing one -- is audited the moment it
exists, with nobody having to remember a call. Registering it here is also
where its database session factory is set: middleware runs outside the
dependency system and cannot use get_db, so app.api.audit holds a
module-level factory that defaults to None (disabled) and is pointed at
SessionLocal explicitly below. See app/api/audit.py.

The rows are read back through the audit router, which is registered in the
normal gated loop like everything else, in the `user_admin` area: that
permission is a boolean, so the gate covers its reads as well as any
non-GET added to it later.

The two exception handlers below exist for the same log: without them a 4xx
row records the status and nothing about the reason, and "my edit was
rejected and I don't know why" is exactly the question the log is meant to
answer. Each records into the audit context and then delegates to FastAPI's
own handler, so response behaviour is unchanged.

If a built frontend exists (FRONTEND_DIST env var, defaulting
to <repo root>/frontend/dist), it is mounted at "/" AFTER all API routes,
so /api/v1/* and /health always win. The mount serves index.html as an SPA
fallback for unknown non-API paths (client-side routes survive a refresh)
but lets /api/* 404s stay real 404s. Guarded by directory existence: until
M4 produces a build, the backend runs exactly as before.
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
    # Both are read by the frontend off a download response, and neither is
    # a CORS-safelisted response header, so without this the browser hides
    # them cross-origin. X-EOI-Unmatched is what the EOI tab needs; listing
    # Content-Disposition also fixes a pre-existing bug in the signature
    # flow, whose filename parsing silently fell back to a client-side
    # guess whenever the frontend was served from a different origin than
    # the API.
    expose_headers=["Content-Disposition", "X-EOI-Unmatched"],
)

# add_middleware PREPENDS, so registering audit after CORS makes the audit
# middleware the OUTER of the two -- it wraps CORS rather than sitting
# inside it. Deliberate: either order works (preflight OPTIONS is a safe
# method and skipped regardless), and being outermost means the status code
# recorded is the one actually sent to the client.
app.add_middleware(AuditMiddleware)

# Middleware cannot use the get_db dependency, so the audit session factory
# is set explicitly. Tests override it (see tests/conftest.py).
set_session_factory(SessionLocal)


# ---------------------------------------------------------------------------
# Audit enrichment: why a 4xx happened
# ---------------------------------------------------------------------------
# Both handlers run inside Starlette's ExceptionMiddleware, which is inside
# the audit middleware and on the same task, so mutating the context object
# is visible to it. Neither truncates: the middleware truncates
# outcome_detail once, at write time, which keeps the limit in one place.


@app.exception_handler(HTTPException)
async def audit_http_exception_handler(
    request: Request, exc: HTTPException
) -> Response:
    """Record the detail of an HTTPException, then behave exactly as before.

    Registered against STARLETTE's HTTPException, not FastAPI's: FastAPI
    registers its own default handler under the Starlette class, and its
    subclass is what endpoints raise. Registering for the subclass would
    leave the 401s, 403s and 404s that the framework itself raises --
    including every unmatched route -- with no detail recorded.
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

    A separate handler because an HTTPException handler never sees a
    RequestValidationError. The errors are rendered as text rather than
    stored as JSON: `exc.errors()` can carry non-serialisable exception
    objects in its `ctx` entries.
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
#   calendar -- the per-doctor .ics feed is fetched by Google/Outlook with
#            no way to present a bearer token, so its single GET must be
#            reachable unauthenticated; the token in the path is the
#            credential. It is in _UNGATED rather than listed as a shared
#            read because the gate depends on get_current_user and so 401s
#            even a GET. The router holds exactly one endpoint and must
#            never gain a non-GET one -- test_authorization.py's sweeps
#            enforce both halves. See routers/calendar.py.
# Everything else is classified below. See routers/users.py and deps.py.
_UNGATED = (auth, users, calendar)

# Router -> permission area. Every gated router appears here exactly once;
# the section a router belongs to is a property of the router, so this is
# the one place it is written down. Nothing here is a judgement call except
# the last three, which are one router each:
#   signatures -- the whole point of the feature; see models/permissions.py
#   eoi        -- the study EOI autofill tool, `study_eoi`
#   audit      -- reading who did what is user-administration business, and
#                 `user_admin` being a boolean is what gates its GETs too
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

# The KeyError in the loop below catches a new router nobody classified;
# this catches the reverse, a stale entry for a router that was deleted or
# renamed, which would otherwise sit here reading as coverage it no longer
# provides.
assert set(_AREA) | set(_UNGATED) == set(_ALL_ROUTERS), (
    "every router must be classified in _AREA or listed in _UNGATED"
)
assert not set(_AREA) & set(_UNGATED), (
    "a router in both _UNGATED and _AREA is ungated -- the loop below reads "
    "_UNGATED first -- so the _AREA entry would read as coverage it does "
    "not provide"
)

for module in _ALL_ROUTERS:
    # _AREA[module], not .get(): an unclassified router is an ImportError
    # here rather than an unguarded section at runtime.
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

class SPAStaticFiles(StaticFiles):
    """StaticFiles with an index.html fallback for unknown non-API paths."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404 and not path.startswith("api"):
                return await super().get_response("index.html", scope)
            raise


def _default_dist() -> Path:
    # backend/app/api/main.py -> parents[3] is the repo root.
    return Path(__file__).resolve().parents[3] / "frontend" / "dist"


def mount_frontend(application: FastAPI, dist_dir: Path | None = None) -> bool:
    """Mount the built frontend at "/" if dist_dir exists. Returns whether
    a mount happened. Mounts are matched after registered routes, so the
    API routes and /health always take precedence. Split out as a helper
    so tests can exercise it against a temp directory."""
    dist = Path(dist_dir) if dist_dir is not None else Path(
        os.environ.get("FRONTEND_DIST", _default_dist())
    )
    if not dist.is_dir() or not (dist / "index.html").is_file():
        return False
    application.mount("/", SPAStaticFiles(directory=dist, html=True), name="frontend")
    return True


mount_frontend(app)