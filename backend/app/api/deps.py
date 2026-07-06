"""FastAPI dependencies: DB session and the auth seam.

get_current_user is the M3.5 Task 5 shared-token shim. If the API_TOKEN
env var is set, every router endpoint requires a matching X-API-Token
header (constant-time comparison); if it is unset, the API is open --
this keeps local dev, the test suite, and CI working with no fixture
changes, and makes enabling auth on Railway an env-var change with no
deploy. /health and /docs live outside the routers and stay open.

This is deliberately not real auth (no users, no sessions, no rotation
story): it is a gate on a publicly reachable mutable API until real
auth is built post-project. The env var is read per-request so tests
can monkeypatch it.
"""
import os
import secrets
from collections.abc import Generator

from fastapi import Header, HTTPException
from sqlalchemy.orm import Session

from ..database import SessionLocal


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    x_api_token: str | None = Header(default=None),
) -> dict:
    expected = os.environ.get("API_TOKEN")
    if not expected:
        return {"user": "admin"}
    if x_api_token is None or not secrets.compare_digest(x_api_token, expected):
        raise HTTPException(
            status_code=401, detail="Invalid or missing X-API-Token header"
        )
    return {"user": "admin"}