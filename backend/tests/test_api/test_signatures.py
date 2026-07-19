"""Signatures router tests (signatures feature, Task 3).

Upload responses use a uniform 200 for both create and replace -- see
schemas/signature.py.

Auth coverage for this router (and every other router) now lives centrally
in test_auth.py (auth plan, Task 4) -- the per-router TestAuth class that
used to live here tested the M3.5 API_TOKEN shim, which get_current_user no
longer implements, and was removed rather than rewritten.
"""
import base64
import io

import pytest
from docx import Document
from docx.oxml.ns import qn

from app.models import Doctor
from app.models.enums import DoctorType

# Minimal valid 1x1 transparent PNG.
_TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY"
    "42YAAAAASUVORK5CYII="
)


def _make_doctor(db_session, code="CC"):
    doctor = Doctor(code=code, doctor_type=DoctorType.PARTNER, sessions_per_week=10, active=True)
    db_session.add(doctor)
    db_session.commit()
    db_session.refresh(doctor)
    return doctor.id


def _build_docx(with_table=True, cols=2) -> bytes:
    document = Document()
    if with_table:
        document.add_table(rows=2, cols=cols)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


class TestUpload:
    def test_upload_creates_and_returns_meta(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["doctor_id"] == doctor_id
        assert body["content_type"] == "image/png"
        assert "uploaded_at" in body

    def test_upload_replace_updates_timestamp(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        first = client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        ).json()
        second = client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig2.png", _TINY_PNG, "image/png")},
        ).json()
        assert second["uploaded_at"] >= first["uploaded_at"]
        assert len(client.get("/api/v1/signatures").json()) == 1

    def test_wrong_content_type_422(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.gif", b"gifbytes", "image/gif")},
        )
        assert resp.status_code == 422

    def test_unknown_doctor_404(self, client, db_session):
        resp = client.post(
            "/api/v1/signatures/999999",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        assert resp.status_code == 404

    def test_oversize_image_413(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        big = b"\x00" * (5 * 1024 * 1024 + 1)
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", big, "image/png")},
        )
        assert resp.status_code == 413


class TestListAndFetch:
    def test_list_and_image_roundtrip(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        listing = client.get("/api/v1/signatures").json()
        assert len(listing) == 1
        assert listing[0]["doctor_id"] == doctor_id

        img_resp = client.get(f"/api/v1/signatures/{doctor_id}/image")
        assert img_resp.status_code == 200
        assert img_resp.headers["content-type"] == "image/png"
        assert img_resp.content == _TINY_PNG

    def test_image_404_when_absent(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        resp = client.get(f"/api/v1/signatures/{doctor_id}/image")
        assert resp.status_code == 404


class TestDelete:
    def test_delete_then_image_404(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        del_resp = client.delete(f"/api/v1/signatures/{doctor_id}")
        assert del_resp.status_code == 204
        assert client.get(f"/api/v1/signatures/{doctor_id}/image").status_code == 404

    def test_delete_when_absent_404(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        resp = client.delete(f"/api/v1/signatures/{doctor_id}")
        assert resp.status_code == 404


class TestApply:
    def test_apply_happy_path(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        docx_bytes = _build_docx()
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}/apply",
            files={
                "file": (
                    "letter.docx",
                    docx_bytes,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
            },
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"] == (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        assert "-signed.docx" in resp.headers["content-disposition"]

        out_doc = Document(io.BytesIO(resp.content))
        bottom_left_cell = out_doc.tables[0].rows[-1].cells[0]
        drawings = bottom_left_cell._tc.findall(".//" + qn("w:drawing"))
        assert len(drawings) == 1

        protections = out_doc.settings.element.findall(qn("w:documentProtection"))
        assert len(protections) == 1

    def test_apply_no_signature_stored_409(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        docx_bytes = _build_docx()
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}/apply",
            files={
                "file": (
                    "letter.docx",
                    docx_bytes,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
            },
        )
        assert resp.status_code == 409
        assert resp.json()["detail"] == "No signature stored for this doctor"

    def test_apply_garbage_bytes_422(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}/apply",
            files={"file": ("letter.docx", b"not a real docx", "application/octet-stream")},
        )
        assert resp.status_code == 422
        assert "not a valid" in resp.json()["detail"].lower()

    def test_apply_no_table_422(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        docx_bytes = _build_docx(with_table=False)
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}/apply",
            files={
                "file": (
                    "letter.docx",
                    docx_bytes,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
            },
        )
        assert resp.status_code == 422
        assert "no table" in resp.json()["detail"].lower()

    def test_apply_oversize_document_413(self, client, db_session):
        doctor_id = _make_doctor(db_session)
        client.post(
            f"/api/v1/signatures/{doctor_id}",
            files={"file": ("sig.png", _TINY_PNG, "image/png")},
        )
        big = b"\x00" * (10 * 1024 * 1024 + 1)
        resp = client.post(
            f"/api/v1/signatures/{doctor_id}/apply",
            files={"file": ("letter.docx", big, "application/octet-stream")},
        )
        assert resp.status_code == 413
