"""Fills the standard sections of an NIHR Site Identification (EOI) form.

A port of the FillResearchSite VBA macro: walk every cell of every table,
and where a cell contains a rule's trigger phrases, write that rule's
answer paragraphs into the cell to its right (or, for one section, over
the matching line in the cell itself). The rules themselves are data --
see eoi_rules.py.

Two things about this port are deliberate and worth knowing before
changing it.

Whole cells are replaced, never text inside them. The form's labels are
heavily run-split by Word ("Name and " / "R" / "ole:" / " [insert here]"),
so a find-and-replace port would have to reassemble runs; replacing the
whole cell sidesteps that entirely. The macro works the same way.

Matching runs against a snapshot taken before anything is written. Every
cell and its text are captured once, up front, and each cell is written at
most once. This makes two classes of bug impossible by construction rather
than by bookkeeping: a rule cannot match answer text another rule (or the
same rule) has just written, and the order of the rule table cannot change
the result. The macro had exactly that self-match bug -- Section 9's
answer text contains Section 9's own trigger phrase.

Vertical merges need care: python-docx's row.cells returns the *same*
underlying cell for every row a vMerge spans, so a naive walk visits the
form's three merged label cells twice and fills each target twice. The
snapshot deduplicates on id(cell._tc) -- not on the cell object, because
_Cell defines no __eq__ and two wrappers around one tc are unequal.
"""
import io
import re
import zipfile
from copy import deepcopy
from dataclasses import dataclass
from typing import Sequence

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from docx.oxml.ns import qn
from docx.table import _Cell
from docx.text.paragraph import Paragraph

from .eoi_rules import EOI_RULES, EoiRule
from .errors import DocumentFormatError

_WHITESPACE = re.compile(r"\s+")


def normalise_text(text: str) -> str:
    """Casefold, replace non-breaking spaces, and collapse runs of
    whitespace. Word's extracted cell text carries \\xa0 and doubled
    spaces that a literal substring test would trip over, and the macro's
    InStr was case-sensitive -- a sponsor writing "Research Site" for
    "Research site" silently got no match."""
    return _WHITESPACE.sub(" ", text.replace("\xa0", " ")).strip().casefold()


@dataclass(frozen=True)
class _CellEntry:
    """One distinct cell, as captured before any writing happens."""

    cell: _Cell
    table_index: int
    row_index: int
    col_index: int
    text: str


def _snapshot(document: Document) -> list[_CellEntry]:
    """Every distinct cell of every table, in document order, with its
    normalised text. Merged cells appear once, at their first position.

    Dedup is by id(cell._tc) because _Cell has no __eq__, and it is only
    sound while every visited cell is kept alive: lxml hands out one proxy
    per underlying element, but frees it once nothing refers to it, and a
    later proxy can then land on the same id. `visited` exists solely to
    hold those references for the duration of the walk -- without it the
    38-cell reference form dedups down to 13.
    """
    entries: list[_CellEntry] = []
    visited: dict[int, _Cell] = {}
    for table_index, table in enumerate(document.tables):
        for row_index, row in enumerate(table.rows):
            for col_index, cell in enumerate(row.cells):
                key = id(cell._tc)
                if key in visited:
                    continue
                visited[key] = cell
                entries.append(
                    _CellEntry(
                        cell=cell,
                        table_index=table_index,
                        row_index=row_index,
                        col_index=col_index,
                        text=normalise_text(cell.text),
                    )
                )
    return entries


def _formatting(paragraph: Paragraph | None) -> tuple[object | None, object | None]:
    """The paragraph properties of `paragraph` and the run properties of
    its first run, as detached copies ready to graft onto new content.

    This is the one place the module touches XML directly, and it is here
    because python-docx's add_paragraph gives Normal style -- which does
    not match the form's font, so a filled form would look obviously
    machine-written next to the sections the user still fills in by hand.
    """
    if paragraph is None:
        return None, None
    p_pr = paragraph._p.find(qn("w:pPr"))
    r_pr = None
    for run in paragraph.runs:
        r_pr = run._r.find(qn("w:rPr"))
        break
    return (
        deepcopy(p_pr) if p_pr is not None else None,
        deepcopy(r_pr) if r_pr is not None else None,
    )


def _first_paragraph(cell: _Cell) -> Paragraph | None:
    return cell.paragraphs[0] if cell.paragraphs else None


