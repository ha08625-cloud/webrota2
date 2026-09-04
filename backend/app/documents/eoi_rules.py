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

WARNING: the answer text carries practice-identifying data (CQC rating,
ODP dates, recruitment totals, named contacts). EOI_RULES must only be
populated once the repository is private -- see the prerequisites in
documentation/eoi_autofill_plan.md.
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
    max_source_length   if set, the trigger cell's stripped text must be
                        shorter than this (the macro's Len(Trim(...)) < 50
                        guard on Section 10)
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
    max_source_length: int | None = None
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
        whitespace-collapsed) by the caller."""
        if self.max_source_length is not None and len(text) >= self.max_source_length:
            return False
        if any(phrase.casefold() in text for phrase in self.excluded):
            return False
        return all(phrase.casefold() in text for phrase in self.required)


# The eleven sections, in macro order.
#
# NOT YET POPULATED. The trigger phrases and answer paragraphs exist only
# in the FillResearchSite macro source, which is not in this repository
# (see the prerequisites in documentation/eoi_autofill_plan.md). Populate
# this verbatim from documentation/reference/FillResearchSite.bas once the
# repository is private and that file is committed. Do not correct the
# stale figures in the answer text while porting -- that is a follow-up
# ticket, and a verbatim port is diffable against the macro.
EOI_RULES: tuple[EoiRule, ...] = ()
