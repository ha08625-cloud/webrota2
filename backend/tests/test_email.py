"""Contract tests for app.email.send_password_reset.

The transport is stubbed in every test. Nothing here may make a network
call: this suite runs in CI, and a real POST would be both flaky and a
live email. The unconfigured case asserts that no request is even built.
"""
import logging

import httpx
import pytest

from app import email as email_module

CONFIG = {
    "MAILGUN_API_KEY": "key-test",
    "MAILGUN_DOMAIN": "mail.example.org",
    "MAILGUN_FROM": "Rota <rota@example.org>",
}


@pytest.fixture
def configured(monkeypatch):
    for name, value in CONFIG.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("MAILGUN_API_BASE", raising=False)


@pytest.fixture
def calls(monkeypatch):
    """Record every httpx.post call and return a canned response."""
    recorded = []

    def fake_post(url, **kwargs):
        recorded.append({"url": url, **kwargs})
        return httpx.Response(200, request=httpx.Request("POST", url))

    monkeypatch.setattr(email_module.httpx, "post", fake_post)
    return recorded


def _respond(monkeypatch, status: int, text: str = ""):
    recorded = []

    def fake_post(url, **kwargs):
        recorded.append({"url": url, **kwargs})
        return httpx.Response(
            status, text=text, request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(email_module.httpx, "post", fake_post)
    return recorded


def test_success_posts_to_the_eu_endpoint(configured, calls):
    assert (
        email_module.send_password_reset(
            "sam@example.org", "Sam", "https://rota.example.org/reset-password/tok"
        )
        is True
    )

    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == (
        "https://api.eu.mailgun.net/v3/mail.example.org/messages"
    )
    assert call["auth"] == ("api", "key-test")
    data = call["data"]
    assert data["from"] == CONFIG["MAILGUN_FROM"]
    assert data["to"] == "sam@example.org"
    assert data["subject"]
    # Both parts carry the link; the plain-text part matters most, since
    # some NHSmail clients strip HTML.
    assert "https://rota.example.org/reset-password/tok" in data["text"]
    assert "https://rota.example.org/reset-password/tok" in data["html"]
    assert "Sam" in data["text"]


def test_api_base_override_and_trailing_slash(configured, calls, monkeypatch):
    monkeypatch.setenv("MAILGUN_API_BASE", "https://api.mailgun.net/v3/")

    assert email_module.send_password_reset("s@example.org", "S", "https://x/y") is True
    assert calls[0]["url"] == "https://api.mailgun.net/v3/mail.example.org/messages"


def test_non_2xx_returns_false_and_logs_status_and_body(
    configured, monkeypatch, caplog
):
    _respond(monkeypatch, 401, "Forbidden")

    with caplog.at_level(logging.ERROR, logger=email_module.__name__):
        assert (
            email_module.send_password_reset("s@example.org", "S", "https://x/y")
            is False
        )

    assert "401" in caplog.text
    assert "Forbidden" in caplog.text


def test_transport_error_returns_false_and_logs(configured, monkeypatch, caplog):
    def boom(url, **kwargs):
        raise httpx.ConnectTimeout("timed out")

    monkeypatch.setattr(email_module.httpx, "post", boom)

    with caplog.at_level(logging.ERROR, logger=email_module.__name__):
        assert (
            email_module.send_password_reset("s@example.org", "S", "https://x/y")
            is False
        )

    assert "timed out" in caplog.text


@pytest.mark.parametrize("missing", sorted(CONFIG))
def test_missing_configuration_no_ops_with_a_warning(
    configured, monkeypatch, caplog, missing
):
    monkeypatch.delenv(missing)
    calls = _respond(monkeypatch, 200)

    with caplog.at_level(logging.WARNING, logger=email_module.__name__):
        assert (
            email_module.send_password_reset("s@example.org", "S", "https://x/y")
            is False
        )

    # No request object is even built when unconfigured.
    assert calls == []
    assert missing in caplog.text


def test_empty_configuration_counts_as_missing(configured, monkeypatch, caplog):
    monkeypatch.setenv("MAILGUN_API_KEY", "   ")
    calls = _respond(monkeypatch, 200)

    with caplog.at_level(logging.WARNING, logger=email_module.__name__):
        assert (
            email_module.send_password_reset("s@example.org", "S", "https://x/y")
            is False
        )

    assert calls == []
    assert "MAILGUN_API_KEY" in caplog.text


def test_all_missing_are_named_in_one_warning(monkeypatch, caplog):
    for name in CONFIG:
        monkeypatch.delenv(name, raising=False)
    calls = _respond(monkeypatch, 200)

    with caplog.at_level(logging.WARNING, logger=email_module.__name__):
        assert (
            email_module.send_password_reset("s@example.org", "S", "https://x/y")
            is False
        )

    assert calls == []
    for name in CONFIG:
        assert name in caplog.text
