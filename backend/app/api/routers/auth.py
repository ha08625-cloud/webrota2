"""Auth router: login, logout, me, and the self-service password reset pair.

POST /login is the one endpoint in this router that does NOT depend on
get_current_user -- it is how a client obtains a token in the first place.
Bad email and bad password return the same 401 detail, so a client cannot
enumerate which emails exist by timing or message content. Timing-attack
hardening for the unknown-email case (a constant-time bcrypt comparison
against a dummy hash) is explicitly out of scope for this project: a
plain early return is fine here.

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

POST /forgot-password and POST /reset-password are the self-service reset
pair, and both are unauthenticated by necessity. forgot-password ALWAYS
returns 204 -- unknown address, inactive user, throttled, or a Mailgun
failure alike -- because any other answer would let an unauthenticated
caller enumerate which addresses have accounts, undoing the care login
takes to make its two failure modes identical. The send is deferred to a
BackgroundTask for the same reason and not for speed: a synchronous POST
to Mailgun on the "exists" path would take hundreds of milliseconds
against single-digit ones everywhere else, and that gap is measurable with
a stopwatch. The task runs after the request's DB session has closed, so
it is handed plain strings, never the Session or the User.

reset-password answers 400, never 401, for a bad token. This is
load-bearing: the frontend's API client fires its global onUnauthorized
listener on ANY 401, which would clear the stored token and swap the reset
view for a bare login form at the exact moment the user submitted a stale
link, hiding the message that tells them what to do about it.
"""
import datetime
import logging
import os

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ...models import PasswordResetToken, User, UserSession
from ..auth_utils import (
    hash_password,
    hash_token,
    new_session_token,
    verify_password,
)
from ..deps import (
    EmailSender,
    get_current_user,
    get_db,
    get_email_sender,
    record_audit_actor,
)
from ..schemas import ForgotPasswordIn, LoginIn, LoginOut, ResetPasswordIn, UserOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

_SESSION_LIFETIME = datetime.timedelta(days=30)
_INVALID_CREDENTIALS_DETAIL = "Invalid email or password"

_RESET_TOKEN_LIFETIME = datetime.timedelta(hours=1)

# One reset email per user per 3 minutes. This defends staff INBOXES, and
# needs no table of its own: tokens are deleted only on redemption or
# expiry, so "an unexpired token created less than 3 minutes ago exists"
# is the whole check.
_RESEND_INTERVAL = datetime.timedelta(minutes=3)

# ...and this defends the Mailgun QUOTA, which the per-user throttle does
# not: 3 minutes allows ~20 emails/hour per address, so ~50 staff addresses
# could burn the 3,000/month free tier in an afternoon. Counted across all
# users over the last hour, which is what created_at is indexed for.
_GLOBAL_HOURLY_CAP = 40
_GLOBAL_WINDOW = datetime.timedelta(hours=1)

# Dev-only fallback, so an unconfigured local run still produces a
# clickable link (the Vite dev server, see frontend/vite.config.ts). Every
# deployed environment sets APP_BASE_URL.
_DEFAULT_APP_BASE_URL = "http://localhost:5173"

# One message for every failure mode -- unknown, expired, already redeemed,
# or issued to a user since deactivated. Distinguishing them would tell an
# attacker which of their guesses was a real token.
_INVALID_RESET_DETAIL = (
    "This reset link is invalid or has expired. Please request a new one."
)


def _as_utc(value: datetime.datetime) -> datetime.datetime:
    """SQLite does not round-trip tzinfo on DateTime(timezone=True); every
    value written to these columns is UTC, so reading a naive one back as
    UTC is correct on Postgres too. Same fact get_current_user handles."""
    return value if value.tzinfo is not None else value.replace(
        tzinfo=datetime.timezone.utc
    )


