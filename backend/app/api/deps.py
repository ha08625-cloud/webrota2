"""FastAPI dependencies: DB session and the auth seam.

get_current_user implements real, DB-backed session authentication (auth
plan, Task 2), replacing the M3.5 shared-token shim. A request must present
`Authorization: Bearer <token>`; the token is SHA-256 hashed and looked up
against `sessions.token_hash`. The dependency 401s -- with the same detail
string in every case, so a client cannot distinguish "no such token" from
"expired" from "deactivated user" -- if the header is missing or malformed,
the token has no matching session, the session has expired, or the owning
user is inactive.

There is no fail-open mode any more: the API_TOKEN env var and all
X-API-Token handling have been removed entirely. Every router endpoint
requires a valid session. /health, /docs, and /openapi.json live outside
the routers (registered directly on the app in main.py) and stay open.

Authentication is not the whole story any more: since the role-based auth
plan (Task 2) a valid session also carries a permission tier, and this
module owns the two gates that read it.

`require_write_access` is method-aware and attached ONCE, in main.py's
include_router loop, to every router except auth and users. It is not a
per-endpoint dependency: with ~78 non-GET endpoints across 22 routers,
per-endpoint gating would be default-OPEN -- the next POST anyone adds
would be world-writable until somebody remembered the dependency, and no
test would catch it. Attaching it at inclusion time makes a new router,
and a new endpoint on an existing router, default-DENY for viewers.
Router-level `dependencies=` on the APIRouter objects themselves would
not work either: every router mixes reads and writes, so the
discrimination has to happen inside the dependency, off request.method.

`require_manager` is method-agnostic and applied per-endpoint in
routers/users.py, which cannot take the global gate because PATCH
/users/me has to stay open to every tier.

Reads are open to all four tiers, preserving the pre-existing "everyone
sees everything" behaviour. MANAGER and ADMIN both write; DOCTOR and
NURSE are permission-identical viewer labels.

Both gates raise 403, not 404: the resource plainly exists (the caller
can GET it), so hiding its existence buys nothing.

get_current_user is also where the acting user reaches the audit log. It
already holds the User row, so recording the identity here costs nothing --
the alternative, re-resolving the bearer token inside the audit middleware,
would be a second indexed SELECT on every write request. The row's identity
fields are frozen snapshots, so the email and access level are copied in as
plain values rather than left to be joined at read time. The 401 paths
record nothing, which is correct: there was no user. Note that this mutates
the context object in place and never calls ContextVar.set() -- this
dependency runs threadpooled on a copied context, so a set() here would be
invisible to the middleware (see api/audit.py).

expires_at is normalized to aware UTC before comparison (auth plan, Task 4
bugfix). SQLite's DateTime(timezone=True) does not round-trip tzinfo: a
row written with an aware UTC datetime comes back naive after a fetch,
while Postgres (psycopg2) preserves tz-awareness on TIMESTAMPTZ. Comparing
a naive value against the aware `now` built below raises TypeError rather
than a clean 401. Every value ever written to expires_at is UTC (see
routers/auth.py), so treating a naive read as UTC is correct on both
backends, not just a SQLite workaround.
"""
import datetime
import hashlib
from collections.abc import Generator

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import User, UserSession
from ..models.enums import AccessLevel
from .audit import current_audit_context

_UNAUTHORIZED_DETAIL = "Not authenticated"

# Explicit tier ordering. DOCTOR and NURSE are deliberately equal: they are
# labels, not distinct permission sets. Comparing these ints, rather than
# the enum members, keeps the ordering visible in one place instead of
# implied by declaration order in AccessLevel.
_TIER = {
    AccessLevel.NURSE: 0,
    AccessLevel.DOCTOR: 0,
    AccessLevel.ADMIN: 1,
    AccessLevel.MANAGER: 2,
}
_WRITE_TIER = 1
_MANAGER_TIER = 2

# OPTIONS is here for correctness rather than effect: CORSMiddleware answers
# preflight before routing, so an OPTIONS request never reaches a gate.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

_FORBIDDEN_WRITE_DETAIL = "Your access level does not permit changes"
_FORBIDDEN_MANAGER_DETAIL = "User management requires manager access"


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)

    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

    session_row = db.execute(
        select(UserSession).where(UserSession.token_hash == token_hash)
    ).scalar_one_or_none()

    if session_row is None:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)

    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = session_row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if expires_at < now:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)

    user = db.get(User, session_row.user_id)
    if user is None or not user.active:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)

    record_audit_actor(user)
    return user


def record_audit_actor(user: User) -> None:
    """Copy the acting user onto the current request's audit row.

    MUTATES the context object; see the module docstring. A None context is
    normal, not an error: reads are not audited, and neither is code running
    outside a request. Also called by POST /auth/login, the one endpoint
    that resolves a user without get_current_user running.
    """
    ctx = current_audit_context()
    if ctx is None:
        return
    ctx.user_id = user.id
    ctx.user_email = user.email
    ctx.user_access_level = user.access_level.value


def _tier(user: User) -> int:
    return _TIER.get(user.access_level, 0)


def require_write_access(
    request: Request,
    user: User = Depends(get_current_user),
) -> User:
    """Allow reads for every tier; allow writes for admin and manager only.

    Attached globally in main.py, so "write" here means "any request whose
    method is not GET/HEAD/OPTIONS". That is a proxy, and it is exact
    everywhere in this codebase bar one endpoint: POST
    /signatures/{doctor_id}/apply mutates nothing -- it splices a stored
    signature into an uploaded document and returns a PDF. It is gated as a
    write anyway: producing an officially signed document is not obviously a
    viewer action, and an exemption list is a permanent hole in the
    default-deny property for the sake of one route. If doctors turn out to
    need self-service signed certificates, the fix is an exempt (method,
    path) set checked here -- one line, one place.
    """
    if request.method in _SAFE_METHODS:
        return user
    if _tier(user) < _WRITE_TIER:
        raise HTTPException(status_code=403, detail=_FORBIDDEN_WRITE_DETAIL)
    return user


def require_manager(user: User = Depends(get_current_user)) -> User:
    """Manager-only, regardless of method -- this gates reads too.

    Used by routers/users.py, where even listing users is manager business.
    """
    if _tier(user) < _MANAGER_TIER:
        raise HTTPException(status_code=403, detail=_FORBIDDEN_MANAGER_DETAIL)
    return user
