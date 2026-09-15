"""The setup checklist and the key document slots, in one place.

Dependency-free on purpose -- the same pattern, and the same reason, as
`models/permissions.py`: the router, the schemas, the model validation and
the frontend's mirror of these labels all need one source of truth, and a
module that imports nothing can be read by any of them without dragging a
graph along.

**Setup steps are a catalogue, not an enum type and not rows seeded at
create time.** A study starts with no `study_setup_steps` rows at all; the
first write to a step upserts one, and a missing row renders as "not done"
(see `models.StudySetupStep`). `step_key` is a plain string validated
against `SETUP_STEPS_BY_KEY` on write. Between them those two choices mean a
ninth step is one line here with no migration and no backfill, and a step
dropped from the catalogue leaves orphan rows that are simply never
rendered.

**Documents live in named slots, and there is no "general" slot.** A file
that fits no slot belongs on the intranet. Two kinds of slot:

- The three **key document** slots hold exactly one current file each.
  Uploading replaces it. That is the direct answer to "all the old patient
  information leaflets are in the same folder" -- the page cannot show a
  superseded leaflet because it does not keep one, and the superseded copy
  is not lost, because the intranet has it. `slot_holds_one` is what the
  router reads to decide that.
- The three **setup-step** slots (the steps with `has_documents`) hold any
  number, because a re-signed mNCA arriving beside the original is normal
  and neither copy is "superseded" in a way this page can judge.

Two steps deliberately have no slot of their own:

- `site_pack` -- most of a site pack is not useful day to day and the
  intranet already holds all of it. A slot would invite copying the whole
  thing across, which is the precise failure this section exists to avoid.
  The step keeps its tick and its note.
- `flow_chart` -- the file is the `flow_chart` *key* slot, so it stays
  visible in every stage rather than being buried in a setup step that is
  hidden once setup is over. The step survives as a tick only.

That second one is why `flow_chart` appears in both tables below and means
one thing in each: a step key that is not a slot, and a slot that is not a
step slot. The slot namespace stays unambiguous, since the step does not
contribute one.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class SetupStep:
    """One line of the setup checklist.

    `has_documents` is "this step owns a many-file document slot named after
    its key", not "this step involves a document" -- see the module
    docstring for the two steps where those differ.
    """

    key: str
    label: str
    display_order: int
    has_documents: bool


@dataclass(frozen=True)
class KeyDocumentSlot:
    """One of the three documents shown in the study header in every stage."""

    slot: str
    label: str


# The eight setup steps, in display order. None of them blocks anything:
# they are a reminder list, and the only thing that consults them is the
# confirmation dialog on "Open recruitment", which names what is still
# outstanding. A hard gate on eight ticks teaches people to tick things they
# have not done.
SETUP_STEPS: tuple[SetupStep, ...] = (
    SetupStep("mnca", "Sign mNCA", 1, True),
    SetupStep("siv_booked", "Book Site Initiation Visit", 2, False),
    SetupStep("siv_complete", "Complete Site Initiation Visit", 3, False),
    SetupStep("delegation_log", "Complete delegation log", 4, True),
    SetupStep("training_log", "Complete training log", 5, True),
    SetupStep("site_pack", "Site pack received", 6, False),
    SetupStep("flow_chart", "Flow chart completed", 7, False),
    SetupStep("green_light", "Green light to start recruitment", 8, False),
)

SETUP_STEPS_BY_KEY: dict[str, SetupStep] = {step.key: step for step in SETUP_STEPS}

# The three documents the team actually opens, shown in the study header in
# every stage. All three are *blank study templates* -- see the package
# docstring on the blank/completed line, which is the whole of the
# no-participant-data rule.
KEY_DOCUMENT_SLOTS: tuple[KeyDocumentSlot, ...] = (
    KeyDocumentSlot("flow_chart", "Flow chart"),
    KeyDocumentSlot("patient_information_leaflet", "Patient information leaflet"),
    KeyDocumentSlot("consent_form", "Consent form"),
)

KEY_DOCUMENT_SLOTS_BY_SLOT: dict[str, KeyDocumentSlot] = {
    slot.slot: slot for slot in KEY_DOCUMENT_SLOTS
}

# Slots a setup step owns, named after the step key.
STEP_DOCUMENT_SLOTS: tuple[str, ...] = tuple(
    step.key for step in SETUP_STEPS if step.has_documents
)

# Every slot `study_documents.slot` may hold.
DOCUMENT_SLOTS: tuple[str, ...] = (
    tuple(slot.slot for slot in KEY_DOCUMENT_SLOTS) + STEP_DOCUMENT_SLOTS
)


def step_by_key(key: str) -> SetupStep | None:
    """The catalogue entry for `key`, or None if it is not (or no longer) one."""
    return SETUP_STEPS_BY_KEY.get(key)


def is_valid_step(key: str) -> bool:
    """Whether `key` may be written to `study_setup_steps.step_key`."""
    return key in SETUP_STEPS_BY_KEY


def is_valid_slot(slot: str) -> bool:
    """Whether `slot` may be written to `study_documents.slot`."""
    return slot in DOCUMENT_SLOTS


def slot_holds_one(slot: str) -> bool:
    """Whether uploading to `slot` replaces the file already there.

    True for the three key slots, False for the setup-step slots. Enforced
    by the router in one transaction rather than by a partial unique index:
    expressing "unique only for these three slots" would need a per-dialect
    `where` clause for SQLite and Postgres, which is more machinery than a
    replace needs. An unknown slot is False -- the write is rejected by
    `is_valid_slot` before this is ever reached.
    """
    return slot in KEY_DOCUMENT_SLOTS_BY_SLOT


def document_slot_label(slot: str) -> str | None:
    """Human label for a slot: the key document's own, or its step's."""
    key_slot = KEY_DOCUMENT_SLOTS_BY_SLOT.get(slot)
    if key_slot is not None:
        return key_slot.label
    step = SETUP_STEPS_BY_KEY.get(slot)
    if step is not None and step.has_documents:
        return step.label
    return None