def _reset_url(token: str) -> str:
    """Build the emailed link from APP_BASE_URL -- NEVER from the request.

    Deriving the host from the request would be host-header injection: an
    attacker sends `Host: attacker.example` with a forgot-password request
    for a victim's address, and the victim gets a genuine-looking email
    whose link posts their new password, and the token, to the attacker.
    Read at call time so tests and deploys can set it without an import
    dance.
    """
    base = os.environ.get("APP_BASE_URL", "").strip() or _DEFAULT_APP_BASE_URL
    return f"{base.rstrip('/')}/reset-password/{token}"


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


@router.post("/forgot-password", status_code=204)
def forgot_password(
    body: ForgotPasswordIn,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    send_email: EmailSender = Depends(get_email_sender),
) -> None:
    """Email a reset link, if all the conditions hold. Always 204.

    Every early return below is a decision NOT to send, and each is
    deliberately indistinguishable from a successful send -- see the module
    docstring. No record_audit_actor call: there is no authenticated actor,
    and recording the resolved user would put "this address has an account"
    onto the audit row of the one request that refuses to say so.
    """
    now = datetime.datetime.now(datetime.timezone.utc)

    # Matched exactly and case-sensitively, the way login matches it.
    user = db.execute(
        select(User).where(User.email == body.email)
    ).scalar_one_or_none()
    if user is None or not user.active:
        return

    # Lazily sweep this user's expired tokens rather than running a cron
    # job -- the same idiom login uses for sessions. Done before the
    # throttle check so an expired token cannot throttle a live request.
    db.execute(
        delete(PasswordResetToken).where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.expires_at < now,
        )
    )
    db.commit()

    recent = db.execute(
        select(func.count())
        .select_from(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.created_at > now - _RESEND_INTERVAL,
        )
    ).scalar_one()
    if recent:
        return

    sent_this_hour = db.execute(
        select(func.count())
        .select_from(PasswordResetToken)
        .where(PasswordResetToken.created_at > now - _GLOBAL_WINDOW)
    ).scalar_one()
    if sent_this_hour >= _GLOBAL_HOURLY_CAP:
        # WARNING because this is either an attack or a real outage that
        # has staff hammering the form; either way a human should see it.
        logger.warning(
            "Password reset emails suppressed: %s sent in the last hour "
            "reaches the global cap of %s",
            sent_this_hour,
            _GLOBAL_HOURLY_CAP,
        )
        return

    token = new_session_token()
    db.add(
        PasswordResetToken(
            token_hash=hash_token(token),
            user_id=user.id,
            created_at=now,
            expires_at=now + _RESET_TOKEN_LIFETIME,
        )
    )
    db.commit()

    # Plain values only: this runs after get_db has closed the session.
    background_tasks.add_task(send_email, user.email, user.name, _reset_url(token))


@router.post("/reset-password", status_code=204)
def reset_password(body: ResetPasswordIn, db: Session = Depends(get_db)) -> None:
    """Redeem a reset token and set a new password. 400 on any bad token.

    Redemption deletes every session the user has, matching what a password
    change already does: someone resetting because they suspect compromise
    must get the attacker logged out. It deletes every OTHER outstanding
    reset token too, so a second live link cannot be replayed afterwards.
    """
    now = datetime.datetime.now(datetime.timezone.utc)

    row = db.execute(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == hash_token(body.token)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=400, detail=_INVALID_RESET_DETAIL)

    if _as_utc(row.expires_at) < now:
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail=_INVALID_RESET_DETAIL)

    user = db.get(User, row.user_id)
    # forgot-password declines to email an inactive user; someone
    # deactivated inside the token's hour must not complete the flow
    # either.
    if user is None or not user.active:
        raise HTTPException(status_code=400, detail=_INVALID_RESET_DETAIL)

    user.password_hash = hash_password(body.password)
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    db.execute(
        delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id)
    )
    db.commit()

    # On success only, matching login: a failed attempt has no actor to
    # record, and the middleware already captured the body (with `token`
    # redacted) and the 400 detail.
    record_audit_actor(user)
