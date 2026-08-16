"""Auth router: login, logout, me (auth plan, Task 2).

POST /login is the one endpoint in this router that does NOT depend on
get_current_user -- it is how a client obtains a token in the first place.
Bad email and bad password return the same 401 detail, so a client cannot
enumerate which emails exist by timing or message content. Timing-attack
hardening for the unknown-email case (a constant-time bcrypt comparison
against a dummy hash) is explicitly out of scope for this project (auth
plan, Task 2, final bullet): a plain early return is fine here.

Because login does not depend on get_current_user, it is also the one
endpoint that has to put the acting user on its own audit row. It does so
only on success. The failure path needs nothing: the middleware already
captures the request body with `password` redacted and `email` intact, and
the 401 detail, which is everything "the user says they cannot log in"
needs. POST /logout and GET /me both depend on get_current_user and are
recorded there.

POST /logout re-parses the Authorization header itself (rather than
threading the raw token through get_current_user, which returns only the
User) so it can delete exactly the presented session -- not every session
belonging to that user, which would log the user out on every device.
"""
import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ...models import User, UserSession
from ..auth_utils import hash_token, new_session_token, verify_password
from ..deps import get_current_user, get_db, record_audit_actor
from ..schemas import LoginIn, LoginOut, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])

_SESSION_LIFETIME = datetime.timedelta(days=30)
_INVALID_CREDENTIALS_DETAIL = "Invalid email or password"


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, db: Session = Depends(get_db)) -> LoginOut:
    user = db.execute(
        select(User).where(User.email == body.email)
    ).scalar_one_or_none()

    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail=_INVALID_CREDENTIALS_DETAIL)

    if not user.active:
        raise HTTPException(status_code=401, detail=_INVALID_CREDENTIALS_DETAIL)

    # Lazily sweep this user's expired sessions rather than running a cron
    # job.
    now = datetime.datetime.now(datetime.timezone.utc)
    db.execute(
        delete(UserSession).where(
            UserSession.user_id == user.id, UserSession.expires_at < now
        )
    )

    token = new_session_token()
    session_row = UserSession(
        token_hash=hash_token(token),
        user_id=user.id,
        created_at=now,
        expires_at=now + _SESSION_LIFETIME,
    )
    db.add(session_row)
    db.commit()

    # get_current_user did not run here, so the audit row would otherwise
    # have no actor on the one request that identifies a user by name.
    record_audit_actor(user)

    return LoginOut(token=token, user=UserOut.model_validate(user))


@router.post("/logout", status_code=204)
def logout(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    # Header is well-formed at this point -- get_current_user already
    # validated it, so no need to re-check for None / "Bearer " prefix.
    token = authorization.removeprefix("Bearer ").strip()  # type: ignore[union-attr]
    db.execute(delete(UserSession).where(UserSession.token_hash == hash_token(token)))
    db.commit()


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user
