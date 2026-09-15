"""Request and response shapes for the Research section.

Domain-first placement (`app/research/schemas.py`, not
`app/api/schemas/research.py`) per "Adding a Module" in
`documentation/architecture.md`.

Three things here are load-bearing rather than boilerplate:

**`website_url` is validated to http/https, and that is a security control,
not tidiness.** The study header renders the value as a link; a stored
`javascript:` URL rendered as a link is stored XSS on the app's own origin.
The check lives here because this is where the value enters -- the column is
a plain string and a CHECK constraint could only repeat the rule badly.

**Blank strings are normalised to NULL.** `cpms_code` is uniquely indexed,
and a form that posts "" for an empty box would let the second study with
no code collide with the first. Normalising here means the router never has
to think about it, and the same treatment is applied to the other optional
text fields so "cleared" means one thing throughout.

**`StudyPatch` distinguishes absent from null**, via `model_fields_set` in
the router: `{"cpms_code": null}` clears the code, `{}` leaves it alone.
`contacts` is the exception that proves it -- present means "these are now
all the contacts" (a full replace), absent means "leave the
contacts alone". There is deliberately no per-contact endpoint.

`StudyDocumentOut` carries metadata only. The bytes are never serialised:
they leave the app through the download endpoint and nowhere else, and
`size_bytes` exists on the row precisely so a list can show a size without
loading a blob.
"""
from __future__ import annotations

import datetime
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

from ..models.enums import StudyStage

_ALLOWED_URL_SCHEMES = ("http", "https")


def _blank_to_none(value: str | None) -> str | None:
    """Strip, and treat an all-whitespace string as absent. See module docstring."""
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _check_website_url(value: str | None) -> str | None:
    cleaned = _blank_to_none(value)
    if cleaned is None:
        return None
    parsed = urlparse(cleaned)
    if parsed.scheme.lower() not in _ALLOWED_URL_SCHEMES or not parsed.netloc:
        raise ValueError(
            "Study website must be a full http:// or https:// address"
        )
    return cleaned


class StudyContactIn(BaseModel):
    """One contact as the edit dialog sends it.

    No id: contacts are saved as a full replace on the study PATCH, so the
    rows the client last read are not the rows it is updating -- sending an
    id back would imply an identity the replace does not preserve.
    Everything but the name is optional; a contact often arrives as a name
    and an email and nothing else.
    """

    name: str = Field(min_length=1)
    role: str | None = None
    email: str | None = None
    phone: str | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Contact name is required")
        return cleaned

    @field_validator("role", "email", "phone")
    @classmethod
    def _blank_fields(cls, value: str | None) -> str | None:
        return _blank_to_none(value)


class StudyContactOut(BaseModel):
    id: int
    name: str
    role: str | None = None
    email: str | None = None
    phone: str | None = None
    display_order: int

    model_config = {"from_attributes": True}


class StudySetupStepOut(BaseModel):
    """One checklist row that exists. A step with no row is "not done" --
    absence is data here (see research/models.py), so the client reads this
    list against the catalogue rather than expecting eight entries."""

    step_key: str
    done: bool
    done_on: datetime.date | None = None
    note: str | None = None

    model_config = {"from_attributes": True}


class SetupStepPatch(BaseModel):
    """PATCH of one checklist row; only fields present are applied
    (`model_fields_set`), matching the rest of the API's PATCH convention.
    An empty body is a legal no-op that still upserts the row."""

    done: bool | None = None
    done_on: datetime.date | None = None
    note: str | None = None

    @field_validator("note")
    @classmethod
    def _blank_note(cls, value: str | None) -> str | None:
        return _blank_to_none(value)


class StudyDocumentOut(BaseModel):
    """Metadata for one stored file. Never the bytes -- see module docstring."""

    id: int
    slot: str
    filename: str
    content_type: str
    size_bytes: int
    uploaded_at: datetime.datetime
    uploaded_by_user_id: int | None = None

    model_config = {"from_attributes": True}


class StudyIn(BaseModel):
    """POST body. Only the name is required: a study is created the day
    somebody hears about it, and the CPMS code often arrives later."""

    name: str = Field(min_length=1)
    cpms_code: str | None = None
    study_type: str | None = None
    website_url: str | None = None
    owner_user_id: int | None = None
    contacts: list[StudyContactIn] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Study name is required")
        return cleaned

    @field_validator("cpms_code", "study_type")
    @classmethod
    def _blank_fields(cls, value: str | None) -> str | None:
        return _blank_to_none(value)

    @field_validator("website_url")
    @classmethod
    def _website(cls, value: str | None) -> str | None:
        return _check_website_url(value)


class StudyPatch(BaseModel):
    """Partial update of the persistent header. Absent means "leave alone",
    null means "clear" -- the router reads `model_fields_set` to tell them
    apart. `stage` is deliberately NOT a field here: the transition is the
    domain action and has its own two endpoints, so that a body-supplied
    stage cannot smuggle in a jump."""

    name: str | None = Field(default=None, min_length=1)
    cpms_code: str | None = None
    study_type: str | None = None
    website_url: str | None = None
    owner_user_id: int | None = None
    contacts: list[StudyContactIn] | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Study name is required")
        return cleaned

    @field_validator("cpms_code", "study_type")
    @classmethod
    def _blank_fields(cls, value: str | None) -> str | None:
        return _blank_to_none(value)

    @field_validator("website_url")
    @classmethod
    def _website(cls, value: str | None) -> str | None:
        return _check_website_url(value)


class StudyOut(BaseModel):
    """A whole study: the persistent header, the stage and its dates, and
    the three child collections.

    `owner_name` is denormalised into the response on purpose. The Research
    preset grants `research: write` and nothing else, so a research nurse
    cannot read /users -- without the name here the header could only show
    an id.
    """

    id: int
    name: str
    cpms_code: str | None = None
    study_type: str | None = None
    website_url: str | None = None
    owner_user_id: int | None = None
    owner_name: str | None = None
    stage: StudyStage
    setup_entered_on: datetime.date | None = None
    recruitment_opened_on: datetime.date | None = None
    recruitment_closed_on: datetime.date | None = None
    closed_on: datetime.date | None = None
    created_at: datetime.datetime
    contacts: list[StudyContactOut] = Field(default_factory=list)
    setup_steps: list[StudySetupStepOut] = Field(default_factory=list)
    documents: list[StudyDocumentOut] = Field(default_factory=list)

    model_config = {"from_attributes": True}
