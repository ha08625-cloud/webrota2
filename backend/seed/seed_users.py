"""Bootstrap the first user for DB-backed auth (auth plan, Task 1).

Deliberately NOT wired into run_all.py -- this is a one-off, run manually
from a local machine against Railway's public Postgres URL
(DATABASE_PUBLIC_URL), the same way the system was seeded before auth
existed. Running it repeatedly is safe: if a user with the given email
already exists, it prints a message and exits without error rather than
raising or creating a duplicate.

Reads SEED_USER_EMAIL, SEED_USER_NAME, SEED_USER_PASSWORD from the
environment and fails loudly (raises) if any is unset -- there is no
hardcoded fallback credential in this codebase, on purpose.

SEED_USER_ACCESS_LEVEL is optional and defaults to "manager" (role-based
auth plan, Task 1). It is deliberately NOT in _REQUIRED_VARS: this script
exists to bootstrap the account that administers everyone else, and that
account is a manager in essentially every case. It is also the recovery
path for a database with no manager in it -- access_level defaults to
"nurse" at both the model and schema level, so a database populated any
other way has no manager until this script makes one. Defaulting it to
anything lower would defeat the point.

Usage (from backend/), against Railway:
    DATABASE_URL=<DATABASE_PUBLIC_URL> \
    SEED_USER_EMAIL=you@example.com \
    SEED_USER_NAME="Your Name" \
    SEED_USER_PASSWORD=<choose one> \
    SEED_USER_ACCESS_LEVEL=manager \
    uv run python -m seed.seed_users
"""
import datetime
import os

import bcrypt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import User
from app.models.enums import AccessLevel

_REQUIRED_VARS = ("SEED_USER_EMAIL", "SEED_USER_NAME", "SEED_USER_PASSWORD")
_DEFAULT_ACCESS_LEVEL = AccessLevel.MANAGER


def _read_access_level() -> AccessLevel:
    raw = os.environ.get("SEED_USER_ACCESS_LEVEL")
    if not raw:
        return _DEFAULT_ACCESS_LEVEL
    try:
        return AccessLevel(raw)
    except ValueError:
        valid = ", ".join(member.value for member in AccessLevel)
        raise RuntimeError(
            f"SEED_USER_ACCESS_LEVEL={raw!r} is not a valid access level -- "
            f"expected one of: {valid}"
        ) from None


def _read_env() -> tuple[str, str, str, AccessLevel]:
    missing = [v for v in _REQUIRED_VARS if not os.environ.get(v)]
    if missing:
        raise RuntimeError(
            f"missing required env var(s): {', '.join(missing)} -- "
            "seed_users.py has no hardcoded fallback credentials"
        )
    return (
        os.environ["SEED_USER_EMAIL"],
        os.environ["SEED_USER_NAME"],
        os.environ["SEED_USER_PASSWORD"],
        _read_access_level(),
    )


def seed_users(session: Session) -> User | None:
    """Create the first user from env vars. Returns None if a user with
    that email already exists (idempotent no-op), else the new User."""
    email, name, password, access_level = _read_env()

    existing = session.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()
    if existing is not None:
        print(f"User {email!r} already exists (id={existing.id}); nothing to do.")
        return None

    password_hash = bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt()
    ).decode("utf-8")

    user = User(
        email=email,
        name=name,
        password_hash=password_hash,
        active=True,
        access_level=access_level,
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    session.add(user)
    session.flush()
    return user


def main() -> None:
    session = SessionLocal()
    try:
        user = seed_users(session)
        session.commit()
        if user is not None:
            print(
                f"Created user {user.email!r} (id={user.id}, "
                f"access_level={user.access_level.value})."
            )
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
