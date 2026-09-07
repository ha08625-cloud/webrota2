"""FastAPI dependencies: the DB session and the authorization gates.

`get_current_user` requires `Authorization: Bearer <token>`; the token is
SHA-256 hashed and looked up against `sessions.token_hash`. It 401s -- with
an identical detail string in every case, so a client cannot distinguish
"no such token" from "expired" from "deactivated user". Every router
endpoint requires a valid session; /health, /docs and /openapi.json are
registered directly on the app in main.py and stay open.

A session also carries a permission set (models/permissions.py), and this
module owns the two gates that read it. `access_level` is a label, never a
permission.

`require_access(area)` is a dependency FACTORY. main.py calls it once per
router at include_router time, closing over that router's area; the closure
is the per-request dependency. The factory shape is what makes the lookup
possible: FastAPI wraps each include_router call in an opaque
`_IncludedRouter`, so a running request cannot ask which router served it.
Attaching at registration time is also what makes the API default-DENY --
a new endpoint, and a new router (which cannot be registered until it is
classified in main.py's `_AREA`), is gated the moment it exists. Router-level
`dependencies=` would not do: the levelled areas mix reads and writes in one
router, so the discrimination has to happen inside the dependency, off
request.method.

The two levelled areas (clinical, reception) admit safe methods at `read` or
`write` and everything else at `write` only. The three boolean areas
(signatures, study_eoi, user_admin) admit every method when the flag is true
and nothing when false -- for signatures because reading is the sensitive
part: a scanned signature image is worth more outside this API than in it.

`_SHARED_READ` is the one exception to "the router decides the area", and a
permanent per-endpoint hole in default-deny, so it holds exactly two entries
and each names the caller that needs it. It is per-endpoint because
`GET /doctors/{id}/calendar-feed` stays clinical while `GET /doctors` does
not.

`require_capability(name)` is the per-endpoint gate for a boolean, used in
three places where a router's area gate is not the whole answer:

  routers/users.py       -- the router is UNGATED (PATCH /users/me must stay
                            open to every permission set), so its three
                            admin endpoints gate themselves.
  POST /doctors/{id}/calendar-feed/rotate
  DELETE /reception/staff/{id}
                         -- narrower guards ON TOP of their router's area
                            gate, so the effective rule is the conjunction
                            (clinical:write AND user_admin, reception:write
                            AND user_admin). Both are destructive in ways
                            routine data entry is not.

The gates raise 403, not 404: the resource plainly exists as far as the
caller is concerned, and for levelled areas they can often GET it.

`get_current_user` is also where the acting user reaches the audit log --
it already holds the User row, so the alternative would be a second indexed
SELECT per write request. Identity fields are frozen snapshots, copied in as
plain values. The 401 paths record nothing, correctly: there was no user.
This MUTATES the context object and never calls ContextVar.set(), which
would be invisible from a threadpooled dependency (see api/audit.py).
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

# (method, path) pairs any authenticated login may call, whatever their
# permission set. Both are list endpoints populating a picker in another
# section, and neither payload carries a token or personal data. Paths are as
# `request.scope["route"].path` reports them: the router's own prefix, but
# NOT main.py's /api/v1. A hole in default-deny, so a third entry needs
# justification as specific as these two:
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

# The narrower message for a levelled area the caller can read but not write
# -- a different problem for the person reading the toast.
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
    # SQLite's DateTime(timezone=True) does not round-trip tzinfo, so a row
    # written aware comes back naive and would raise TypeError below rather
    # than 401 cleanly. Everything written to expires_at is UTC, so treating
    # a naive read as UTC is correct on Postgres too, not a SQLite patch.
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
    normal: reads and code outside a request are not audited. Also called by
    POST /auth/login, the one endpoint that resolves a user without
    get_current_user running.
    """
    ctx = current_audit_context()
    if ctx is None:
        return
    ctx.user_id = user.id
    ctx.user_email = user.email
    ctx.user_access_level = user.access_level.value
    # sort_keys so equal permission sets compare equal as strings; `or None`
    # so an empty permission set shows as NULL, not "{}" -- it is a data
    # problem worth seeing.
    ctx.user_permissions = (
        json.dumps(user.permissions, sort_keys=True) if user.permissions else None
    )


def require_access(area: str) -> Callable[..., User]:
    """Build the gate for one permission area. See the module docstring.

    Called once per router at registration time; the returned closure is the
    dependency. `area` is validated here rather than in the closure so a typo
    in main.py's `_AREA` fails at import, not on the first request.

    "Write" means any method outside GET/HEAD/OPTIONS. Exact everywhere bar
    POST /signatures/{doctor_id}/apply, which mutates nothing but is gated as
    a write anyway: producing a signed document is not a read-only action.
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
    listed in the module docstring. It consults neither the method nor
    `_SHARED_READ`: a capability applies to a whole endpoint or not at all.
    """
    if name not in PERMISSION_KEYS or name in AREA_KEYS:
        raise ValueError(f"not a boolean permission: {name!r}")
    denied = _FORBIDDEN_DETAIL[name]

    def dependency(user: User = Depends(get_current_user)) -> User:
        if not (user.permissions or {}).get(name):
            raise HTTPException(status_code=403, detail=denied)
        return user

    return dependency
