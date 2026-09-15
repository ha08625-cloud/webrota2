"""Catalogue tests: the checklist and the document slots agree with each
other and with what the rest of the section assumes about them.

Small on purpose -- app/research/catalogue.py is data plus four predicates.
What is worth pinning is the part that is easy to break by accident: the
`flow_chart` collision (a step key that is *not* a slot, beside a key slot
of the same name), and the rule that only the three key slots replace on
upload.
"""
from app.research import catalogue


def test_eight_steps_with_unique_keys_in_display_order():
    assert len(catalogue.SETUP_STEPS) == 8
    assert len({step.key for step in catalogue.SETUP_STEPS}) == 8
    orders = [step.display_order for step in catalogue.SETUP_STEPS]
    assert orders == sorted(orders)


def test_only_the_three_many_file_steps_have_documents():
    with_documents = {step.key for step in catalogue.SETUP_STEPS if step.has_documents}
    assert with_documents == {"mnca", "delegation_log", "training_log"}


def test_site_pack_and_flow_chart_steps_have_no_slot_of_their_own():
    """site_pack because the intranet is the site pack's home; flow_chart
    because the file is the key slot, visible in every stage."""
    assert catalogue.SETUP_STEPS_BY_KEY["site_pack"].has_documents is False
    assert catalogue.SETUP_STEPS_BY_KEY["flow_chart"].has_documents is False
    assert "site_pack" not in catalogue.STEP_DOCUMENT_SLOTS
    assert "flow_chart" not in catalogue.STEP_DOCUMENT_SLOTS


def test_valid_steps_are_exactly_the_catalogue():
    assert catalogue.is_valid_step("green_light")
    assert not catalogue.is_valid_step("consent_form")
    assert not catalogue.is_valid_step("")
    assert catalogue.step_by_key("mnca").label == "Sign mNCA"
    assert catalogue.step_by_key("nope") is None


def test_slot_namespace_is_the_three_key_slots_plus_the_three_step_slots():
    assert set(catalogue.DOCUMENT_SLOTS) == {
        "flow_chart",
        "patient_information_leaflet",
        "consent_form",
        "mnca",
        "delegation_log",
        "training_log",
    }
    assert len(catalogue.DOCUMENT_SLOTS) == 6  # no name means two things
    assert not catalogue.is_valid_slot("site_pack")
    assert not catalogue.is_valid_slot("general")


def test_only_key_slots_hold_one_file():
    assert catalogue.slot_holds_one("flow_chart")
    assert catalogue.slot_holds_one("patient_information_leaflet")
    assert catalogue.slot_holds_one("consent_form")
    assert not catalogue.slot_holds_one("mnca")
    assert not catalogue.slot_holds_one("nonsense")


def test_every_slot_has_a_label_and_flow_chart_uses_the_key_documents_one():
    assert all(
        catalogue.document_slot_label(slot) for slot in catalogue.DOCUMENT_SLOTS
    )
    assert catalogue.document_slot_label("flow_chart") == "Flow chart"
    assert catalogue.document_slot_label("mnca") == "Sign mNCA"
    assert catalogue.document_slot_label("site_pack") is None
