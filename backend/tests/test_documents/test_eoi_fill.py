"""Tests for app.documents.eoi_fill.fill_eoi.

The rule mechanics -- dedup, targeting, the two write modes, misses --
are exercised on small documents built in-test with python-docx, since
the module is a bytes-in/bytes-out transform and synthetic forms make the
mechanic under test obvious. The real rule table is exercised end to end
against tests/fixtures/site_id_form_blank.docx, where what matters is
that all eleven sections land in the right cells of a form with twelve
merged regions.
"""
import io
from pathlib import Path

import pytest
from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt

from app.documents.eoi_fill import _snapshot, fill_eoi, normalise_text
from app.documents.eoi_rules import EOI_RULES, EoiRule
from app.documents.errors import DocumentFormatError

BLANK_FORM = Path(__file__).parents[1] / "fixtures" / "site_id_form_blank.docx"


def _to_bytes(document: Document) -> bytes:
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _reopen(docx_bytes: bytes) -> Document:
    return Document(io.BytesIO(docx_bytes))


def _grid(rows: int = 2, cols: int = 2, text: dict | None = None) -> bytes:
    """A docx with one table, cells labelled r{r}c{c} unless overridden."""
    document = Document()
    table = document.add_table(rows=rows, cols=cols)
    for r in range(rows):
        for c in range(cols):
            value = (text or {}).get((r, c), f"r{r}c{c}")
            table.rows[r].cells[c].text = value
    return _to_bytes(document)


def _merge_column(document: Document, table_index: int, col: int, top: int, bottom: int):
    table = document.tables[table_index]
    table.rows[top].cells[col].merge(table.rows[bottom].cells[col])


RULE = EoiRule(
    id="rule-a",
    label="Rule A",
    required=("trigger phrase",),
    answer=("first answer line", "second answer line"),
)


class TestRightCell:
    def test_writes_to_the_cell_on_the_right(self):
        docx_bytes = _grid(text={(0, 0): "a trigger phrase here"})

        filled, unmatched = fill_eoi(docx_bytes, [RULE])

        table = _reopen(filled).tables[0]
        assert [p.text for p in table.rows[0].cells[1].paragraphs] == [
            "first answer line",
            "second answer line",
        ]
        assert unmatched == []

    def test_leaves_the_trigger_cell_untouched(self):
        docx_bytes = _grid(text={(0, 0): "a trigger phrase here"})

        filled, _ = fill_eoi(docx_bytes, [RULE])

        table = _reopen(filled).tables[0]
        assert table.rows[0].cells[0].text == "a trigger phrase here"
        assert table.rows[1].cells[1].text == "r1c1"

    def test_no_neighbour_means_no_write(self):
        # The trigger is in the last column. The macro would reuse the
        # previously resolved target here; nothing may be written.
        docx_bytes = _grid(text={(0, 1): "a trigger phrase here"})

        filled, unmatched = fill_eoi(docx_bytes, [RULE])

        assert unmatched == ["rule-a"]
        table = _reopen(filled).tables[0]
        assert [table.rows[r].cells[c].text for r in range(2) for c in range(2)] == [
            "r0c0",
            "a trigger phrase here",
            "r1c0",
            "r1c1",
        ]

    def test_answer_containing_its_own_trigger_is_not_rewritten(self):
        # Section 9's answer text contains Section 9's trigger phrase, which
        # made the macro re-match the cell it had just written.
        self_matching = EoiRule(
            id="rule-self",
            label="Self",
            required=("site-specific activities",),
            answer=("we undertake site-specific activities on request",),
        )
        docx_bytes = _grid(
            rows=2, cols=3, text={(0, 0): "please describe site-specific activities"}
        )

        filled, unmatched = fill_eoi(docx_bytes, [self_matching])

        table = _reopen(filled).tables[0]
        assert table.rows[0].cells[1].text == (
            "we undertake site-specific activities on request"
        )
        assert table.rows[0].cells[2].text == "r0c2"
        assert unmatched == []

    def test_one_rule_writes_once_even_with_several_triggers(self):
        docx_bytes = _grid(
            text={(0, 0): "a trigger phrase here", (1, 0): "another trigger phrase"}
        )

        filled, _ = fill_eoi(docx_bytes, [RULE])

        table = _reopen(filled).tables[0]
        assert table.rows[0].cells[1].text.startswith("first answer line")
        assert table.rows[1].cells[1].text == "r1c1"


