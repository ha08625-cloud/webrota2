"""RecurringNote router tests (recurring notes picker plan, Task 3).

Definitions carry no template weeks: the week a note lands on is chosen
per run on the staging page (see test_staging.py).

`seeded` (tests_test_api_conftest.py) gives two active doctors, AA and BB.
Tests needing a third doctor, or an inactive one, add it directly via
db_session -- there is no doctors-router helper in this file's scope.
"""
import datetime

from app.models import Doctor, RotaConfig, RotaConfigNote, RotaConfigNoteDoctor
from app.models.enums import Day, DoctorType, Period


def _make_note(client, seeded, **overrides):
    payload = {
        "text": "Partners meeting",
        "day": "Monday",
        "period": "PM",
        "is_active": True,
        "doctor_ids": [seeded["doctor_aa"]],
    }
    payload.update(overrides)
    resp = client.post("/api/v1/recurring-notes", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestRecurringNotesCrud:
    def test_create_list_update_delete_round_trip(self, client, seeded):
        created = _make_note(client, seeded)
        assert created["text"] == "Partners meeting"
        assert created["doctor_ids"] == [seeded["doctor_aa"]]

        listed = client.get("/api/v1/recurring-notes").json()
        assert [n["id"] for n in listed] == [created["id"]]

        put_resp = client.put(
            f"/api/v1/recurring-notes/{created['id']}",
            json={
                "text": "Partners meeting (updated)",
                "day": "Tuesday",
                "period": "AM",
                "is_active": False,
                "doctor_ids": [seeded["doctor_bb"]],
            },
        )
        assert put_resp.status_code == 200, put_resp.text
        updated = put_resp.json()
        assert updated["text"] == "Partners meeting (updated)"
        assert updated["day"] == "Tuesday"
        assert updated["is_active"] is False
        assert updated["doctor_ids"] == [seeded["doctor_bb"]]

        assert client.delete(
            f"/api/v1/recurring-notes/{created['id']}"
        ).status_code == 204
        assert client.get("/api/v1/recurring-notes").json() == []

    def test_delete_404_for_unknown_id(self, client, seeded):
        resp = client.delete("/api/v1/recurring-notes/999999")
        assert resp.status_code == 404

    def test_put_404_for_unknown_id(self, client, seeded):
        resp = client.put(
            "/api/v1/recurring-notes/999999",
            json={
                "text": "x",
                "day": "Monday",
                "period": "AM",
                "doctor_ids": [seeded["doctor_aa"]],
            },
        )
        assert resp.status_code == 404

    def test_python_side_day_ordering(self, client, seeded):
        """A Friday note must sort after a Monday note -- alphabetical
        ORDER BY would put Friday first."""
        friday = _make_note(client, seeded, day="Friday")
        monday = _make_note(client, seeded, day="Monday")
        listed = client.get("/api/v1/recurring-notes").json()
        assert [n["id"] for n in listed] == [monday["id"], friday["id"]]

    def test_put_replaces_children_wholesale(self, client, seeded, db_session):
        third = Doctor(
            code="CC", doctor_type=DoctorType.PARTNER, sessions_per_week=10,
            active=True,
        )
        db_session.add(third)
        db_session.commit()

        created = _make_note(
            client, seeded,
            doctor_ids=[seeded["doctor_aa"], seeded["doctor_bb"], third.id],
        )
        assert len(created["doctor_ids"]) == 3

        resp = client.put(
            f"/api/v1/recurring-notes/{created['id']}",
            json={
                "text": created["text"],
                "day": created["day"],
                "period": created["period"],
                "doctor_ids": [seeded["doctor_aa"]],
            },
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["doctor_ids"] == [seeded["doctor_aa"]]

    def test_overlapping_notes_both_persist(self, client, seeded):
        """No uniqueness rule across notes -- two notes
        matching the same doctor/week/day/period are both legal."""
        first = _make_note(client, seeded, text="Meeting A")
        second = _make_note(client, seeded, text="Meeting B")
        listed = client.get("/api/v1/recurring-notes").json()
        assert {n["id"] for n in listed} == {first["id"], second["id"]}


class TestRecurringNotesValidation:
    def test_empty_text_422(self, client, seeded):
        resp = client.post("/api/v1/recurring-notes", json={
            "text": "   ",
            "day": "Monday",
            "period": "AM",
            "doctor_ids": [seeded["doctor_aa"]],
        })
        assert resp.status_code == 422

    def test_empty_doctor_ids_422(self, client, seeded):
        resp = client.post("/api/v1/recurring-notes", json={
            "text": "Note",
            "day": "Monday",
            "period": "AM",
            "doctor_ids": [],
        })
        assert resp.status_code == 422

    def test_duplicate_doctor_id_422(self, client, seeded):
        resp = client.post("/api/v1/recurring-notes", json={
            "text": "Note",
            "day": "Monday",
            "period": "AM",
            "doctor_ids": [seeded["doctor_aa"], seeded["doctor_aa"]],
        })
        assert resp.status_code == 422

    def test_inactive_doctor_id_422(self, client, seeded, db_session):
        inactive = Doctor(
            code="ZZ", doctor_type=DoctorType.PARTNER, sessions_per_week=10,
            active=False,
        )
        db_session.add(inactive)
        db_session.commit()

        resp = client.post("/api/v1/recurring-notes", json={
            "text": "Note",
            "day": "Monday",
            "period": "AM",
            "doctor_ids": [inactive.id],
        })
        assert resp.status_code == 422
        assert str(inactive.id) in resp.json()["detail"]

    def test_unknown_doctor_id_422(self, client, seeded):
        resp = client.post("/api/v1/recurring-notes", json={
            "text": "Note",
            "day": "Monday",
            "period": "AM",
            "doctor_ids": [999999],
        })
        assert resp.status_code == 422

class TestDefinitionDeleteLeavesInstances:
    def test_delete_nulls_source_note_id_on_picked_instances(
        self, client, seeded, db_session
    ):
        """A picked instance is a snapshot, not a live link: deleting the
        definition it came from must leave the instance intact with only
        its provenance pointer cleared -- and must not be blocked by the
        FK."""
        created = _make_note(client, seeded)
        config = RotaConfig(
            start_date=datetime.date(2025, 1, 6), num_weeks=1, template_start_week=1
        )
        db_session.add(config)
        db_session.flush()
        instance = RotaConfigNote(
            config_id=config.id,
            source_note_id=created["id"],
            text="Partners meeting",
            week=1,
            day=Day.MONDAY,
            period=Period.PM,
        )
        instance.doctors = [RotaConfigNoteDoctor(doctor_id=seeded["doctor_aa"])]
        db_session.add(instance)
        db_session.commit()

        assert client.delete(
            f"/api/v1/recurring-notes/{created['id']}"
        ).status_code == 204

        db_session.expire_all()
        surviving = db_session.get(RotaConfigNote, instance.id)
        assert surviving is not None
        assert surviving.source_note_id is None
        assert surviving.text == "Partners meeting"
        assert [d.doctor_id for d in surviving.doctors] == [seeded["doctor_aa"]]
