"""Reception day rota router tests (reception rota, Task 4)."""
import datetime

from app.models.enums import ReceptionRole

from .conftest import MONDAY

TUESDAY = MONDAY + datetime.timedelta(days=1)
SATURDAY = MONDAY + datetime.timedelta(days=5)

ROTA_URL = "/api/v1/reception/rota"


def _add_template_session(client, staff_id, day, hour, role="phones", note=None):
    resp = client.post("/api/v1/reception/master/sessions", json={
        "staff_id": staff_id, "day": day, "hour": hour, "role": role, "note": note,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestReceptionRotaGenerate:
    def test_generate_copies_active_staff_only(self, client, seeded_reception):
        ra, rb, rd = (
            seeded_reception["staff_ra"],
            seeded_reception["staff_rb"],
            seeded_reception["staff_rd_inactive"],
        )
        _add_template_session(client, ra, "Monday", 9, role="phones")
        _add_template_session(client, rb, "Monday", 9, role="other", note="training")
        _add_template_session(client, rd, "Monday", 9, role="phones")

        resp = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["date"] == MONDAY.isoformat()
        assert len(body["sessions"]) == 2
        by_code = {s["staff_code"]: s for s in body["sessions"]}
        assert set(by_code) == {"RA", "RB"}
        assert by_code["RA"]["role"] == "phones"
        assert by_code["RA"]["note"] is None
        assert by_code["RB"]["role"] == "other"
        assert by_code["RB"]["note"] == "training"

    def test_weekend_422(self, client, seeded_reception):
        resp = client.post(ROTA_URL, json={"date": SATURDAY.isoformat()})
        assert resp.status_code == 422

    def test_duplicate_date_409(self, client, seeded_reception):
        first = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert first.status_code == 201
        second = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert second.status_code == 409
        assert str(first.json()["rota_id"]) in second.json()["detail"]

    def test_delete_then_regenerate_succeeds(self, client, seeded_reception):
        first = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.delete(f"{ROTA_URL}/{first['rota_id']}")
        assert resp.status_code == 204

        second = client.post(ROTA_URL, json={"date": MONDAY.isoformat()})
        assert second.status_code == 201

    def test_empty_day_warns_every_hour(self, client, seeded_reception):
        # MIN_PHONES_STAFF is a flat constant checked every hour of every
        # weekday, so an empty day (no template rows for Tuesday) is short
        # at every slot, not silently satisfied.
        resp = client.post(ROTA_URL, json={"date": TUESDAY.isoformat()})
        assert resp.status_code == 201
        body = resp.json()
        assert body["sessions"] == []
        phones = [i for i in body["issues"] if i["check"] == "phones_shortfall"]
        assert len(phones) == 22
        assert all("0 staff on phones, 2 required" in i["message"] for i in phones)


class TestReceptionRotaLookup:
    def test_get_by_date_404_before_generate(self, client, seeded_reception):
        resp = client.get(ROTA_URL, params={"date": MONDAY.isoformat()})
        assert resp.status_code == 404

    def test_get_by_date_after_generate(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.get(ROTA_URL, params={"date": MONDAY.isoformat()})
        assert resp.status_code == 200
        assert resp.json()["rota_id"] == generated["rota_id"]

    def test_get_by_id(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.get(f"{ROTA_URL}/{generated['rota_id']}")
        assert resp.status_code == 200
        assert resp.json()["date"] == MONDAY.isoformat()

    def test_get_by_id_404(self, client, seeded_reception):
        resp = client.get(f"{ROTA_URL}/999999")
        assert resp.status_code == 404


class TestReceptionRotaCoverage:
    def test_shortfall_warning_appears_and_clears(self, client, seeded_reception):
        ra, rb = seeded_reception["staff_ra"], seeded_reception["staff_rb"]
        # MIN_PHONES_STAFF is a flat 2 for every hour.
        _add_template_session(client, ra, "Monday", 9, role="phones")

        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        issues = generated["issues"]
        hour9 = [i for i in issues if i["message"].startswith("09:00")]
        assert len(hour9) == 1
        assert hour9[0]["severity"] == "warning"
        assert hour9[0]["phase"] == "coverage"
        assert hour9[0]["check"] == "phones_shortfall"
        assert hour9[0]["day"] == "Monday"
        assert "1 staff on phones, 2 required" in hour9[0]["message"]

        add_resp = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": rb, "hour": 9, "role": "phones",
        })
        assert add_resp.status_code == 201, add_resp.text
        remaining = add_resp.json()["issues"]
        assert not any(i["message"].startswith("09:00") for i in remaining)

    def test_other_role_does_not_count_towards_phones(self, client, seeded_reception):
        ra, rb, rc = (
            seeded_reception["staff_ra"],
            seeded_reception["staff_rb"],
            seeded_reception["staff_rc"],
        )
        for staff_id in (ra, rb, rc):
            _add_template_session(client, staff_id, "Monday", 9, role="other")

        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        hour9 = [i for i in generated["issues"] if i["message"].startswith("09:00")]
        assert len(hour9) == 1
        assert "0 staff on phones, 2 required" in hour9[0]["message"]


class TestReceptionRotaSessions:
    def test_post_session_unknown_staff_404(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": 999999, "hour": 9,
        })
        assert resp.status_code == 404

    def test_post_session_duplicate_slot_409(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        payload = {"staff_id": seeded_reception["staff_ra"], "hour": 9}
        first = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json=payload)
        assert first.status_code == 201
        second = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json=payload)
        assert second.status_code == 409

    def test_post_session_returns_session_and_issues(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "hour": 11, "note": "post",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["session"]["staff_code"] == "RA"
        assert body["session"]["hour"] == 11
        assert body["session"]["role"] == "phones"
        assert body["session"]["note"] == "post"
        assert "issues" in body

    def test_patch_session_pair_setter_returns_issues(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        created = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "hour": 11,
        }).json()["session"]

        resp = client.patch(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/{created['session_id']}",
            json={"role": "other", "note": "training"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["session"]["role"] == "other"
        assert body["session"]["note"] == "training"
        assert "issues" in body

    def test_patch_session_clears_displaced_role(
        self, client, db_session, seeded_reception
    ):
        """A manual edit takes the slot off the front-desk generator's books
        (D4): displaced_role goes back to NULL so a later reset cannot restore
        a role the day no longer has."""
        from app.models.reception import ReceptionRotaSession

        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        created = client.post(f"{ROTA_URL}/{generated['rota_id']}/sessions", json={
            "staff_id": seeded_reception["staff_ra"], "hour": 11,
        }).json()["session"]
        row = db_session.get(ReceptionRotaSession, created["session_id"])
        row.role = ReceptionRole.FRONT_DESK
        row.displaced_role = ReceptionRole.PHONES
        db_session.commit()

        resp = client.patch(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/{created['session_id']}",
            json={"role": "prescriptions", "note": None},
        )
        assert resp.status_code == 200

        db_session.expire_all()
        row = db_session.get(ReceptionRotaSession, created["session_id"])
        assert row.role is ReceptionRole.PRESCRIPTIONS
        assert row.displaced_role is None

    def test_patch_session_missing_404(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.patch(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/999999",
            json={"role": "phones", "note": None},
        )
        assert resp.status_code == 404

    def test_delete_session_is_absence_mechanism(self, client, seeded_reception):
        ra, rb = seeded_reception["staff_ra"], seeded_reception["staff_rb"]
        _add_template_session(client, ra, "Monday", 9, role="phones")
        _add_template_session(client, rb, "Monday", 9, role="phones")

        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        session_id = next(
            s["session_id"] for s in generated["sessions"] if s["staff_code"] == "RA"
        )

        resp = client.delete(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/{session_id}"
        )
        assert resp.status_code == 204

        refetched = client.get(f"{ROTA_URL}/{generated['rota_id']}").json()
        assert {s["staff_code"] for s in refetched["sessions"]} == {"RB"}
        hour9 = [i for i in refetched["issues"] if i["message"].startswith("09:00")]
        assert "1 staff on phones, 2 required" in hour9[0]["message"]

    def test_delete_session_missing_404(self, client, seeded_reception):
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.delete(f"{ROTA_URL}/{generated['rota_id']}/sessions/999999")
        assert resp.status_code == 404

    def test_delete_rota_cascades_sessions(self, client, seeded_reception):
        _add_template_session(client, seeded_reception["staff_ra"], "Monday", 9)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        resp = client.delete(f"{ROTA_URL}/{generated['rota_id']}")
        assert resp.status_code == 204
        assert client.get(f"{ROTA_URL}/{generated['rota_id']}").status_code == 404


class TestReceptionRotaFrontDeskGap:
    """front_desk_gap: one warning per contiguous uncovered range of
    8:00am-6:00pm, not one per hour (D5)."""

    ALL_DAY = "08:00-18:00: no front desk cover"

    @staticmethod
    def _gaps(body):
        return [i for i in body["issues"] if i["check"] == "front_desk_gap"]

    @staticmethod
    def _cover(client, staff_id, day, first_hour, last_hour):
        """Template rows tagged front_desk from first_hour up to (not
        including) last_hour."""
        hour = first_hour
        while hour < last_hour:
            _add_template_session(client, staff_id, day, hour, role="front_desk")
            hour += 0.5

    def test_no_front_desk_anywhere_is_one_issue(self, client, seeded_reception):
        body = client.post(ROTA_URL, json={"date": TUESDAY.isoformat()}).json()
        gaps = self._gaps(body)
        assert len(gaps) == 1
        assert gaps[0]["severity"] == "warning"
        assert gaps[0]["phase"] == "coverage"
        assert gaps[0]["day"] == "Tuesday"
        assert gaps[0]["message"] == self.ALL_DAY

    def test_fully_covered_day_emits_none(self, client, seeded_reception):
        self._cover(client, seeded_reception["staff_ra"], "Monday", 8.0, 18.0)
        body = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assert self._gaps(body) == []

    def test_gaps_either_side_of_covered_middle(self, client, seeded_reception):
        # Covered 10:00-14:00 only, so the day has exactly two gaps.
        self._cover(client, seeded_reception["staff_ra"], "Monday", 10.0, 14.0)
        body = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assert [i["message"] for i in self._gaps(body)] == [
            "08:00-10:00: no front desk cover",
            "14:00-18:00: no front desk cover",
        ]

    def test_holder_on_leave_leaves_the_gap_open(self, client, seeded_reception):
        # Same leave exclusion phones_shortfall applies: a desk assigned to
        # someone later marked off is not cover.
        ra = seeded_reception["staff_ra"]
        self._cover(client, ra, "Monday", 8.0, 18.0)
        leave = client.post("/api/v1/reception/leave", json={
            "staff_id": ra, "date": MONDAY.isoformat(),
        })
        assert leave.status_code == 201, leave.text

        body = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assert [i["message"] for i in self._gaps(body)] == [self.ALL_DAY]

    def test_1730_slot_covers_the_last_half_hour(self, client, seeded_reception):
        # 6:00-6:30pm is deliberately outside the covered window (D8), so
        # cover ending at 18:00 leaves nothing uncovered.
        self._cover(client, seeded_reception["staff_ra"], "Monday", 8.0, 17.5)
        body = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assert [i["message"] for i in self._gaps(body)] == [
            "17:30-18:00: no front desk cover",
        ]


class TestReceptionRotaFrontDeskAssign:
    """POST /{rota_id}/front-desk: reset, choose, apply (D7). The rule itself
    is unit-tested in test_reception_front_desk.py -- what is tested here is
    the endpoint's contract and, above all, the reset/apply ordering that
    makes a re-run idempotent without eating manual edits (D4)."""

    @staticmethod
    def _url(rota_id):
        return f"{ROTA_URL}/{rota_id}/front-desk"

    @staticmethod
    def _present(client, staff_id, day, first_hour, last_hour, role="phones"):
        """Template rows from first_hour up to (not including) last_hour."""
        hour = first_hour
        while hour < last_hour:
            _add_template_session(client, staff_id, day, hour, role=role)
            hour += 0.5

    def _full_day(self, client, seeded_reception, day="Monday"):
        """All three active staff in for the whole covered window, so a legal
        partition certainly exists."""
        for key in ("staff_ra", "staff_rb", "staff_rc"):
            self._present(client, seeded_reception[key], day, 8.0, 18.0)

    @staticmethod
    def _front_desk_hours(body):
        return sorted(s["hour"] for s in body["sessions"] if s["role"] == "front_desk")

    @staticmethod
    def _roles(body):
        return {(s["staff_id"], s["hour"]): s["role"] for s in body["sessions"]}

    def test_assignment_tiles_the_window_and_clears_the_gaps(
        self, client, seeded_reception
    ):
        self._full_day(client, seeded_reception)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assert TestReceptionRotaFrontDeskGap._gaps(generated)

        resp = client.post(self._url(generated["rota_id"]))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert self._front_desk_hours(body) == [8.0 + 0.5 * i for i in range(20)]
        assert TestReceptionRotaFrontDeskGap._gaps(body) == []

    def test_response_carries_the_rewritten_sessions(self, client, seeded_reception):
        self._full_day(client, seeded_reception)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assert not any(s["role"] == "front_desk" for s in generated["sessions"])

        body = client.post(self._url(generated["rota_id"])).json()
        assert body["rota_id"] == generated["rota_id"]
        # A response the page can take wholesale: same row count, roles updated
        # in place rather than rows added or removed.
        assert len(body["sessions"]) == len(generated["sessions"])
        holders = {
            s["staff_id"] for s in body["sessions"] if s["role"] == "front_desk"
        }
        assert 2 <= len(holders) <= 3

    def test_blocks_are_contiguous_runs_per_holder(self, client, seeded_reception):
        self._full_day(client, seeded_reception)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        body = client.post(self._url(generated["rota_id"])).json()

        by_hour = {
            s["hour"]: s["staff_id"]
            for s in body["sessions"] if s["role"] == "front_desk"
        }
        runs = []
        for hour in sorted(by_hour):
            if runs and runs[-1][0] == by_hour[hour]:
                continue
            runs.append((by_hour[hour], hour))
        # 2-3 blocks, and no holder returns to an adjacent block.
        assert 2 <= len(runs) <= 3
        assert all(a[0] != b[0] for a, b in zip(runs, runs[1:]))

    def test_rerun_is_idempotent(self, client, seeded_reception, db_session):
        from app.models.reception import ReceptionRotaSession

        self._full_day(client, seeded_reception)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()

        first = client.post(self._url(generated["rota_id"])).json()
        second = client.post(self._url(generated["rota_id"])).json()
        assert self._roles(second) == self._roles(first)

        # No displaced_role drift: every assigned row records the role the day
        # had before assignment (phones here), not front_desk from the run before.
        db_session.expire_all()
        rows = db_session.query(ReceptionRotaSession).filter_by(
            rota_id=generated["rota_id"]
        ).all()
        displaced = {
            r.displaced_role for r in rows if r.role is ReceptionRole.FRONT_DESK
        }
        assert displaced == {ReceptionRole.PHONES}
        assert all(
            r.displaced_role is None
            for r in rows if r.role is not ReceptionRole.FRONT_DESK
        )

    def test_manual_front_desk_tag_survives_a_rerun(self, client, seeded_reception):
        """displaced_role IS NULL means "not the generator's row", so the reset
        step leaves a hand-tagged slot alone. 7:30am is outside the covered
        window (D8), so the assigner never touches it either."""
        self._full_day(client, seeded_reception)
        _add_template_session(
            client, seeded_reception["staff_ra"], "Monday", 7.5, role="front_desk"
        )
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()

        client.post(self._url(generated["rota_id"]))
        body = client.post(self._url(generated["rota_id"])).json()
        tagged = next(s for s in body["sessions"] if s["hour"] == 7.5)
        assert tagged["role"] == "front_desk"

    def test_patch_takes_a_slot_off_the_generators_books(
        self, client, seeded_reception, db_session
    ):
        """A manual PATCH clears displaced_role, so the next re-run neither
        restores the displaced role nor re-uses the slot."""
        from app.models.reception import ReceptionRotaSession

        self._full_day(client, seeded_reception)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assigned = client.post(self._url(generated["rota_id"])).json()

        slot = next(s for s in assigned["sessions"] if s["role"] == "front_desk")
        patched = client.patch(
            f"{ROTA_URL}/{generated['rota_id']}/sessions/{slot['session_id']}",
            json={"role": "not_working", "note": None},
        )
        assert patched.status_code == 200

        body = client.post(self._url(generated["rota_id"])).json()
        after = next(
            s for s in body["sessions"] if s["session_id"] == slot["session_id"]
        )
        assert after["role"] == "not_working"
        db_session.expire_all()
        row = db_session.get(ReceptionRotaSession, slot["session_id"])
        assert row.displaced_role is None

    def test_unsolvable_day_is_200_with_gaps(self, client, seeded_reception):
        # Everyone leaves at noon, so no partition of 8:00-18:00 has a holder
        # for its later blocks. Nothing is assigned; the day comes back warning.
        for key in ("staff_ra", "staff_rb", "staff_rc"):
            self._present(client, seeded_reception[key], "Monday", 8.0, 12.0)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()

        resp = client.post(self._url(generated["rota_id"]))
        assert resp.status_code == 200
        body = resp.json()
        assert self._front_desk_hours(body) == []
        assert [i["message"] for i in TestReceptionRotaFrontDeskGap._gaps(body)] == [
            TestReceptionRotaFrontDeskGap.ALL_DAY
        ]

    def test_unsolvable_rerun_still_resets_a_previous_assignment(
        self, client, seeded_reception, db_session
    ):
        """An empty block list is not a no-op: the reset still stands, so a day
        that has become unsolvable loses its stale assignment rather than
        keeping it."""
        from app.models.reception import ReceptionRotaSession

        self._full_day(client, seeded_reception)
        generated = client.post(ROTA_URL, json={"date": MONDAY.isoformat()}).json()
        assigned = client.post(self._url(generated["rota_id"])).json()
        assert self._front_desk_hours(assigned)

        # Delete every row from noon on, leaving the afternoon uncoverable.
        for session in assigned["sessions"]:
            if session["hour"] >= 12.0:
                client.delete(
                    f"{ROTA_URL}/{generated['rota_id']}/sessions/{session['session_id']}"
                )

        body = client.post(self._url(generated["rota_id"])).json()
        assert self._front_desk_hours(body) == []
        db_session.expire_all()
        rows = db_session.query(ReceptionRotaSession).filter_by(
            rota_id=generated["rota_id"]
        ).all()
        assert all(r.displaced_role is None for r in rows)
        assert all(r.role is ReceptionRole.PHONES for r in rows)

    def test_unknown_rota_404(self, client, seeded_reception):
        assert client.post(self._url(999999)).status_code == 404