class TestMatching:
    def test_matching_is_case_insensitive(self):
        docx_bytes = _grid(text={(0, 0): "A TRIGGER PHRASE Here"})

        _, unmatched = fill_eoi(docx_bytes, [RULE])

        assert unmatched == []

    def test_whitespace_in_the_cell_is_normalised(self):
        docx_bytes = _grid(text={(0, 0): "a  trigger\xa0phrase here"})

        _, unmatched = fill_eoi(docx_bytes, [RULE])

        assert unmatched == []

    def test_excluded_phrase_blocks_the_match(self):
        rule = EoiRule(
            id="rule-x",
            label="X",
            required=("trigger phrase",),
            excluded=("not this one",),
            answer=("answer",),
        )
        docx_bytes = _grid(text={(0, 0): "a trigger phrase, not this one"})

        _, unmatched = fill_eoi(docx_bytes, [rule])

        assert unmatched == ["rule-x"]

    def test_max_target_length_protects_an_already_answered_cell(self):
        # The macro measured the target cell, not the trigger: the guard
        # exists so a part-filled form does not lose a hand-written answer.
        rule = EoiRule(
            id="rule-len",
            label="Len",
            required=("trigger phrase",),
            max_target_length=30,
            answer=("answer",),
        )
        answered = "an answer somebody has already written in by hand"
        filled, unmatched = fill_eoi(
            _grid(text={(0, 0): "a trigger phrase", (0, 1): answered}), [rule]
        )
        assert unmatched == ["rule-len"]
        assert _reopen(filled).tables[0].rows[0].cells[1].text == answered

        _, matched = fill_eoi(
            _grid(text={(0, 0): "a trigger phrase", (0, 1): "short"}), [rule]
        )
        assert matched == []

    def test_max_target_length_ignores_the_trigger_cell_length(self):
        rule = EoiRule(
            id="rule-len",
            label="Len",
            required=("trigger phrase",),
            max_target_length=30,
            answer=("answer",),
        )
        long_trigger = "a trigger phrase followed by a great deal more text"
        docx_bytes = _grid(text={(0, 0): long_trigger, (0, 1): ""})

        _, unmatched = fill_eoi(docx_bytes, [rule])

        assert unmatched == []

    def test_unrelated_document_reports_every_rule(self):
        docx_bytes = _grid()

        filled, unmatched = fill_eoi(docx_bytes, [RULE, RULE])

        assert unmatched == ["rule-a", "rule-a"]
        assert _reopen(filled).tables[0].rows[0].cells[1].text == "r0c1"

    def test_normalise_text_collapses_and_casefolds(self):
        assert normalise_text("  Research\xa0 Site \n") == "research site"


class TestVerticalMerges:
    def test_a_merged_trigger_cell_is_filled_once(self):
        # python-docx returns the same cell object for every row a vMerge
        # spans, so a naive walk would fill the second row's target too.
        document = Document()
        table = document.add_table(rows=3, cols=2)
        for r in range(3):
            for c in range(2):
                table.rows[r].cells[c].text = f"r{r}c{c}"
        _merge_column(document, 0, 0, 0, 1)
        table.rows[0].cells[0].text = "a trigger phrase here"

        filled, unmatched = fill_eoi(_to_bytes(document), [RULE])

        table = _reopen(filled).tables[0]
        assert table.rows[0].cells[1].text.startswith("first answer line")
        assert table.rows[1].cells[1].text == "r1c1"
        assert unmatched == []


