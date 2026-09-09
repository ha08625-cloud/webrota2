"""The rule table for the Site Identification (EOI) form autofill.

A port of the FillResearchSite VBA macro. Each rule says: when a table
cell contains these phrases, write these paragraphs into that cell's
neighbour (or, for one section, over the matching line in the cell
itself). Nothing here needs Word -- the macro is entirely data plus a
cell walk, and the walk lives in eoi_fill.py.

The rules are a module-level constant rather than a database table: the
forms are identical every time, so updating a figure is a one-line edit
and a deploy. EoiRule is shaped so that moving to a table later is a
data-source swap rather than a rewrite.

The answer text carries practice-identifying data -- named contacts and
their direct contact details, the site address and code, CQC rating, ODP
reporting dates and recruitment totals. It is committed here on the basis
that this repository is private.
"""
from dataclasses import dataclass
from typing import Literal

TargetMode = Literal["right_cell", "same_cell_line"]


@dataclass(frozen=True)
class EoiRule:
    """One section of the form.

    id                  stable and url-safe (e.g. "section-4"); this is
                        what the endpoint reports as unmatched, so it has
                        to survive being put in a latin-1 HTTP header
    label               human name, for the frontend's warning text
    required            every one of these must appear in the cell text
    excluded            none of these may appear
    max_target_length   if set, the rule only fires when the *target*
                        cell's normalised text is shorter than this -- the
                        macro's Len(Trim(targetCell.Range.Text)) < 50 guard
                        on Section 10, which keeps it from overwriting an
                        answer that has already been written by hand. It
                        guards the target, not the trigger; the target is
                        not known here, so eoi_fill applies it.
    target              "right_cell" replaces the whole cell to the right;
                        "same_cell_line" replaces the matching paragraph
                        within the trigger cell itself, leaving its
                        sibling paragraphs alone
    answer              the paragraphs to write; exactly one string when
                        target is "same_cell_line"

    Matching is casefolded on both sides and run against whitespace-
    normalised cell text -- see eoi_fill.normalise_text.
    """

    id: str
    label: str
    required: tuple[str, ...]
    answer: tuple[str, ...]
    excluded: tuple[str, ...] = ()
    max_target_length: int | None = None
    target: TargetMode = "right_cell"

    def __post_init__(self) -> None:
        if not self.required:
            raise ValueError(f"Rule {self.id!r} has no required phrases")
        if not self.answer:
            raise ValueError(f"Rule {self.id!r} has no answer paragraphs")
        if self.target == "same_cell_line" and len(self.answer) != 1:
            raise ValueError(
                f"Rule {self.id!r} targets a single line but has "
                f"{len(self.answer)} answer paragraphs"
            )

    def matches(self, text: str) -> bool:
        """True if a cell whose normalised text is `text` triggers this
        rule. `text` is expected to be already normalised (casefolded and
        whitespace-collapsed) by the caller. max_target_length is not
        checked here -- it constrains the target cell, not this one."""
        if any(phrase.casefold() in text for phrase in self.excluded):
            return False
        return all(phrase.casefold() in text for phrase in self.required)


