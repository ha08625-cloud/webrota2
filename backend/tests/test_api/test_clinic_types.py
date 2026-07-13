"""ClinicType router tests (M3 Task 8; clinic_priority reorder work).

clinic_priority is server-managed: ClinicTypeIn has no such field, so it
never appears in a POST/PUT payload here except in
test_clinic_priority_in_payload_is_ignored, which exists specifically to
pin the silent-ignore behaviour.
"""
from .conftest import make_clinic_type_via_api


class TestClinicTypes:
    def test_create_with_nested_children(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        assert created["name"] == "Dragon"
        assert len(created["schedules"]) == 1
        assert len(created["doctor_eligibilities"]) == 1
        assert len(created["room_eligibilities"]) == 1

    def test_get_returns_children(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        got = client.get(f"/api/v1/clinic-types/{created['id']}").json()
        assert got["schedules"][0]["day"] == "Monday"
        assert got["room_eligibilities"][0]["room_id"] == seeded["room_c1"]

    def test_put_replaces_children(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        original_priority = created["clinic_priority"]
        resp = client.put(f"/api/v1/clinic-types/{created['id']}", json={
            "name": "Dragon",
            "room_required": False,
            "schedules": [
                {"day": "Tuesday", "period": "PM"},
                {"day": "Friday", "period": "AM"},
            ],
            "doctor_eligibilities": [],
            "room_eligibilities": [{"room_type": "D"}],
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # An ordinary PUT never reorders anything -- clinic_priority is
        # untouched by the edit, not client-supplied.
        assert body["clinic_priority"] == original_priority
        assert {s["day"] for s in body["schedules"]} == {"Tuesday", "Friday"}
        assert body["doctor_eligibilities"] == []
        assert body["room_eligibilities"][0]["room_type"] == "D"

    def test_duplicate_name_409(self, client, seeded):
        make_clinic_type_via_api(client, seeded)
        resp = client.post("/api/v1/clinic-types", json={"name": "Dragon"})
        assert resp.status_code == 409

    def test_room_elig_xor_422(self, client, seeded):
        resp = client.post("/api/v1/clinic-types", json={
            "name": "Bad",
            "room_eligibilities": [{"room_id": seeded["room_c1"], "room_type": "C"}],
        })
        assert resp.status_code == 422

    def test_delete_cascades(self, client, seeded):
        created = make_clinic_type_via_api(client, seeded)
        assert client.delete(f"/api/v1/clinic-types/{created['id']}").status_code == 204
        assert client.get(f"/api/v1/clinic-types/{created['id']}").status_code == 404
        assert client.get("/api/v1/clinic-types").json() == []

    # -- clinic_priority: server-managed sequence --------------------------

    def test_create_appends_at_end(self, client, seeded):
        first = make_clinic_type_via_api(client, seeded, name="Dragon")
        second = make_clinic_type_via_api(client, seeded, name="Griffin")
        assert first["clinic_priority"] == 1
        assert second["clinic_priority"] == 2

    def test_clinic_priority_in_payload_is_ignored(self, client, seeded):
        """Pins Pydantic's extra-field behaviour: a stale client that still
        sends clinic_priority gets a silent no-op, not a 422, on both create
        and edit.
        """
        create_resp = client.post("/api/v1/clinic-types", json={
            "name": "Dragon",
            "clinic_priority": 999,
            "room_required": True,
            "schedules": [{"day": "Monday", "period": "AM"}],
            "doctor_eligibilities": [{"doctor_id": seeded["doctor_aa"], "doctor_priority": 1}],
            "room_eligibilities": [{"room_id": seeded["room_c1"]}],
        })
        assert create_resp.status_code == 201, create_resp.text
        created = create_resp.json()
        assert created["clinic_priority"] == 1

        put_resp = client.put(f"/api/v1/clinic-types/{created['id']}", json={
            "name": "Dragon",
            "clinic_priority": 999,
            "room_required": True,
            "schedules": [{"day": "Monday", "period": "AM"}],
            "doctor_eligibilities": [],
            "room_eligibilities": [{"room_id": seeded["room_c1"]}],
        })
        assert put_resp.status_code == 200, put_resp.text
        assert put_resp.json()["clinic_priority"] == 1

    def test_delete_enabled_closes_gap(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        b = make_clinic_type_via_api(client, seeded, name="B")
        c = make_clinic_type_via_api(client, seeded, name="C")
        assert [a["clinic_priority"], b["clinic_priority"], c["clinic_priority"]] == [1, 2, 3]

        assert client.delete(f"/api/v1/clinic-types/{b['id']}").status_code == 204

        remaining = client.get("/api/v1/clinic-types").json()
        priorities = sorted(ct["clinic_priority"] for ct in remaining)
        assert priorities == [1, 2]
        c_after = next(ct for ct in remaining if ct["id"] == c["id"])
        assert c_after["clinic_priority"] == 2

    def test_disable_transition_removes_from_sequence(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        b = make_clinic_type_via_api(client, seeded, name="B")
        c = make_clinic_type_via_api(client, seeded, name="C")

        resp = client.put(f"/api/v1/clinic-types/{b['id']}", json={
            "name": "B",
            "is_enabled": False,
            "room_required": True,
            "schedules": [{"day": "Monday", "period": "AM"}],
            "doctor_eligibilities": [],
            "room_eligibilities": [{"room_id": seeded["room_c1"]}],
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["is_enabled"] is False

        c_after = client.get(f"/api/v1/clinic-types/{c['id']}").json()
        assert c_after["clinic_priority"] == 2  # gap left by B closed

        enabled_priorities = sorted(
            ct["clinic_priority"] for ct in client.get("/api/v1/clinic-types").json()
            if ct["is_enabled"]
        )
        assert enabled_priorities == [1, 2]  # A, C -- contiguous, B excluded

    def test_enable_transition_appends_at_end(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        make_clinic_type_via_api(client, seeded, name="B")

        disable_resp = client.put(f"/api/v1/clinic-types/{a['id']}", json={
            "name": "A",
            "is_enabled": False,
            "room_required": True,
            "schedules": [{"day": "Monday", "period": "AM"}],
            "doctor_eligibilities": [],
            "room_eligibilities": [{"room_id": seeded["room_c1"]}],
        })
        assert disable_resp.status_code == 200, disable_resp.text

        # A new clinic type created while A is disabled takes the slot A's
        # gap-close vacated.
        make_clinic_type_via_api(client, seeded, name="C")

        # Re-enabling A must append at the end, not reclaim its old slot.
        enable_resp = client.put(f"/api/v1/clinic-types/{a['id']}", json={
            "name": "A",
            "is_enabled": True,
            "room_required": True,
            "schedules": [{"day": "Monday", "period": "AM"}],
            "doctor_eligibilities": [],
            "room_eligibilities": [{"room_id": seeded["room_c1"]}],
        })
        assert enable_resp.status_code == 200, enable_resp.text
        assert enable_resp.json()["clinic_priority"] == 3

    # -- PUT /clinic-types/reorder -------------------------------------

    def test_reorder_happy_path(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        b = make_clinic_type_via_api(client, seeded, name="B")
        c = make_clinic_type_via_api(client, seeded, name="C")
        assert [a["clinic_priority"], b["clinic_priority"], c["clinic_priority"]] == [1, 2, 3]

        resp = client.put("/api/v1/clinic-types/reorder", json={
            "ordered_ids": [c["id"], a["id"], b["id"]],
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [ct["id"] for ct in body] == [c["id"], a["id"], b["id"]]
        assert [ct["clinic_priority"] for ct in body] == [1, 2, 3]

        listed = {ct["id"]: ct["clinic_priority"] for ct in client.get("/api/v1/clinic-types").json()}
        assert listed[c["id"]] == 1
        assert listed[a["id"]] == 2
        assert listed[b["id"]] == 3

    def test_reorder_rejects_missing_id(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        make_clinic_type_via_api(client, seeded, name="B")
        resp = client.put("/api/v1/clinic-types/reorder", json={
            "ordered_ids": [a["id"]],
        })
        assert resp.status_code == 409

    def test_reorder_rejects_extra_id(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        resp = client.put("/api/v1/clinic-types/reorder", json={
            "ordered_ids": [a["id"], 999999],
        })
        assert resp.status_code == 409

    def test_reorder_rejects_duplicate_id(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        resp = client.put("/api/v1/clinic-types/reorder", json={
            "ordered_ids": [a["id"], a["id"]],
        })
        assert resp.status_code == 409

    def test_reorder_rejects_disabled_id_included(self, client, seeded):
        a = make_clinic_type_via_api(client, seeded, name="A")
        b = make_clinic_type_via_api(client, seeded, name="B")

        disable_resp = client.put(f"/api/v1/clinic-types/{b['id']}", json={
            "name": "B",
            "is_enabled": False,
            "room_required": True,
            "schedules": [{"day": "Monday", "period": "AM"}],
            "doctor_eligibilities": [],
            "room_eligibilities": [{"room_id": seeded["room_c1"]}],
        })
        assert disable_resp.status_code == 200, disable_resp.text

        resp = client.put("/api/v1/clinic-types/reorder", json={
            "ordered_ids": [a["id"], b["id"]],
        })
        assert resp.status_code == 409
