"""User management router (auth plan, Task 3; gated by role-based auth, Task 2).

Manager-only, with one exception. `GET /users`, `POST /users`, and `PATCH
/users/{user_id}` each carry `Depends(require_manager)`: creating users,
editing them, changing anyone's access level, and reading the user list are
all manager business. The exception is `PATCH /users/me`, which every tier
can call on their own row.

This router is one of the two in main.py's `_UNGATED` tuple -- it does not
take the global `require_write_access` gate, because that gate would 403 a
doctor or nurse on `PATCH /users/me`, and the endpoint exists precisely so
that they can change their own password. So the gating here is
per-endpoint, and a new endpoint added to this file is UNGATED until
someone adds a dependency. That is the opposite of the default-deny
property everywhere else in the API; it is contained to this one file
deliberately, and the route sweep in tests/test_api/test_authorization.py
will not catch a mistake here. Add `Depends(require_manager)` when you add
an endpoint.

`PATCH /users/me` is declared ABOVE `PATCH /{user_id}` so the literal path
wins the match -- Starlette matches routes in registration order, and
`/{user_id}` would otherwise swallow `/me` and 422 on the int coercion. Its
body (`UserSelfPatch`) accepts `name` and `password` only; `email`,
`active`, and `access_level` are not settable there, so it cannot be used
for self-promotion.

PATCH also accepts an optional write-only `password` field. When present,
the password is re-hashed and every existing session belonging to that
user is deleted, so a password reset immediately invalidates any token
obtained under the old password (auth plan, Task 3). This applies to
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

As of this commit nothing authorizes off `permissions`; the gates still
read `access_level`. It is persisted, validated and returned so the gate
rework has real data to read.

Staff links: `doctor_id` and `reception_staff_id` (models/user.py) are
settable on POST and on `PATCH /{user_id}`, both manager-only, and never on
`PATCH /users/me` -- linking yourself to a rota identity is self-promotion
of exactly the kind UserSelfPatch's omitted fields exist to prevent. Both
ids are validated by _validate_staff_links BEFORE any mutation: sending an
id that does not exist is a 404 and one already claimed by another user is
a 409, rather than an IntegrityError surfacing from the commit as the
409 "Email already exists" this file used to raise for every integrity
failure. Sending an explicit null clears a link; omitting the key leaves it
alone, because model_dump(exclude_unset=True) distinguishes the two.

Lock-out guard: a PATCH that would leave zero active MANAGERS is
rejected with 409. There are two ways to get there and both are guarded --
deactivating the last active manager, and demoting them off `manager`.
Guarding only the first would leave an identical lock-out reachable with a
one-field PATCH. The count check runs inside the same transaction as the
update, so two concurrent requests cannot both slip through. If every
manager is somehow deactivated regardless (e.g. direct DB edit), the
recovery path is re-running seed/seed_users.py against the target database.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Doctor, ReceptionStaff, User, UserSession
from ...models.enums import AccessLevel
from ..auth_utils import hash_password
from ..deps import get_current_user, get_db, require_manager
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


def _active_manager_count(db: Session, exclude_id: int | None = None) -> int:
    stmt = (
        select(func.count())
        .select_from(User)
        .where(User.active.is_(True), User.access_level == AccessLevel.MANAGER)
    )
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    return db.execute(stmt).scalar_one()


@router.get("", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
) -> list[User]:
    return db.execute(select(User).order_by(User.name)).scalars().all()


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    payload: UserIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
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


@router.patch("/me", response_model=UserOut)
def patch_me(
    payload: UserSelfPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> User:
    """Self-service name/password change, open to every tier.

    Declared before PATCH /{user_id} so the literal path wins. No lock-out
    guard is needed: neither `active` nor `access_level` is settable here,
    so nothing this endpoint can do removes an active manager.
    """
    target = _get_or_404(db, user.id)
    updates = payload.model_dump(exclude_unset=True)

    new_password = updates.pop("password", None)

    for field, value in updates.items():
        setattr(target, field, value)

    if new_password is not None:
        target.password_hash = hash_password(new_password)
        db.execute(delete(UserSession).where(UserSession.user_id == target.id))

    db.commit()
    db.refresh(target)
    return target


@router.patch("/{user_id}", response_model=UserOut)
def patch_user(
    user_id: int,
    payload: UserPatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
) -> User:
    target = _get_or_404(db, user_id)
    updates = payload.model_dump(exclude_unset=True)

    _validate_staff_links(db, updates, exclude_user_id=target.id)

    # Lock-out guard, both routes to the same end state. Checked before the
    # mutation and inside this request's transaction.
    is_active_manager = target.active and target.access_level == AccessLevel.MANAGER
    if is_active_manager:
        deactivating = updates.get("active") is False
        demoting = (
            "access_level" in updates
            and updates["access_level"] != AccessLevel.MANAGER
        )
        if (deactivating or demoting) and _active_manager_count(
            db, exclude_id=target.id
        ) < 1:
            raise HTTPException(
                status_code=409,
                detail="cannot remove the last active manager",
            )

    reset_password = "password" in updates
    new_password = updates.pop("password", None)

    for field, value in updates.items():
        setattr(target, field, value)

    if reset_password:
        target.password_hash = hash_password(new_password)
        db.execute(delete(UserSession).where(UserSession.user_id == target.id))

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
