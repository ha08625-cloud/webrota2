"""Reception leave router tests, plus its one effect on the day rota's
coverage count."""
import datetime

from .conftest import MONDAY

LEAVE_URL = "/api/v1/reception/leave"
ROTA_URL = "/api/v1/reception/rota"

TUESDAY = MONDAY + datetime.timedelta(days=1)
FRIDAY = MONDAY + datetime.timedelta(days=4)
SATURDAY = MONDAY + datetime.timedelta(days=5)
SUNDAY = MONDAY + datetime.timedelta(days=6)
NEXT_MONDAY = MONDAY + datetime.timedelta(days=7)


def _add_template_session(client, staff_id, day, hour, role="phones"):
    resp = client.post("/api/v1/reception/master/sessions", json={
        "staff_id": staff_id, "day": day, "hour": hour, "role": role, "note": None,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCreateReceptionLeave:
    def test_create_and_list(self, client, seeded_reception):
        ra = seeded_reception["staff_ra"]
        resp = client.post(LEAVE_URL, json={"staff_id": ra, "date": MONDAY.isoformat()})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["staff_id"] == ra
        assert body["date"] == MONDAY.isoformat()

        listed = client.get(LEAVE_URL).json()
        assert [e["id"] for e in listed] == [body["id"]]

    def test_unknown_staff_404(self, client, seeded_reception):
        resp = client.post(LEAVE_URL, json={"staff_id": 9999, "date": MONDAY.isoformat()})
        assert resp.status_code == 404

    def test_duplicate_409(self, client, seeded_reception):
        ra = seeded_reception["staff_ra"]
        payload = {"staff_id": ra, "date": MONDAY.isoformat()}
        assert client.post(LEAVE_URL, json=payload).status_code == 201
        assert client.post(LEAVE_URL, json=payload).status_code == 409

    def test_same_date_different_staff_allowed(self, client, seeded_reception):
        for key in ("staff_ra", "staff_rb"):
            resp = client.post(
                LEAVE_URL,
                json={"staff_id": seeded_reception[key], "date": MONDAY.isoformat()},
            )
            assert resp.status_code == 201


class TestListFilters:
    def test_staff_and_date_filters(self, client, seeded_reception):
        ra, rb = seeded_reception["staff_ra"], seeded_reception["staff_rb"]
        client.post(LEAVE_URL, json={"staff_id": ra, "date": MONDAY.isoformat()})
        client.post(LEAVE_URL, json={"staff_id": ra, "date": FRIDAY.isoformat()})
        client.post(LEAVE_URL, json={"staff_id": rb, "date": MONDAY.isoformat()})

        by_staff = client.get(f"{LEAVE_URL}?staff_id={ra}").json()
        assert {e["date"] for e in by_staff} == {MONDAY.isoformat(), FRIDAY.isoformat()}

        by_range = client.get(
            f"{LEAVE_URL}?from_date={TUESDAY.isoformat()}&to_date={FRIDAY.isoformat()}"
        ).json()
        assert [e["date"] for e in by_range] == [FRIDAY.isoformat()]


class TestBulkAdd:
    def test_inserts_weekdays_and_skips_weekend(self, client, seeded_reception):
        ra = seeded_reception["staff_ra"]
        resp = client.post(f"{LEAVE_URL}/bulk", json={
            "staff_id": ra,
            "start_date": MONDAY.isoformat(),
            "end_date": NEXT_MONDAY.isoformat(),
        })
        assert resp.status_code == 200, resp.text
        # Mon-Fri + the following Monday = 6 written, Sat/Sun skipped.
        assert resp.json() == {
            "created": 6, "skipped_existing": 0, "skipped_weekend": 2
        }
        dates = {e["date"] for e in client.get(f"{LEAVE_URL}?staff_id={ra}").json()}
        assert SATURDAY.isoformat() not in dates
        assert SUNDAY.isoformat() not in dates

    def test_rerun_reports_existing_rather_than_409(self, client, seeded_reception):
        ra = seeded_reception["staff_ra"]
        payload = {
            "staff_id": ra,
            "start_date": MONDAY.isoformat(),
            "end_date": TUESDAY.isoformat(),
        }
        assert client.post(f"{LEAVE_URL}/bulk", json=payload).json()["created"] == 2
        second = client.post(f"{LEAVE_URL}/bulk", json=payload).json()
        assert second == {"created": 0, "skipped_existing": 2, "skipped_weekend": 0}

    def test_partial_overlap_fills_the_gap_only(self, client, seeded_reception):
        ra = seeded_reception["staff_ra"]
        client.post(LEAVE_URL, json={"staff_id": ra, "date": TUESDAY.isoformat()})
        resp = client.post(f"{LEAVE_URL}/bulk", json={
            "staff_id": ra,
            "start_date": MONDAY.isoformat(),
            "end_date": FRIDAY.isoformat(),
        }).json()
        assert resp == {"created": 4, "skipped_existing": 1, "skipped_weekend": 0}

    def test_unknown_staff_404(self, client, seeded_reception):
        resp = client.post(f"{LEAVE_URL}/bulk", json={
            "staff_id": 9999,
            "start_date": MONDAY.isoformat(),
            "end_date": FRIDAY.isoformat(),
        })
        assert resp.status_code == 404

    def test_reversed_range_422(self, client, seeded_reception):
        resp = client.post(f"{LEAVE_URL}/bulk", json={
            "staff_id": seeded_reception["staff_ra"],
            "start_date": FRIDAY.isoformat(),
            "end_date": MONDAY.isoformat(),
        })
        assert resp.status_code == 422

    def test_range_cap_422(self, client, seeded_reception):
        resp = client.post(f"{LEAVE_URL}/bulk", json={
            "staff_id": seeded_reception["staff_ra"],
            "start_date": MONDAY.isoformat(),
            "end_date": (MONDAY + datetime.timedelta(days=400)).isoformat(),
        })
        assert resp.status_code == 422


class TestBulkDelete:
    def test_deletes_range_including_weekends(self, client, seeded_reception):
        ra = seeded_reception["staff_ra"]
        # A weekend entry is only reachable via the single POST, which
        # accepts it deliberately -- "clear this range" must still remove it.
        client.post(LEAVE_URL, json={"staff_id": ra, "date": SATURDAY.isoformat()})
        client.post(f"{LEAVE_URL}/bulk", json={
            "staff_id": ra,
            "start_date": MONDAY.isoformat(),
            "end_date": FRIDAY.isoformat(),
        })
        resp = client.post(f"{LEAVE_URL}/bulk-delete", json={
            "staff_id": ra,
            "start_date": MONDAY.isoformat(),
            "end_date": SUNDAY.isoformat(),
        })
        assert resp.status_code == 200
        assert resp.json() == {"deleted_count": 6}
        assert client.get(f"{LEAVE_URL}?staff_id={ra}").json() == []

    def test_leaves_other_staff_alone(self, client, seeded_reception):
        ra, rb = seeded_reception["staff_ra"], seeded_reception["staff_rb"]
        for staff_id in (ra, rb):
            client.post(LEAVE_URL, json={"staff_id": staff_id, "date": MONDAY.isoformat()})
        client.post(f"{LEAVE_URL}/bulk-delete", json={
            "staff_id": ra,
            "start_date": MONDAY.isoformat(),
            "end_date": MONDAY.isoformat(),
        })
        remaining = client.get(LEAVE_URL).json()
        assert [e["staff_id"] for e in remaining] == [rb]

    def test_empty_range_returns_zero(self, client, seeded_reception):
        resp = client.post(f"{LEAVE_URL}/bulk-delete", json={
            "staff_id": seeded_reception["staff_ra"],
            "start_date": MONDAY.isoformat(),
            "end_date": FRIDAY.isoformat(),
        })
        assert resp.json() == {"deleted_count": 0}

    def test_unknown_staff_404(self, client, seeded_reception):
        resp = client.post(f"{LEAVE_URL}/bulk-delete", json={
            "staff_id": 9999,
            "start_date": MONDAY.isoformat(),
            "end_date": FRIDAY.isoformat(),
        })
        assert resp.status_code == 404


class TestDeleteReceptionLeave:
    def test_delete_single(self, client, seeded_reception):
        created = client.post(
            LEAVE_URL,
            json={"staff_id": seeded_reception["staff_ra"], "date": MONDAY.isoformat()},
        ).json()
        assert client.delete(f"{LEAVE_URL}/{created['id']}").status_code == 204
        assert client.get(LEAVE_URL).json() == []

    def test_delete_unknown_404(self, client, seeded_reception):
        assert client.delete(f"{LEAVE_URL}/9999").status_code == 404


class TestLeaveAffectsCoverage:
    """The whole of what leave does to the rota: it lowers the phones
    headcount without touching a single session row."""

    def _generate_monday_with_two_on_phones(self, client, seeded_reception):
        for key in ("staff_ra", "staff_rb"):
            _add_template_session(client, seeded_reception[key], "Monday", 9.0)
        resp = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert resp.status_code == 201, resp.text
        return resp.json()

    def test_no_leave_meets_the_rule(self, client, seeded_reception):
        body = self._generate_monday_with_two_on_phones(client, seeded_reception)
        # Monday 09:00 requires 2; both are present.
        assert [i for i in body["issues"] if i["message"].startswith("09:00")] == []
        assert body["staff_on_leave"] == []

    def test_leave_opens_a_shortfall_without_deleting_rows(
        self, client, seeded_reception
    ):
        ra = seeded_reception["staff_ra"]
        self._generate_monday_with_two_on_phones(client, seeded_reception)
        client.post(LEAVE_URL, json={"staff_id": ra, "date": MONDAY.isoformat()})

        body = client.get(f"{ROTA_URL}?date={MONDAY.isoformat()}").json()
        hour9 = [i for i in body["issues"] if i["message"].startswith("09:00")]
        assert len(hour9) == 1
        assert "1 staff on phones, 2 required" in hour9[0]["message"]
        # The absent staff member's row is still there, and flagged.
        assert body["staff_on_leave"] == [ra]
        assert ra in {s["staff_id"] for s in body["sessions"]}

    def test_leave_on_another_date_does_not_count(self, client, seeded_reception):
        self._generate_monday_with_two_on_phones(client, seeded_reception)
        client.post(LEAVE_URL, json={
            "staff_id": seeded_reception["staff_ra"], "date": TUESDAY.isoformat(),
        })
        body = client.get(f"{ROTA_URL}?date={MONDAY.isoformat()}").json()
        assert [i for i in body["issues"] if i["message"].startswith("09:00")] == []
        assert body["staff_on_leave"] == []

    def test_session_write_response_reflects_leave(self, client, seeded_reception):
        rota = self._generate_monday_with_two_on_phones(client, seeded_reception)
        client.post(LEAVE_URL, json={
            "staff_id": seeded_reception["staff_ra"], "date": MONDAY.isoformat(),
        })
        # Editing an unrelated slot must return issues computed with leave
        # applied, not the pre-leave numbers.
        session_id = next(
            s["session_id"] for s in rota["sessions"]
            if s["staff_id"] == seeded_reception["staff_rb"]
        )
        resp = client.patch(
            f"{ROTA_URL}/{rota['rota_id']}/sessions/{session_id}",
            json={"role": "phones", "note": "edited"},
        )
        assert resp.status_code == 200
        hour9 = [i for i in resp.json()["issues"] if i["message"].startswith("09:00")]
        assert "1 staff on phones, 2 required" in hour9[0]["message"]

    def test_generation_still_copies_staff_who_are_on_leave(
        self, client, seeded_reception
    ):
        """Leave deliberately does not change generation -- the day is
        generated in full and the leave is expressed by the coverage count
        and the greyed row, not by missing rows."""
        ra = seeded_reception["staff_ra"]
        _add_template_session(client, ra, "Monday", 9.0)
        client.post(LEAVE_URL, json={"staff_id": ra, "date": MONDAY.isoformat()})

        body = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assert [s["staff_id"] for s in body["sessions"]] == [ra]
        assert body["staff_on_leave"] == [ra]
