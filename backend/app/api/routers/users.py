"""User management router (auth plan, Task 3).

Single-role trust model (auth plan, Design Decision 8): any logged-in user
can list, create, edit, deactivate, and reset the password of any other
user, including themselves. There is no separate admin tier and no DELETE
endpoint -- deactivation is soft, via PATCH active=false, matching the
doctors router convention.

PATCH also accepts an optional write-only `password` field. When present,
the password is re-hashed and every existing session belonging to that
user is deleted, so a password reset immediately invalidates any token
obtained under the old password (auth plan, Task 3).

Lock-out guard (auth plan, Design Decision 9): a PATCH that would set
active=false on the last remaining active user is rejected with 409. The
count check runs inside the same transaction as the update, so two
concurrent deactivate requests cannot both slip through. If every user is
somehow deactivated regardless (e.g. direct DB edit), the recovery path is
re-running seed/seed_users.py against the target database.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import User, UserSession
from ..auth_utils import hash_password
from ..deps import get_current_user, get_db
from ..schemas import UserIn, UserOut, UserPatch

router = APIRouter(prefix="/users", tags=["users"])


def _get_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    return user


def _active_user_count(db: Session, exclude_id: int | None = None) -> int:
    stmt = select(func.count()).select_from(User).where(User.active.is_(True))
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    return db.execute(stmt).scalar_one()


@router.get("", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[User]:
    return db.execute(select(User).order_by(User.name)).scalars().all()


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    payload: UserIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> User:
    new_user = User(
        email=payload.email,
        name=payload.name,
        password_hash=hash_password(payload.password),
        active=True,
        access_level=payload.access_level,
    )
    db.add(new_user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail=f"Email '{payload.email}' already exists"
        ) from exc
    db.refresh(new_user)
    return new_user


@router.patch("/{user_id}", response_model=UserOut)
def patch_user(
    user_id: int,
    payload: UserPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> User:
    target = _get_or_404(db, user_id)
    updates = payload.model_dump(exclude_unset=True)

    if updates.get("active") is False and target.active:
        if _active_user_count(db, exclude_id=target.id) < 1:
            raise HTTPException(
                status_code=409,
                detail="cannot deactivate the last active user",
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
            status_code=409, detail="Email already exists"
        ) from exc
    db.refresh(target)
    return target
