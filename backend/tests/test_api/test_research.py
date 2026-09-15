"""Research API: studies, the stage machine, the checklist and the documents.

Three groups of test here are doing more than covering lines, and are worth
keeping if the file is ever trimmed:

- **The stage machine at both ends.** Advance and revert are the only way
  the column moves, and the 409s at `setup` and `closed` are what stop the
  pair being a settable field with extra steps.
- **Key slot replaces, step slot appends.** That difference is the whole
  answer to "all the old patient information leaflets are in one folder",
  and it lives in the router rather than in a constraint, so nothing but a
  test holds it.
- **The three download headers.** There is no security-headers middleware in
  this app, so `attachment`, the sanitised filename and `nosniff` are set
  per response and nothing else would notice their going missing.

`client` carries the Manager preset, which includes `research: write`; the
permission gates themselves are swept in test_authorization.py rather than
re-checked here.
"""
import datetime
import io

from sqlalchemy import select, text

from app.api.main import API_PREFIX
from app.models import AuditLogEntry
from app.models.enums import StudyStage

STUDIES = f"{API_PREFIX}/research/studies"

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _create(client, **fields):
    body = {"name": "ASPIRE"} | fields
    resp = client.post(STUDIES, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upload(client, study_id, slot, filename="leaflet.pdf", content=b"%PDF-1.4",
            content_type=PDF):
    return client.post(
        f"{STUDIES}/{study_id}/documents",
        data={"slot": slot},
        files={"file": (filename, io.BytesIO(content), content_type)},
    )


# ---------------------------------------------------------------------------
# CRUD and the persistent header
# ---------------------------------------------------------------------------

def test_create_returns_a_study_in_setup_with_todays_entry_date(client):
    study = _create(client, cpms_code="12345", study_type="Interventional")

    assert study["stage"] == "setup"
    assert study["setup_entered_on"] == datetime.date.today().isoformat()
    assert study["recruitment_opened_on"] is None
    assert study["cpms_code"] == "12345"
    assert study["contacts"] == []
    assert study["setup_steps"] == []
    assert study["documents"] == []


def test_list_returns_every_study_by_name(client):
    _create(client, name="Zebra")
    _create(client, name="Alpha")

    resp = client.get(STUDIES)
    assert resp.status_code == 200
    assert [s["name"] for s in resp.json()] == ["Alpha", "Zebra"]


def test_get_404s_for_an_unknown_study(client):
    assert client.get(f"{STUDIES}/999").status_code == 404


def test_patch_applies_only_the_fields_sent(client):
    study = _create(client, cpms_code="12345", study_type="Observational")

    resp = client.patch(f"{STUDIES}/{study['id']}", json={"name": "ASPIRE-2"})
    assert resp.status_code == 200, resp.text
    patched = resp.json()
    assert patched["name"] == "ASPIRE-2"
    # Absent means "leave alone", not "clear".
    assert patched["cpms_code"] == "12345"
    assert patched["study_type"] == "Observational"


def test_patch_with_an_explicit_null_clears_the_field(client):
    study = _create(client, cpms_code="12345")

    resp = client.patch(f"{STUDIES}/{study['id']}", json={"cpms_code": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["cpms_code"] is None


def test_a_blank_cpms_code_is_stored_as_null_so_two_can_coexist(client):
    first = _create(client, name="First", cpms_code="")
    second = _create(client, name="Second", cpms_code="   ")

    assert first["cpms_code"] is None
    assert second["cpms_code"] is None


def test_a_duplicate_cpms_code_is_a_409_not_a_500(client):
    _create(client, name="First", cpms_code="12345")

    resp = client.post(STUDIES, json={"name": "Second", "cpms_code": "12345"})
    assert resp.status_code == 409
    assert "12345" in resp.json()["detail"]


def test_patching_a_cpms_code_onto_another_study_is_a_409(client):
    _create(client, name="First", cpms_code="12345")
    second = _create(client, name="Second")

    resp = client.patch(f"{STUDIES}/{second['id']}", json={"cpms_code": "12345"})
    assert resp.status_code == 409


def test_a_study_may_keep_its_own_cpms_code_on_patch(client):
    study = _create(client, cpms_code="12345")

    resp = client.patch(
        f"{STUDIES}/{study['id']}", json={"cpms_code": "12345", "name": "Renamed"}
    )
    assert resp.status_code == 200, resp.text


def test_owner_is_returned_with_a_name_so_the_header_need_not_read_users(client):
    # The stub user is persisted at id 1 by the client fixture.
    study = _create(client, owner_user_id=1)
    assert study["owner_user_id"] == 1
    assert study["owner_name"] == "Test User"


def test_an_http_website_is_accepted(client):
    study = _create(client, website_url="https://example.com/aspire")
    assert study["website_url"] == "https://example.com/aspire"


def test_a_javascript_url_is_rejected(client):
    resp = client.post(
        STUDIES, json={"name": "X", "website_url": "javascript:alert(1)"}
    )
    assert resp.status_code == 422
    assert "http" in resp.text


def test_a_javascript_url_is_rejected_on_patch_too(client):
    study = _create(client)
    resp = client.patch(
        f"{STUDIES}/{study['id']}", json={"website_url": "javascript:alert(1)"}
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Contacts: a full replace on the study PATCH
# ---------------------------------------------------------------------------

def test_contacts_are_created_with_the_order_they_were_sent(client):
    study = _create(client, contacts=[
        {"name": "Ada", "role": "CRA", "email": "ada@example.com"},
        {"name": "Grace", "phone": "01234 567890"},
    ])

    assert [c["name"] for c in study["contacts"]] == ["Ada", "Grace"]
    assert [c["display_order"] for c in study["contacts"]] == [0, 1]
    assert study["contacts"][0]["email"] == "ada@example.com"
    assert study["contacts"][1]["role"] is None


def test_patching_contacts_replaces_the_whole_list(client):
    study = _create(client, contacts=[{"name": "Ada"}, {"name": "Grace"}])

    resp = client.patch(
        f"{STUDIES}/{study['id']}", json={"contacts": [{"name": "Grace"}]}
    )
    assert resp.status_code == 200, resp.text
    assert [c["name"] for c in resp.json()["contacts"]] == ["Grace"]


def test_patching_without_contacts_leaves_them_alone(client):
    study = _create(client, contacts=[{"name": "Ada"}])

    resp = client.patch(f"{STUDIES}/{study['id']}", json={"name": "Renamed"})
    assert [c["name"] for c in resp.json()["contacts"]] == ["Ada"]


def test_an_empty_contact_list_clears_them(client):
    study = _create(client, contacts=[{"name": "Ada"}])

    resp = client.patch(f"{STUDIES}/{study['id']}", json={"contacts": []})
    assert resp.json()["contacts"] == []


def test_a_nameless_contact_is_rejected(client):
    resp = client.post(STUDIES, json={"name": "X", "contacts": [{"name": "  "}]})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# The setup checklist
# ---------------------------------------------------------------------------

def test_the_first_patch_to_a_step_creates_its_row(client):
    study = _create(client)

    resp = client.patch(
        f"{STUDIES}/{study['id']}/setup-steps/mnca",
        json={"done": True, "done_on": "2026-03-01", "note": "Signed by the PM"},
    )
    assert resp.status_code == 200, resp.text
    steps = resp.json()["setup_steps"]
    assert len(steps) == 1
    assert steps[0] == {
        "step_key": "mnca",
        "done": True,
        "done_on": "2026-03-01",
        "note": "Signed by the PM",
    }


def test_a_second_patch_updates_the_same_row(client):
    study = _create(client)
    client.patch(f"{STUDIES}/{study['id']}/setup-steps/mnca", json={"done": True})

    resp = client.patch(
        f"{STUDIES}/{study['id']}/setup-steps/mnca", json={"note": "Chased"}
    )
    steps = resp.json()["setup_steps"]
    assert len(steps) == 1
    # `note` was sent, `done` was not -- so the tick survives.
    assert steps[0]["done"] is True
    assert steps[0]["note"] == "Chased"


def test_steps_come_back_in_catalogue_order_not_write_order(client):
    study = _create(client)
    for key in ("green_light", "mnca", "siv_booked"):
        client.patch(f"{STUDIES}/{study['id']}/setup-steps/{key}", json={"done": True})

    steps = client.get(f"{STUDIES}/{study['id']}").json()["setup_steps"]
    assert [s["step_key"] for s in steps] == ["mnca", "siv_booked", "green_light"]


def test_a_step_outside_the_catalogue_is_a_422(client):
    study = _create(client)
    resp = client.patch(
        f"{STUDIES}/{study['id']}/setup-steps/not_a_step", json={"done": True}
    )
    assert resp.status_code == 422


def test_patching_a_step_on_an_unknown_study_is_a_404(client):
    assert client.patch(
        f"{STUDIES}/999/setup-steps/mnca", json={"done": True}
    ).status_code == 404


def test_ticking_a_step_does_not_gate_anything(client):
    """The checklist is a reminder list: advancing with nothing ticked works."""
    study = _create(client)
    assert client.post(f"{STUDIES}/{study['id']}/advance").status_code == 200


# ---------------------------------------------------------------------------
# The stage machine
# ---------------------------------------------------------------------------

def test_advance_moves_one_stage_and_dates_the_entry(client):
    study = _create(client)

    resp = client.post(f"{STUDIES}/{study['id']}/advance")
    assert resp.status_code == 200, resp.text
    moved = resp.json()
    assert moved["stage"] == "recruitment_open"
    assert moved["recruitment_opened_on"] == datetime.date.today().isoformat()


def test_advance_walks_the_whole_order_then_409s(client):
    study = _create(client)
    seen = []
    for _ in range(3):
        seen.append(client.post(f"{STUDIES}/{study['id']}/advance").json()["stage"])

    assert seen == ["recruitment_open", "recruitment_closed", "closed"]
    resp = client.post(f"{STUDIES}/{study['id']}/advance")
    assert resp.status_code == 409
    assert "closed" in resp.json()["detail"]


def test_revert_moves_back_one_stage(client):
    study = _create(client)
    client.post(f"{STUDIES}/{study['id']}/advance")

    resp = client.post(f"{STUDIES}/{study['id']}/revert")
    assert resp.status_code == 200, resp.text
    assert resp.json()["stage"] == "setup"


def test_revert_409s_in_setup(client):
    study = _create(client)
    resp = client.post(f"{STUDIES}/{study['id']}/revert")
    assert resp.status_code == 409


def test_reverting_keeps_the_setup_data_that_made_it_safe(client):
    study = _create(client, contacts=[{"name": "Ada"}])
    client.patch(f"{STUDIES}/{study['id']}/setup-steps/mnca", json={"done": True})
    client.post(f"{STUDIES}/{study['id']}/advance")

    reverted = client.post(f"{STUDIES}/{study['id']}/revert").json()
    assert [s["step_key"] for s in reverted["setup_steps"]] == ["mnca"]
    assert [c["name"] for c in reverted["contacts"]] == ["Ada"]
    # The stage it left is still dated: the dates record what happened, not
    # where the study is now.
    assert reverted["recruitment_opened_on"] == datetime.date.today().isoformat()


def test_the_stage_cannot_be_set_through_patch(client):
    study = _create(client)
    client.patch(f"{STUDIES}/{study['id']}", json={"stage": "closed"})
    assert client.get(f"{STUDIES}/{study['id']}").json()["stage"] == "setup"


# ---------------------------------------------------------------------------
# Delete: setup only
# ---------------------------------------------------------------------------

def test_a_study_in_setup_can_be_deleted_with_its_children(client, db_session):
    study = _create(client, contacts=[{"name": "Ada"}])
    client.patch(f"{STUDIES}/{study['id']}/setup-steps/mnca", json={"done": True})
    assert _upload(client, study["id"], "consent_form").status_code == 201

    assert client.delete(f"{STUDIES}/{study['id']}").status_code == 204
    assert client.get(f"{STUDIES}/{study['id']}").status_code == 404
    for table in ("study_contacts", "study_setup_steps", "study_documents"):
        count = db_session.execute(
            text(f"select count(*) from {table}")  # noqa: S608 - table names are literals above
        ).scalar()
        assert count == 0, table


def test_a_study_that_reached_recruitment_cannot_be_deleted(client):
    study = _create(client)
    client.post(f"{STUDIES}/{study['id']}/advance")

    resp = client.delete(f"{STUDIES}/{study['id']}")
    assert resp.status_code == 409
    assert client.get(f"{STUDIES}/{study['id']}").status_code == 200


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------

def test_upload_returns_metadata_and_never_the_bytes(client):
    study = _create(client)

    resp = _upload(client, study["id"], "patient_information_leaflet",
                   content=b"%PDF-1.4 hello")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["slot"] == "patient_information_leaflet"
    assert body["filename"] == "leaflet.pdf"
    assert body["size_bytes"] == len(b"%PDF-1.4 hello")
    assert body["uploaded_by_user_id"] == 1
    assert "data" not in body


def test_a_key_slot_replaces_rather_than_accumulates(client):
    study = _create(client)
    first = _upload(client, study["id"], "consent_form", filename="v1.pdf").json()
    second = _upload(client, study["id"], "consent_form", filename="v2.pdf").json()

    documents = client.get(f"{STUDIES}/{study['id']}").json()["documents"]
    assert [d["filename"] for d in documents] == ["v2.pdf"]
    # The superseded row is gone, not merely hidden.
    assert client.get(
        f"{STUDIES}/{study['id']}/documents/{first['id']}"
    ).status_code == 404
    assert client.get(
        f"{STUDIES}/{study['id']}/documents/{second['id']}"
    ).status_code == 200


def test_a_step_slot_appends(client):
    study = _create(client)
    _upload(client, study["id"], "mnca", filename="original.pdf")
    _upload(client, study["id"], "mnca", filename="resigned.pdf")

    documents = client.get(f"{STUDIES}/{study['id']}").json()["documents"]
    assert sorted(d["filename"] for d in documents) == ["original.pdf", "resigned.pdf"]


def test_a_slot_outside_the_catalogue_is_a_422(client):
    study = _create(client)
    assert _upload(client, study["id"], "site_pack").status_code == 422
    assert _upload(client, study["id"], "anything_else").status_code == 422


def test_a_disallowed_content_type_is_a_422(client):
    study = _create(client)
    resp = _upload(
        client, study["id"], "consent_form",
        filename="notes.txt", content=b"hello", content_type="text/plain",
    )
    assert resp.status_code == 422


def test_an_extension_that_disagrees_with_the_content_type_is_a_422(client):
    """`content_type` is client-supplied and is not evidence of anything."""
    study = _create(client)
    resp = _upload(
        client, study["id"], "consent_form",
        filename="payload.html", content=b"<script>", content_type=PDF,
    )
    assert resp.status_code == 422


def test_a_file_over_five_megabytes_is_a_413(client):
    study = _create(client)
    resp = _upload(
        client, study["id"], "consent_form", content=b"x" * (5 * 1024 * 1024 + 1)
    )
    assert resp.status_code == 413


def test_uploading_to_an_unknown_study_is_a_404(client):
    assert _upload(client, 999, "consent_form").status_code == 404


def test_download_returns_the_bytes_behind_three_headers(client):
    study = _create(client)
    document = _upload(
        client, study["id"], "flow_chart",
        filename="flow chart v2.pdf", content=b"%PDF-1.4 chart",
    ).json()

    resp = client.get(f"{STUDIES}/{study['id']}/documents/{document['id']}")
    assert resp.status_code == 200
    assert resp.content == b"%PDF-1.4 chart"
    assert resp.headers["content-disposition"] == 'attachment; filename="flow chart v2.pdf"'
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-type"].startswith(PDF)


def test_a_filename_cannot_smuggle_a_path_or_a_quote_into_the_header(client, db_session):
    study = _create(client)
    document = _upload(client, study["id"], "flow_chart", filename="ok.pdf").json()
    # Rewrite the stored name to something no upload would accept, which is
    # what the download-side sanitising exists for.
    db_session.execute(
        text(
            "update study_documents set filename = :n where id = :i"
        ),
        {"n": '../../etc/pa"sswd.pdf', "i": document["id"]},
    )
    db_session.commit()

    resp = client.get(f"{STUDIES}/{study['id']}/documents/{document['id']}")
    # Basename only, then quote and path characters stripped.
    assert resp.headers["content-disposition"] == 'attachment; filename="passwd.pdf"'


def test_a_stored_content_type_outside_the_allowlist_is_served_as_octet_stream(
    client, db_session
):
    study = _create(client)
    document = _upload(client, study["id"], "flow_chart").json()
    db_session.execute(
        text(
            "update study_documents set content_type = :c where id = :i"
        ),
        {"c": "text/html", "i": document["id"]},
    )
    db_session.commit()

    resp = client.get(f"{STUDIES}/{study['id']}/documents/{document['id']}")
    assert resp.headers["content-type"].startswith("application/octet-stream")


def test_a_document_belonging_to_another_study_is_a_404(client):
    first = _create(client, name="First")
    second = _create(client, name="Second")
    document = _upload(client, first["id"], "consent_form").json()

    assert client.get(
        f"{STUDIES}/{second['id']}/documents/{document['id']}"
    ).status_code == 404


def test_delete_removes_one_document_and_leaves_the_rest(client):
    study = _create(client)
    first = _upload(client, study["id"], "mnca", filename="a.pdf").json()
    _upload(client, study["id"], "mnca", filename="b.pdf")

    assert client.delete(
        f"{STUDIES}/{study['id']}/documents/{first['id']}"
    ).status_code == 204
    documents = client.get(f"{STUDIES}/{study['id']}").json()["documents"]
    assert [d["filename"] for d in documents] == ["b.pdf"]


def test_a_docx_upload_is_accepted(client):
    study = _create(client)
    resp = _upload(
        client, study["id"], "training_log",
        filename="training.docx", content=b"PK\x03\x04", content_type=DOCX,
    )
    assert resp.status_code == 201, resp.text


# ---------------------------------------------------------------------------
# What the audit log does and does not capture
# ---------------------------------------------------------------------------

def _audit_rows(db_session):
    return list(db_session.execute(
        select(AuditLogEntry).order_by(AuditLogEntry.id)
    ).scalars())


def test_an_upload_is_audited_as_an_event_not_as_its_contents(client, db_session):
    study = _create(client)
    _upload(client, study["id"], "consent_form", content=b"%PDF-1.4 secret bytes")

    row = _audit_rows(db_session)[-1]
    assert row.method == "POST"
    assert row.route == "/research/studies/{study_id}/documents"
    assert row.path_params == {"study_id": str(study["id"])}
    assert row.status_code == 201
    # Multipart passes through unbuffered: the middleware parses a body only
    # when it is JSON, so no part of the file reaches the log.
    assert b"secret bytes" not in (str(row.request_body).encode())


def test_a_metadata_patch_is_audited_in_full(client, db_session):
    study = _create(client)
    client.patch(
        f"{STUDIES}/{study['id']}/setup-steps/mnca",
        json={"done": True, "note": "Signed by the PM"},
    )

    row = _audit_rows(db_session)[-1]
    assert row.route == "/research/studies/{study_id}/setup-steps/{step_key}"
    assert row.request_body == {"done": True, "note": "Signed by the PM"}


def test_every_research_write_has_a_plain_english_description():
    """A narrower restatement of test_audit_descriptions.py's sweep, kept
    because a missing sentence here is a Research-shaped regression."""
    from app.api.audit_descriptions import describe

    for method, route in (
        ("POST", "/research/studies"),
        ("PATCH", "/research/studies/{study_id}"),
        ("DELETE", "/research/studies/{study_id}"),
        ("PATCH", "/research/studies/{study_id}/setup-steps/{step_key}"),
        ("POST", "/research/studies/{study_id}/advance"),
        ("POST", "/research/studies/{study_id}/revert"),
        ("POST", "/research/studies/{study_id}/documents"),
        ("DELETE", "/research/studies/{study_id}/documents/{document_id}"),
    ):
        sentence = describe(method, route, {"study_id": 4})
        assert not sentence.startswith(method), (method, route)


def test_the_stage_column_holds_the_enum_value(client, db_session):
    """Guards the enum round-trip rather than the API: a stage stored as a
    member name instead of its value would still read back fine through
    SQLAlchemy and be wrong everywhere else."""
    study = _create(client)
    client.post(f"{STUDIES}/{study['id']}/advance")

    stored = db_session.execute(
        text("select stage from studies where id = :i"),
        {"i": study["id"]},
    ).scalar()
    assert stored == StudyStage.RECRUITMENT_OPEN.value
