"""Outbound email, via the Mailgun HTTP API.

One public function, send_password_reset. It is the whole of the module's
surface deliberately: this is not a general mailer, and anything else that
wants to send email should be added here as its own named function rather
than by exposing a generic send().

Why the HTTP API and not SMTP: one authenticated POST, no connection
handling, and no outbound SMTP ports to be blocked on Railway.

Why api.eu.mailgun.net: the account's domain is in Mailgun's EU region.
Posting an EU domain to the US endpoint (api.mailgun.net) returns a 401,
which reads like a bad API key and sends you looking in the wrong place.

MAILGUN_DOMAIN and MAILGUN_FROM are separate variables on purpose. The
sending domain (as listed under Sending > Domains) is not necessarily the
domain part of the From address.

Configuration is read at call time, not import time, so tests can
monkeypatch the environment and so a missing variable is a runtime warning
rather than an import-time explosion.

This function never raises. It is called from a FastAPI BackgroundTask,
after the response has gone out, where an exception has nowhere useful to
go: it would be logged as an unhandled error and the caller would never
learn of it either way. Failures return False and log instead.
"""
from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_API_BASE = "https://api.eu.mailgun.net/v3"
_TIMEOUT_SECONDS = 10.0

_SUBJECT = "Reset your rota password"


def _text_body(name: str, reset_url: str) -> str:
    return (
        f"Hello {name},\n"
        "\n"
        "Someone asked to reset the password for your rota account. To choose "
        "a new password, open this link:\n"
        "\n"
        f"{reset_url}\n"
        "\n"
        "The link works once and expires in one hour.\n"
        "\n"
        "If you did not ask for this, you can ignore this email - your "
        "password has not been changed.\n"
    )


def _html_body(name: str, reset_url: str) -> str:
    return (
        f"<p>Hello {name},</p>"
        "<p>Someone asked to reset the password for your rota account. "
        f'To choose a new password, <a href="{reset_url}">open this link</a>.</p>'
        f'<p><a href="{reset_url}">{reset_url}</a></p>'
        "<p>The link works once and expires in one hour.</p>"
        "<p>If you did not ask for this, you can ignore this email - your "
        "password has not been changed.</p>"
    )


# Every variable that has to be set before a single email can go out.
_REQUIRED_VARS = ("MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM")


def missing_config() -> list[str]:
    """Which of the required MAILGUN_* variables are unset or blank."""
    return [var for var in _REQUIRED_VARS if not os.environ.get(var, "").strip()]


def is_configured() -> bool:
    """True when this process can actually deliver email to real people.

    It is also the only signal the app has for "this is a deployment, not
    somebody's laptop", which routers/auth.py uses to decide whether a
    missing APP_BASE_URL is a harmless dev default or a misconfiguration
    worth refusing to send over. A machine that can reach real staff
    inboxes is a machine whose reset links must point somewhere real.
    """
    return not missing_config()


def send_password_reset(to_email: str, name: str, reset_url: str) -> bool:
    """Email a password reset link. Returns True only on a 2xx from Mailgun.

    `reset_url` arrives finished: the caller builds it from APP_BASE_URL, so
    that nothing here ever depends on a request's Host header.
    """
    missing = missing_config()
    if missing:
        # WARNING, not DEBUG: local dev and CI are meant to run unconfigured,
        # but a production deploy missing a variable looks exactly like email
        # silently vanishing, and this line is the only thing that says why.
        logger.warning(
            "Password reset email not sent: %s not set", ", ".join(missing)
        )
        return False

    api_key = os.environ["MAILGUN_API_KEY"].strip()
    domain = os.environ["MAILGUN_DOMAIN"].strip()
    sender = os.environ["MAILGUN_FROM"].strip()
    api_base = os.environ.get("MAILGUN_API_BASE", _DEFAULT_API_BASE).strip().rstrip("/")

    try:
        response = httpx.post(
            f"{api_base}/{domain}/messages",
            auth=("api", api_key),
            data={
                "from": sender,
                "to": to_email,
                "subject": _SUBJECT,
                "text": _text_body(name, reset_url),
                "html": _html_body(name, reset_url),
            },
            timeout=_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        logger.error("Password reset email failed to send: %s", exc)
        return False

    if response.is_success:
        return True

    logger.error(
        "Mailgun rejected the password reset email: %s %s",
        response.status_code,
        response.text,
    )
    return False
