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

Usage (from backend/), against Railway:
    DATABASE_URL=<DATABASE_PUBLIC_URL> \
    SEED_USER_EMAIL=you@example.com \
    SEED_USER_NAME="Your Name" \
    SEED_USER_PASSWORD=<choose one> \
    uv run python -m seed.seed_users
"""
import datetime
import os

import bcrypt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import User

_REQUIRED_VARS = ("SEED_USER_EMAIL", "SEED_USER_NAME", "SEED_USER_PASSWORD")


def _read_env() -> tuple[str, str, str]:
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
    )


def seed_users(session: Session) -> User | None:
    """Create the first user from env vars. Returns None if a user with
    that email already exists (idempotent no-op), else the new User."""
    email, name, password = _read_env()

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
            print(f"Created user {user.email!r} (id={user.id}).")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