def _write_cell(target: _Cell, trigger: _Cell, answer: Sequence[str]) -> None:
    """Replace everything in `target` with `answer`, one paragraph each.

    Formatting is taken from the target's own first paragraph, falling
    back to the trigger cell's when the target is blank -- which is the
    common case, since answer cells on a blank form are empty and carry
    nothing worth copying.
    """
    p_pr, r_pr = _formatting(_first_paragraph(target))
    if not target.text.strip():
        p_pr, r_pr = _formatting(_first_paragraph(trigger))

    # Not cell.text = "": that leaves a Normal-styled empty paragraph behind.
    for paragraph in list(target._tc.findall(qn("w:p"))):
        target._tc.remove(paragraph)

    for line in answer:
        paragraph = target.add_paragraph()
        if p_pr is not None:
            paragraph._p.insert(0, deepcopy(p_pr))
        run = paragraph.add_run(line)
        if r_pr is not None:
            run._r.insert(0, deepcopy(r_pr))


def _write_line(cell: _Cell, rule: EoiRule) -> bool:
    """Replace the first paragraph of `cell` that matches `rule` with the
    rule's single answer line, leaving the cell's other paragraphs alone.

    The macro replaced the whole cell here, which destroyed the three
    sibling checkbox lines. The paragraph is collapsed to one run carrying
    the first run's properties: intra-paragraph formatting is lost, which
    is acceptable for the uniformly formatted checkbox lines this targets.

    Returns False if no paragraph in the cell matched.
    """
    for paragraph in cell.paragraphs:
        if not rule.matches(normalise_text(paragraph.text)):
            continue
        _, r_pr = _formatting(paragraph)
        for run in list(paragraph._p.findall(qn("w:r"))):
            paragraph._p.remove(run)
        run = paragraph.add_run(rule.answer[0])
        if r_pr is not None:
            run._r.insert(0, deepcopy(r_pr))
        return True
    return False


def fill_eoi(
    docx_bytes: bytes, rules: Sequence[EoiRule] = EOI_RULES
) -> tuple[bytes, list[str]]:
    """Fill the standard sections of a Site Identification form.

    Returns the filled document as bytes, and the ids of the rules that
    found nothing to write -- either no cell triggered them, or (for
    right_cell rules) the triggering cell had no neighbour to the right.
    An unrelated .docx therefore comes back unchanged with every rule id
    reported, rather than raising: the caller can name the misses, which
    is a more useful message than a rejection.

    Raises DocumentFormatError if docx_bytes is not a valid .docx package.
    """
    try:
        document = Document(io.BytesIO(docx_bytes))
    except (PackageNotFoundError, zipfile.BadZipFile):
        # This is the path a legacy .doc (binary, pre-OOXML) upload takes.
        raise DocumentFormatError("File is not a valid .docx document")

    entries = _snapshot(document)
    by_position = {
        (entry.table_index, entry.row_index, entry.col_index): entry
        for entry in entries
    }
    written: set[int] = set()
    unmatched: list[str] = []

    for rule in rules:
        if not _apply_rule(rule, entries, by_position, written):
            unmatched.append(rule.id)

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue(), unmatched


def _apply_rule(
    rule: EoiRule,
    entries: Sequence[_CellEntry],
    by_position: dict[tuple[int, int, int], _CellEntry],
    written: set[int],
) -> bool:
    """Find the first cell that triggers `rule` and write its answer.
    Returns whether anything was written."""
    for entry in entries:
        if id(entry.cell._tc) in written or not rule.matches(entry.text):
            continue

        if rule.target == "same_cell_line":
            if not _write_line(entry.cell, rule):
                continue
            written.add(id(entry.cell._tc))
            return True

        target = by_position.get(
            (entry.table_index, entry.row_index, entry.col_index + 1)
        )
        # No neighbour means no write. The macro reused whatever target it
        # had resolved last, which on a wider form would write an answer
        # into an unrelated cell without complaining.
        if target is None or id(target.cell._tc) in written:
            continue
        # The macro measured the target, not the trigger: this guard is
        # what stops Section 10 overwriting an answer already written by
        # hand into a form that has been part-filled.
        if (
            rule.max_target_length is not None
            and len(target.text) >= rule.max_target_length
        ):
            continue
        _write_cell(target.cell, entry.cell, rule.answer)
        written.add(id(target.cell._tc))
        return True

    return False