class TestSameCellLine:
    LINE_RULE = EoiRule(
        id="rule-line",
        label="Line",
        required=("primary care",),
        answer=("Primary Care Y",),
        target="same_cell_line",
    )

    def _four_line_cell(self) -> bytes:
        document = Document()
        table = document.add_table(rows=1, cols=2)
        cell = table.rows[0].cells[0]
        cell.text = "Primary Care Y/N ( )"
        for line in ("Secondary Care Y/N ( )", "Community Care Y/N ( )", "Other"):
            cell.add_paragraph(line)
        table.rows[0].cells[1].text = "r0c1"
        return _to_bytes(document)

    def test_replaces_only_the_matching_paragraph(self):
        filled, unmatched = fill_eoi(self._four_line_cell(), [self.LINE_RULE])

        cell = _reopen(filled).tables[0].rows[0].cells[0]
        assert [p.text for p in cell.paragraphs] == [
            "Primary Care Y",
            "Secondary Care Y/N ( )",
            "Community Care Y/N ( )",
            "Other",
        ]
        assert unmatched == []

    def test_does_not_touch_the_cell_to_the_right(self):
        filled, _ = fill_eoi(self._four_line_cell(), [self.LINE_RULE])

        assert _reopen(filled).tables[0].rows[0].cells[1].text == "r0c1"

    def test_reported_unmatched_when_no_paragraph_matches(self):
        document = Document()
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = "Nothing relevant"
        table.rows[0].cells[1].text = "r0c1"

        _, unmatched = fill_eoi(_to_bytes(document), [self.LINE_RULE])

        assert unmatched == ["rule-line"]


class TestFormatting:
    def _run_properties(self, paragraph):
        return paragraph.runs[0]._r.find(qn("w:rPr"))

    def test_answer_inherits_the_target_cell_formatting(self):
        document = Document()
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = "a trigger phrase here"
        target_run = table.rows[0].cells[1].paragraphs[0].add_run("existing")
        target_run.font.name = "Arial"
        target_run.font.size = Pt(14)

        filled, _ = fill_eoi(_to_bytes(document), [RULE])

        cell = _reopen(filled).tables[0].rows[0].cells[1]
        for paragraph in cell.paragraphs:
            assert paragraph.runs[0].font.name == "Arial"
            assert paragraph.runs[0].font.size == Pt(14)

    def test_empty_target_inherits_the_trigger_cell_formatting(self):
        document = Document()
        table = document.add_table(rows=1, cols=2)
        trigger_run = table.rows[0].cells[0].paragraphs[0].add_run(
            "a trigger phrase here"
        )
        trigger_run.font.name = "Arial"
        trigger_run.font.size = Pt(11)

        filled, _ = fill_eoi(_to_bytes(document), [RULE])

        cell = _reopen(filled).tables[0].rows[0].cells[1]
        assert [p.text for p in cell.paragraphs] == [
            "first answer line",
            "second answer line",
        ]
        for paragraph in cell.paragraphs:
            assert paragraph.runs[0].font.name == "Arial"
            assert paragraph.runs[0].font.size == Pt(11)

    def test_same_cell_line_keeps_the_line_formatting(self):
        document = Document()
        table = document.add_table(rows=1, cols=2)
        cell = table.rows[0].cells[0]
        run = cell.paragraphs[0].add_run("Primary Care Y/N ( )")
        run.font.name = "Arial"
        run.bold = True
        cell.add_paragraph("Secondary Care Y/N ( )")

        filled, _ = fill_eoi(_to_bytes(document), [TestSameCellLine.LINE_RULE])

        paragraph = _reopen(filled).tables[0].rows[0].cells[0].paragraphs[0]
        assert paragraph.text == "Primary Care Y"
        assert len(paragraph.runs) == 1
        assert paragraph.runs[0].font.name == "Arial"
        assert paragraph.runs[0].bold is True

    def test_no_empty_normal_paragraph_is_left_behind(self):
        docx_bytes = _grid(text={(0, 0): "a trigger phrase here"})

        filled, _ = fill_eoi(docx_bytes, [RULE])

        cell = _reopen(filled).tables[0].rows[0].cells[1]
        assert len(cell.paragraphs) == 2


class TestErrors:
    def test_rejects_a_non_docx_file(self):
        with pytest.raises(DocumentFormatError):
            fill_eoi(b"\xd0\xcf\x11\xe0 not a zip at all")

    def test_output_reopens_cleanly(self):
        filled, _ = fill_eoi(_grid(text={(0, 0): "a trigger phrase here"}), [RULE])

        assert len(_reopen(filled).tables) == 1

    def test_empty_rule_table_returns_the_document_unchanged(self):
        docx_bytes = _grid()

        filled, unmatched = fill_eoi(docx_bytes, [])

        assert unmatched == []
        assert _reopen(filled).tables[0].rows[0].cells[0].text == "r0c0"


