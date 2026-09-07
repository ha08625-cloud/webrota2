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

Authentication is not the whole story: a valid session also carries a
permission set (models/permissions.py), and this module owns the two gates
that read it. Nothing here consults `access_level` any more -- it is a
label, not a permission (fine-grained permissions plan, D4).

`require_access(area)` is a dependency FACTORY, not a dependency. It is
called once per router in main.py's include_router loop, closing over the
area that router belongs to, and the closure it returns is what runs per
request. The factory shape is what makes the area lookup possible at all:
the dependency receives a `Request`, and there is no router-module handle
at request time -- FastAPI wraps each `include_router` call in an opaque
`_IncludedRouter`, so `app.routes` yields exactly one `APIRoute`
(`/health`) and a request cannot ask "which router served me?".

Attaching it at registration time, rather than per endpoint, is what makes
the API default-DENY. With ~40 GET paths and ~83 non-GET operations across
23 gated routers, a per-endpoint dependency would be default-OPEN: the next
endpoint anyone adds would be reachable by every login until somebody
remembered the decorator, and no test would catch it. Registration-time
attachment means a new endpoint -- and a new router, which cannot be
registered at all until it is classified (see main.py's `_AREA`) -- is
gated the moment it exists.

Router-level `dependencies=` on the APIRouter objects themselves would not
work either: for the two levelled areas every router mixes reads and
writes, so the read/write discrimination has to happen inside the
dependency, off request.method.

The two levelled areas (clinical, reception) admit safe methods at `read`
or `write` and everything else at `write` only. The three boolean areas
(signatures, study_eoi, user_admin) admit every method when the flag is
true and nothing when it is false -- there is no meaningful read-only view
of a document generator or of user administration, and for signatures the
point is precisely that reading is the sensitive part: a scanned signature
image is the one asset in this API worth more outside it than in, so the
people who may read one are exactly the people who may upload one.

`_SHARED_READ` is the one exception to "the router decides the area", and
it is a real cost: it is a permanent, per-endpoint hole in the default-deny
property, so it holds exactly two entries and each carries the caller that
needs it. It has to be per-endpoint rather than per-router because `GET
/doctors/{id}/calendar-feed` stays clinical while `GET /doctors` does not.

`require_capability(name)` is the per-endpoint gate for a boolean, used in
the three places a router's own area gate is not the whole answer:

  routers/users.py       -- the router is UNGATED (PATCH /users/me must
                            stay open to every permission set), so its
                            three admin endpoints gate themselves.
  POST /doctors/{id}/calendar-feed/rotate
  DELETE /reception/staff/{id}
                         -- both keep a narrower guard ON TOP of their
                            router's area gate, so the effective rule is
                            the conjunction (clinical:write AND user_admin,
                            reception:write AND user_admin). Mapping either
                            to plain area:write would widen it to every
                            rota editor, and both are destructive in ways
                            routine data entry is not. See their docstrings.

The gates raise 403, not 404. The resource plainly exists as far as the
caller is concerned, and for the levelled areas they can often GET it, so
hiding its existence buys nothing; the signature reads follow suit rather
than pretending a doctor with no signature on file is the same as a doctor
whose signature you may not see.

get_current_user is also where the acting user reaches the audit log. It
already holds the User row, so recording the identity here costs nothing --
the alternative, re-resolving the bearer token inside the audit middleware,
would be a second indexed SELECT on every write request. The row's identity
fields are frozen snapshots, so the email, access level and permission set
are copied in as plain values rather than left to be joined at read time. The 401 paths
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
import json
from collections.abc import Callable, Generator

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import User, UserSession
from ..models.permissions import AREA_KEYS, PERMISSION_KEYS, READ, WRITE
from .audit import current_audit_context

_UNAUTHORIZED_DETAIL = "Not authenticated"

# OPTIONS is here for correctness rather than effect: CORSMiddleware answers
# preflight before routing, so an OPTIONS request never reaches a gate.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# (method, path) pairs that ANY authenticated login may call, whatever
# their permission set. Both are list endpoints that populate a picker in a
# section other than their own, and neither payload carries a token or
# personal data (DoctorOut is code/type/sessions/active/dates;
# ReceptionStaffOut is id/code/active). The calendar-feed token lives on a
# different endpoint, which stays clinical.
#
# Paths are as `request.scope["route"].path` reports them, which is the
# route's path WITHOUT main.py's /api/v1 prefix: include_router mounts the
# sub-router, and what lands in the scope is the sub-router's own route.
# The router's own prefix IS included, so these stay unambiguous.
#
# This is a hole in the default-deny property, so it earns its entries one
# at a time -- a third needs the same kind of justification, not a
# convenient import:
_SHARED_READ = frozenset({
    # SignaturesPage's Partner/Salaried picker, and UserFormDialog's
    # linked-doctor picker -- without which a user_admin-only login, the
    # tightly scoped login this feature exists to make possible, cannot
    # create or edit a user.
    ("GET", "/doctors"),
    # UserFormDialog's linked-reception-staff picker, same argument.
    ("GET", "/reception/staff"),
})

_FORBIDDEN_DETAIL = {
    "clinical": "Your permissions do not include the clinical rota",
    "reception": "Your permissions do not include the reception rota",
    "signatures": "Your permissions do not include signatures",
    "study_eoi": "Your permissions do not include the study EOI tool",
    "user_admin": "User management requires the user administration permission",
}

# The narrower message for a levelled area the caller can read but not
# write. Worth distinguishing: "you may not touch this section" and "you
# may look but not change" are different problems for the person reading
# the toast.
_READ_ONLY_DETAIL = {
    "clinical": "Your access to the clinical rota is read-only",
    "reception": "Your access to the reception rota is read-only",
}


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
    # sort_keys so two rows with the same permissions compare equal as
    # strings; `or None` because a row with no permission set at all is a
    # data problem worth seeing as NULL rather than as "{}".
    ctx.user_permissions = (
        json.dumps(user.permissions, sort_keys=True) if user.permissions else None
    )


def require_access(area: str) -> Callable[..., User]:
    """Build the gate for one permission area. See the module docstring.

    Called at registration time, once per router, and the returned closure
    is the actual dependency. `area` is validated here rather than in the
    closure so a typo in main.py's `_AREA` map is an import-time failure
    rather than a 500 on the first request to that router.

    "Write" means "any request whose method is not GET/HEAD/OPTIONS". That
    is a proxy, and it is exact everywhere in this codebase bar one
    endpoint: POST /signatures/{doctor_id}/apply mutates nothing -- it
    splices a stored signature into an uploaded document and returns a PDF.
    It is gated as a write anyway: producing an officially signed document
    is not obviously a read-only action, and every exemption is a permanent
    hole in the default-deny property. (It is moot under the current model
    -- `signatures` is a boolean, so read and write are the same
    permission -- but the argument outlives that.)
    """
    if area not in PERMISSION_KEYS:
        raise ValueError(f"unknown permission area: {area!r}")
    levelled = area in AREA_KEYS
    denied = _FORBIDDEN_DETAIL[area]
    read_only = _READ_ONLY_DETAIL.get(area, denied)

    def dependency(
        request: Request,
        user: User = Depends(get_current_user),
    ) -> User:
        route = request.scope.get("route")
        if (request.method, getattr(route, "path", None)) in _SHARED_READ:
            return user

        granted = (user.permissions or {}).get(area)
        if levelled:
            if granted == WRITE:
                return user
            if granted == READ:
                if request.method in _SAFE_METHODS:
                    return user
                raise HTTPException(status_code=403, detail=read_only)
        elif granted:
            return user
        raise HTTPException(status_code=403, detail=denied)

    return dependency


def require_capability(name: str) -> Callable[..., User]:
    """Build a method-agnostic gate for one boolean permission.

    The per-endpoint counterpart to `require_access`, for the three places
    listed in the module docstring. Unlike `require_access` it never
    consults the method and never consults `_SHARED_READ`: a capability
    either applies to the whole endpoint or does not belong here.
    """
    if name not in PERMISSION_KEYS or name in AREA_KEYS:
        raise ValueError(f"not a boolean permission: {name!r}")
    denied = _FORBIDDEN_DETAIL[name]

    def dependency(user: User = Depends(get_current_user)) -> User:
        if not (user.permissions or {}).get(name):
            raise HTTPException(status_code=403, detail=denied)
        return user

    return dependency
