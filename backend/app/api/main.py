"""FastAPI app: CORS, router registration, health check, frontend mount.

CORS origins come from the CORS_ORIGINS env var (comma-separated); default is
"*" for development. All routers are registered under /api/v1.

Router registration is also where write authorization is enforced
(role-based auth plan, Task 2). Every router except the two in _UNGATED is
included with `dependencies=[Depends(require_write_access)]`, which 403s a
viewer-tier user on any non-GET request. Attaching the gate here rather
than per-endpoint is what makes the API default-DENY: a new router, or a
new POST on an existing router, is gated the moment it is registered,
without anyone having to remember a dependency. Adding a router to
_UNGATED is the only way to opt out, and doing so needs a reason as
specific as the two already there.

If a built frontend exists (FRONTEND_DIST env var, defaulting
to <repo root>/frontend/dist), it is mounted at "/" AFTER all API routes,
so /api/v1/* and /health always win. The mount serves index.html as an SPA
fallback for unknown non-API paths (client-side routes survive a refresh)
but lets /api/* 404s stay real 404s. Guarded by directory existence: until
M4 produces a build, the backend runs exactly as before.
"""
import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

from .deps import require_write_access
from .routers import (
    auth,
    clinic_types,
    closures,
    counters,
    doctors,
    duty,
    extra_sessions,
    leave,
    leave_entitlement,
    leave_planning,
    master_rota,
    reception_coverage,
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
)

API_PREFIX = "/api/v1"

_ALL_ROUTERS = (auth, rota, clinic_types, doctors, leave, leave_entitlement, leave_planning, extra_sessions, duty, rooms, counters, master_rota, staging, closures, school_holidays, signatures, users, recurring_notes, reception_staff, reception_coverage, reception_master, reception_rota, reception_leave)

# The ONLY two routers that do not get the global write gate. Do not extend
# this without a reason as specific as these:
#   auth  -- POST /auth/login has no authenticated user by definition, and
#            POST /auth/logout must stay reachable at every tier.
#   users -- gates itself per-endpoint (Depends(require_manager) on the
#            three admin endpoints), because PATCH /users/me is a write
#            that every tier must be able to make on their own row.
# Everything else is gated. See routers/users.py and deps.py.
_UNGATED = (auth, users)

for module in _ALL_ROUTERS:
    dependencies = [] if module in _UNGATED else [Depends(require_write_access)]
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