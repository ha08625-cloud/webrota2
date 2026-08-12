"""Shared auth primitives: password hashing and session token handling.

Split out from routers/auth.py so the seed script (seed/seed_users.py) and
the test suite can hash a password or a token identically to the router
without importing FastAPI route code. bcrypt truncates input silently at
72 bytes; the max-length-72 rule is enforced separately, at the Pydantic
schema layer -- these functions do not re-check length themselves.
"""
import hashlib
import secrets

import bcrypt


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def new_session_token() -> str:
    """A fresh opaque bearer token. Returned to the client exactly once."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """SHA-256 hex digest of a bearer token, as stored in sessions.token_hash."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