# The eleven sections, in macro order, transcribed verbatim from
# documentation/reference/FillResearchSite.bas.
#
# The figures in the answer text are stale and mutually inconsistent -- the
# CQC rating is from 2016, and Sections 10 and 11 give different
# non-commercial study counts and recruitment totals over different periods.
# They are ported as they stand so this table is diffable against the macro;
# correcting them is a separate ticket.
#
# An empty string is a blank paragraph, which is how the macro's doubled
# .InsertParagraphAfter calls render.
EOI_RULES: tuple[EoiRule, ...] = (
    EoiRule(
        id="section-1",
        label="Research site",
        required=("Research site",),
        answer=(
            "Summertown Health Centre",
            "160 Banbury Road",
            "Oxford",
            "OX2 7BS",
            "K84011",
        ),
    ),
    EoiRule(
        id="section-2",
        label="Investigator",
        required=("Investigator",),
        # The macro's own exclusion: a cell naming both belongs to
        # Section 1, so it must not be claimed here as well.
        excluded=("Research site",),
        answer=(
            "Name and Role: Dr Charlie Luo",
            "",
            "Email: charlie.luo@nhs.net",
            "",
            "Telephone: 01865 515552",
        ),
    ),
    EoiRule(
        id="section-3",
        label="Main contact for feasibility discussions",
        required=("Main contact",),
        answer=(
            "Name and Role: Dr Charlie Luo",
            "",
            "Email: charlie.luo@nhs.net",
            "",
            "Telephone: 01865 515552",
        ),
    ),
    EoiRule(
        id="section-4",
        label="Research setting",
        required=("Primary Care", "Y/N"),
        target="same_cell_line",
        answer=("Primary Care Y",),
    ),
    EoiRule(
        id="section-5",
        label="Supporting Network",
        required=("Supporting Network",),
        answer=(
            "South Central RRRN sc.rrdn@nihr.ac.uk",
            "sc.rrdn@nihr.ac.uk",
        ),
    ),
    EoiRule(
        id="section-6",
        label="Participant recruitment",
        required=("Where and how will",),
        answer=(
            "Summertown Health Centre is based in Oxfordshire and has a stable "
            "patient population of approx. 19,000",
            "",
            "The GP Practice holds electronic patient records which are coded. "
            "From the application of a bespoke search via our clinical system "
            "EMIS, based on the inclusion and exclusion criteria, eligible "
            "patients can easily be identified.",
            "",
            "In addition, patients can also be identified when contacting us "
            "directly or via remote consultations.",
        ),
    ),
    EoiRule(
        id="section-7",
        label="Staff resource",
        required=("outline the staff resource",),
        answer=(
            "Summertown Health Centre has a dedicated GCP trained research "
            "team. This comprises:",
            "",
            "-   Principal Investigator",
            "-   Co-Investigators",
            "-   Research Nurse Manager",
            "-   Research Nurse and Health Care Assistant",
            "-   Operations Manager",
            "",
            "Study set up can be quick, subject to regulatory approvals and "
            "sponsor requirements",
            "",
            "The research team have the relevant experience according to the "
            "Schedule of Assessments provided.",
            "",
            "They are familiar with the requirements for collection, "
            "processing and packing of blood samples for both central and "
            "local labs",
            "",
            "Data entry and query resolution would be completed in accordance "
            "with the sponsor requirements.",
            "",
            "We have significant experience of providing instructions/training "
            "to patients for the use of study",
            "",
            "specific requirements, and the use of technologies. In addition, "
            "we are familiar with collecting patient",
            "",
            "reported outcomes via questionnaires and e-diaries",
            "",
            "",
            "Research Nurse support can also be provided by the experienced "
            "CRN: Thames Valley and South Midlands (TVSM) Primary Care "
            "Research Nurse Team as required. See below for detail.",
            "",
            "The GP Practice is also supported by the Commercial Research "
            "Manager who can provide support for study set up, including the "
            "review of the Industry Costing Template. The study will be "
            "performance managed to ensure delivery of the study to time and "
            "target.",
            "",
            "Our CQC (Care Quality Commission) Inspection rating = Good "
            "(September 2016)",
        ),
    ),
    EoiRule(
        id="section-8",
        label="Infrastructure",
        required=("other infrastructure",),
        answer=(
            "Based on the information provided, Summertown Health Centre can "
            "provide the following facilities to conduct this study:",
            "",
            "-   Clinic room capacity",
            "-   Secure storage, with limited access",
            "-   Standard clinical equipment",
            "-   Drug cupboard with external thermometer, not a clinical grade "
            "medication cupboard",
            "-   Vaccine fridge(s) with temperature monitoring? Vaccine "
            "fridges have integral thermometers, fridge temps monitored twice "
            "daily by the nursing team. Also have separate data loggers which "
            "are downloaded monthly unless cold chain breach, then downloaded "
            "immediately",
            "-   Capacity to accommodate remote and on site monitoring visits "
            "with NHS Wi-Fi access",
            "Calibration certificates can be provided",
            "-   Willing to source / hire any specialist equipment for a study "
            "if selected",
        ),
    ),
    EoiRule(
        id="section-9",
        label="Site-specific activities",
        required=("site-specific activities",),
        answer=(
            "Confirmation of capacity and capability is provided by the GP "
            "Practice. The timelines for study set up are influenced by the "
            "provision of HRA Approval",
            "",
            "Alternatives to the national templates used (ABPI model agreement "
            "or industry costing template): No",
            "",
            "Any other site-specific activities to highlight: No",
        ),
    ),
    EoiRule(
        id="section-10",
        label="Non-commercial studies",
        required=("Non-Commercial", "Studies"),
        # The macro's Len(Trim(targetCell.Range.Text)) < 50 guard: only fill
        # this one if the answer cell is still effectively empty.
        max_target_length=50,
        answer=(
            "Summertown Health centre has a wealth of experience in running "
            "non-commercial studies.",
            "",
            "32 non-commercial studies have been running at Summertown Health "
            "Centre during the period April 2021 -- to date, with a collective "
            "recruitment of 960 (ODP 2023-04-06)",
        ),
    ),
    EoiRule(
        id="section-11",
        label="Network support",
        required=("unique elements of Network",),
        answer=(
            "We have previous experience recruiting to the commercial studies "
            "below:",
            "Localised Neuropathic Pain – target of 15 reached with 100% "
            "retention rate",
            "Diabetes study – target of 2 reached with 100% retention rate",
            "Summertown Health centre has a wealth of experience in running "
            "non-commercial studies",
            "13 non-commercial studies have been running at Summertown Health "
            "Centre during the period FY 23/ 24 and FY 24/25 , with a "
            "collective recruitment of 840 (ODP reporting, Feb 2025)",
            "",
            "Support may be provided by SC RRDN agile team on request.",
        ),
    ),
)
