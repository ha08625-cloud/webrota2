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
"""
import datetime
import hashlib
from collections.abc import Generator

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import User, UserSession

_UNAUTHORIZED_DETAIL = "Not authenticated"


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
    if session_row.expires_at < now:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)

    user = db.get(User, session_row.user_id)
    if user is None or not user.active:
        raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)

    return user