class TestRuleValidation:
    def test_a_single_line_rule_must_have_one_answer(self):
        with pytest.raises(ValueError):
            EoiRule(
                id="bad",
                label="Bad",
                required=("x",),
                answer=("a", "b"),
                target="same_cell_line",
            )

    def test_a_rule_needs_required_phrases_and_an_answer(self):
        with pytest.raises(ValueError):
            EoiRule(id="bad", label="Bad", required=(), answer=("a",))
        with pytest.raises(ValueError):
            EoiRule(id="bad", label="Bad", required=("x",), answer=())


@pytest.fixture(scope="module")
def blank() -> bytes:
    return BLANK_FORM.read_bytes()


@pytest.fixture(scope="module")
def filled(blank):
    output, unmatched = fill_eoi(blank)
    return _reopen(output), unmatched


class TestTheRealForm:
    """End-to-end against the committed blank Site Identification form."""

    def test_the_form_table_has_38_distinct_cells(self, blank):
        # 25 rows x 2 columns with 12 merged regions. A walk that did not
        # deduplicate would see 50.
        entries = _snapshot(_reopen(blank))
        assert sum(1 for e in entries if e.table_index == 1) == 38

    def test_only_section_10_is_unmatched(self, filled):
        # There is no "Non-Commercial ... Studies" cell on this form. The
        # macro reported success regardless; the miss is now visible.
        _, unmatched = filled
        assert unmatched == ["section-10"]

    @pytest.mark.parametrize(
        "row, opening",
        [
            (1, "Summertown Health Centre"),
            (2, "Name and Role: Dr Charlie Luo"),
            (3, "Name and Role: Dr Charlie Luo"),
            (5, "South Central RRRN sc.rrdn@nihr.ac.uk"),
            (7, "Summertown Health Centre is based in Oxfordshire"),
            (11, "Summertown Health Centre has a dedicated GCP trained"),
            (12, "Based on the information provided"),
            (14, "Confirmation of capacity and capability"),
            (18, "We have previous experience recruiting"),
        ],
    )
    def test_each_answer_lands_in_the_cell_to_the_right(self, filled, row, opening):
        document, _ = filled
        assert document.tables[1].rows[row].cells[1].text.startswith(opening)

    def test_a_merged_label_does_not_fill_the_next_row(self, filled):
        # The "Main contact / Research Setting" label is merged across rows
        # 3-4 in column 0 but not in column 1, so row.cells hands the label
        # back twice while the two answer cells stay distinct. A walk that
        # visited it twice would write the contact details over row 4's
        # Research Setting answer.
        document, _ = filled
        assert document.tables[1].rows[4].cells[1].text.startswith("Primary Care Y")

    def test_the_research_setting_lines_survive(self, filled):
        # The macro replaced the whole cell here, destroying three lines.
        document, _ = filled
        cell = document.tables[1].rows[4].cells[1]
        assert [p.text for p in cell.paragraphs] == [
            "Primary Care Y",
            "Secondary Care     Y/N (_)",
            "Community Care    Y/N (_)",
            "Other [insert detail here]",
        ]

    def test_the_investigator_label_is_left_alone(self, filled):
        # Word splits this label across runs ("Name and " / "R" / "ole:"),
        # which is why the port replaces whole cells rather than text.
        document, _ = filled
        assert document.tables[1].rows[2].cells[0].text == "Investigator"

    def test_the_sponsor_questions_are_left_empty(self, filled):
        document, _ = filled
        for row in (21, 22, 23, 24):
            assert document.tables[1].rows[row].cells[1].text.strip() == ""

    def test_the_answers_inherit_the_form_font(self, filled):
        document, _ = filled
        for paragraph in document.tables[1].rows[11].cells[1].paragraphs:
            for run in paragraph.runs:
                assert run.font.name == "Arial"
                assert run.font.size == Pt(9)

    def test_every_rule_writes_its_paragraphs_verbatim(self, filled):
        document, _ = filled
        by_id = {rule.id: rule for rule in EOI_RULES}
        for row, rule_id in ((1, "section-1"), (5, "section-5"), (14, "section-9")):
            cell = document.tables[1].rows[row].cells[1]
            assert [p.text for p in cell.paragraphs] == list(by_id[rule_id].answer)
