"""Contract tests for app.email, and for the config reporting built on it.

The transport is stubbed in every test. Nothing here may make a network
call: this suite runs in CI, and a real POST would be both flaky and a
live email. The unconfigured case asserts that no request is even built.
"""
import logging

import httpx
import pytest

from app import email as email_module
from app.api.routers import auth

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


class TestConfigReporting:
    """is_configured is the app's only "this is a real deployment" signal,
    and check_config is what makes a missing variable visible at deploy
    time rather than on the day somebody is locked out."""

    def _clear(self, monkeypatch):
        for var in (
            "MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM", "APP_BASE_URL"
        ):
            monkeypatch.delenv(var, raising=False)

    def _configure_mailgun(self, monkeypatch):
        monkeypatch.setenv("MAILGUN_API_KEY", "key-abc")
        monkeypatch.setenv("MAILGUN_DOMAIN", "mail.example.org")
        monkeypatch.setenv("MAILGUN_FROM", "rota@example.org")

    def test_unconfigured_lists_every_missing_variable(self, monkeypatch):
        self._clear(monkeypatch)
        assert email_module.is_configured() is False
        assert email_module.missing_config() == [
            "MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM"
        ]

    def test_a_blank_variable_counts_as_missing(self, monkeypatch):
        self._configure_mailgun(monkeypatch)
        monkeypatch.setenv("MAILGUN_FROM", "   ")
        assert email_module.missing_config() == ["MAILGUN_FROM"]

    def test_fully_configured(self, monkeypatch):
        self._configure_mailgun(monkeypatch)
        assert email_module.is_configured() is True
        assert email_module.missing_config() == []

    def test_check_config_reports_email_disabled(self, monkeypatch, caplog):
        self._clear(monkeypatch)
        with caplog.at_level(logging.WARNING):
            problems = auth.check_config()
        assert len(problems) == 1
        assert "MAILGUN_API_KEY" in problems[0]
        assert "MAILGUN_API_KEY" in caplog.text

    def test_check_config_reports_a_missing_app_base_url(
        self, monkeypatch, caplog
    ):
        """The case worth catching at startup: everything needed to send is
        set, so the app WILL try, and every attempt will be refused."""
        self._clear(monkeypatch)
        self._configure_mailgun(monkeypatch)
        with caplog.at_level(logging.WARNING):
            problems = auth.check_config()
        assert len(problems) == 1
        assert "APP_BASE_URL" in problems[0]
        assert "APP_BASE_URL" in caplog.text

    def test_check_config_silent_when_fully_configured(
        self, monkeypatch, caplog
    ):
        self._configure_mailgun(monkeypatch)
        monkeypatch.setenv("APP_BASE_URL", "https://rota.example.org")
        with caplog.at_level(logging.WARNING):
            assert auth.check_config() == []
        assert caplog.text == ""
