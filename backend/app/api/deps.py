"""FastAPI dependencies: DB session and the auth seam.

get_current_user is a deliberate stub (per the roadmap's deferred-auth
decision): every router depends on it, so wiring real authentication later
means changing this one function, not every endpoint.
"""
from collections.abc import Generator

from sqlalchemy.orm import Session

from ..database import SessionLocal


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user() -> dict:
    """Auth seam. Returns a static admin identity until auth is implemented."""
    return {"user": "admin"}
