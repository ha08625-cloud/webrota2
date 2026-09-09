"""User management router, gated by the permission set.

`user_admin`-only, with one exception. `GET /users`, `POST /users`, and
`PATCH /users/{user_id}` each carry
`Depends(require_capability("user_admin"))`: creating users, editing them,
changing anyone's permissions, and reading the user list are all user
administration. The exception is `PATCH /users/me`, which every login can
call on their own row.

This router is one of the three in main.py's `_UNGATED` tuple -- it takes
no area gate at registration time, because any such gate would 403 a
documents-only or reception-only login on `PATCH /users/me`, and that
endpoint exists precisely so they can change their own password. So the
gating here is per-endpoint, and a new endpoint added to this file is
UNGATED until someone adds a dependency. That is the opposite of the
default-deny property everywhere else in the API; it is contained to this
one file deliberately, and the route sweep in
tests/test_api/test_authorization.py will not catch a mistake here. Add
`Depends(require_capability("user_admin"))` when you add an endpoint.

`PATCH /users/me` is declared ABOVE `PATCH /{user_id}` so the literal path
wins the match -- Starlette matches routes in registration order, and
`/{user_id}` would otherwise swallow `/me` and 422 on the int coercion. Its
body (`UserSelfPatch`) accepts `name` and `password` only; `email`,
`active`, `access_level` and `permissions` are not settable there, so it
cannot be used for self-promotion.

PATCH also accepts an optional write-only `password` field. When present,
the password is re-hashed and every existing session belonging to that
user is deleted, so a password reset immediately invalidates any token
obtained under the old password. It also deletes that
user's outstanding self-service reset tokens -- see
_invalidate_reset_tokens for why that is not optional. This applies to
`/users/me` too: changing your own password signs you out everywhere,
including the request's own session, so the very next call 401s. That is
the correct behaviour for a password change, and the frontend handles the
401 by sending the user back to the login screen.

Permissions: `permissions` (models/permissions.py) is settable on POST
and on `PATCH /{user_id}`, and never on `PATCH /users/me`. It arrives as a
validated `PermissionSet` and is stored as a plain dict -- `model_dump()`
on the outer payload converts the nested model recursively, so the value
`setattr` sees below is JSON-serialisable. Handing the column a Pydantic
object instead would fail at commit, so a test pins the round trip. The
empty set is refused by the schema, not here (see schemas/auth.py).

`permissions` is what the API authorizes off, everywhere (see api/deps.py).
`access_level` survives beside it as a label and is not consulted by any
gate, here or elsewhere.

Staff links: `doctor_id` and `reception_staff_id` (models/user.py) are
settable on POST and on `PATCH /{user_id}`, both `user_admin`-only, and never on
`PATCH /users/me` -- linking yourself to a rota identity is self-promotion
of exactly the kind UserSelfPatch's omitted fields exist to prevent. Both
ids are validated by _validate_staff_links BEFORE any mutation: sending an
id that does not exist is a 404 and one already claimed by another user is
a 409, rather than an IntegrityError surfacing from the commit as the
409 "Email already exists" this file used to raise for every integrity
failure. Sending an explicit null clears a link; omitting the key leaves it
alone, because model_dump(exclude_unset=True) distinguishes the two.

Lock-out guard: a PATCH that would leave zero active USER ADMINISTRATORS
is rejected with 409. There are two ways to get there and both are guarded
-- deactivating the last one, and clearing their `user_admin` permission.
Guarding only the first would leave an identical lock-out reachable with a
one-field PATCH. It guards `user_admin` rather than the MANAGER tier
because `user_admin` is now the permission that grants access to this
router: guarding the label would protect nothing real. The count check runs
inside the same transaction as the update, so two concurrent requests
cannot both slip through, and it is the one place the permissions column is
queried across users rather than read whole. If every administrator is
somehow deactivated regardless (e.g. a direct DB edit), the recovery path
is re-running seed/seed_users.py against the target database.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    Doctor,
    PasswordResetToken,
    ReceptionStaff,
    User,
    UserSession,
)
from ..auth_utils import hash_password
from ..deps import get_current_user, get_db, require_capability
from ..schemas import UserIn, UserOut, UserPatch, UserSelfPatch

router = APIRouter(prefix="/users", tags=["users"])


def _get_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    return user


# field on User -> (staff model, human name for the error messages)
_STAFF_LINKS = {
    "doctor_id": (Doctor, "Doctor"),
    "reception_staff_id": (ReceptionStaff, "Reception staff"),
}


def _validate_staff_links(
    db: Session, updates: dict, exclude_user_id: int | None = None
) -> None:
    """404 on an unknown staff id, 409 on one another user already holds.

    Runs before the mutation in both create and patch. Without it a bad id
    reaches the database and comes back as an IntegrityError, which this
    file's handler would report as an email conflict. The unique indexes on
    both columns remain the real guarantee -- this is the readable error in
    front of them, not a replacement for them.

    `exclude_user_id` is the row being patched, so re-saving a form that
    did not change the link is not a conflict with itself.
    """
    for field, (model, label) in _STAFF_LINKS.items():
        staff_id = updates.get(field)
        if staff_id is None:  # absent, or an explicit null that clears it
            continue
        if db.get(model, staff_id) is None:
            raise HTTPException(
                status_code=404, detail=f"{label} {staff_id} not found"
            )
        stmt = select(func.count()).select_from(User).where(
            getattr(User, field) == staff_id
        )
        if exclude_user_id is not None:
            stmt = stmt.where(User.id != exclude_user_id)
        if db.execute(stmt).scalar_one() > 0:
            raise HTTPException(
                status_code=409,
                detail=f"{label} {staff_id} is already linked to another user",
            )


def _active_user_admin_count(db: Session, exclude_id: int | None = None) -> int:
    """Active logins holding `user_admin`. The lock-out guard's counter.

    `User.permissions["user_admin"].as_boolean()` is dialect-neutral:
    SQLAlchemy renders it as `JSON_EXTRACT(users.permissions, '$."user_admin"')`
    on SQLite and `permissions ->> 'user_admin'` on Postgres, each cast to
    the backend's boolean. A row missing the key extracts as NULL and so
    does not count, which is the safe direction -- the guard over-fires
    rather than letting the last administrator go.
    """
    stmt = (
        select(func.count())
        .select_from(User)
        .where(
            User.active.is_(True),
            User.permissions["user_admin"].as_boolean(),
        )
    )
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    return db.execute(stmt).scalar_one()


@router.get("", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    user: User = Depends(require_capability("user_admin")),
) -> list[User]:
    return db.execute(select(User).order_by(User.name)).scalars().all()


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    payload: UserIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_capability("user_admin")),
) -> User:
    _validate_staff_links(db, payload.model_dump(exclude_unset=True))
    new_user = User(
        email=payload.email,
        name=payload.name,
        password_hash=hash_password(payload.password),
        active=True,
        access_level=payload.access_level,
        permissions=payload.permissions.model_dump(),
        doctor_id=payload.doctor_id,
        reception_staff_id=payload.reception_staff_id,
    )
    db.add(new_user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"Email '{payload.email}' already exists, or a staff link "
                "was claimed by another user"
            ),
        ) from exc
    db.refresh(new_user)
    return new_user


def _invalidate_reset_tokens(db: Session, user_id: int) -> None:
    """Drop any outstanding self-service reset tokens for this user.

    Called wherever a password changes, on the same condition as the
    session delete beside it. Without this, an attacker who requested a
    reset for an account keeps a live token for up to an hour AFTER the
    account holder or an admin changes the password -- so the very action
    taken to lock them out would leave them a way back in.
    """
    db.execute(
        delete(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
    )


@router.patch("/me", response_model=UserOut)
def patch_me(
    payload: UserSelfPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> User:
    """Self-service name/password change, open to every permission set.

    Declared before PATCH /{user_id} so the literal path wins. No lock-out
    guard is needed: neither `active` nor `permissions` is settable here,
    so nothing this endpoint can do removes an active user administrator.
    """
    target = _get_or_404(db, user.id)
    updates = payload.model_dump(exclude_unset=True)

    new_password = updates.pop("password", None)

    for field, value in updates.items():
        setattr(target, field, value)

    if new_password is not None:
        target.password_hash = hash_password(new_password)
        db.execute(delete(UserSession).where(UserSession.user_id == target.id))
        _invalidate_reset_tokens(db, target.id)

    db.commit()
    db.refresh(target)
    return target


@router.patch("/{user_id}", response_model=UserOut)
def patch_user(
    user_id: int,
    payload: UserPatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_capability("user_admin")),
) -> User:
    target = _get_or_404(db, user_id)
    updates = payload.model_dump(exclude_unset=True)

    _validate_staff_links(db, updates, exclude_user_id=target.id)

    # Lock-out guard, both routes to the same end state. Checked before the
    # mutation and inside this request's transaction.
    is_active_user_admin = target.active and bool(
        (target.permissions or {}).get("user_admin")
    )
    if is_active_user_admin:
        deactivating = updates.get("active") is False
        # `permissions` arrives as a plain dict: model_dump() converts the
        # nested schema recursively.
        demoting = "permissions" in updates and not updates["permissions"].get(
            "user_admin"
        )
        if (deactivating or demoting) and _active_user_admin_count(
            db, exclude_id=target.id
        ) < 1:
            raise HTTPException(
                status_code=409,
                detail="cannot remove the last active user administrator",
            )

    reset_password = "password" in updates
    new_password = updates.pop("password", None)

    for field, value in updates.items():
        setattr(target, field, value)

    if reset_password:
        target.password_hash = hash_password(new_password)
        db.execute(delete(UserSession).where(UserSession.user_id == target.id))
        _invalidate_reset_tokens(db, target.id)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                "Email already exists, or a staff link was claimed by "
                "another user"
            ),
        ) from exc
    db.refresh(target)
    return target
