"""Tests for app.documents.pdf_convert.convert_to_pdf.

The whole module is skipped when LibreOffice is absent, so a developer
without it can still run the suite. CI installs libreoffice-writer in the
backend test job precisely so the skip is inert there and these really run --
if you see them skipped on CI, that install step has regressed.

No PDF text-extraction library is a dependency of this project, so the
content assertions here are structural (magic bytes, size, page count marker)
rather than "the word Declaration appears". Where an assertion could only be
made with a parser, it is left out rather than faked -- except the one place
where a comparison does the job: a PDF rendered from signed RTF must be
meaningfully larger than one rendered from the same RTF unsigned, because it
carries an embedded image the other does not.
"""
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.documents.errors import ConversionError
from app.documents.pdf_convert import convert_to_pdf
from app.documents.rtf_signature_insert import insert_signature_rtf

from .test_rtf_signature_insert import _png_bytes

SAMPLE_PATH = Path(__file__).parent.parent / "fixtures" / "certificate_sample.rtf"

pytestmark = pytest.mark.skipif(
    shutil.which("soffice") is None,
    reason="LibreOffice (soffice) is not installed",
)

# The sample is a full multi-page certificate form, so its PDF is tens of KB.
# This floor only rules out a truncated or empty render.
MIN_PLAUSIBLE_PDF_BYTES = 5_000


@pytest.fixture
def sample_rtf() -> bytes:
    return SAMPLE_PATH.read_bytes()


class TestConvertToPdf:
    def test_converts_the_sample_rtf(self, sample_rtf):
        pdf_bytes = convert_to_pdf(sample_rtf, ".rtf")

        assert pdf_bytes.startswith(b"%PDF-")
        assert pdf_bytes.rstrip().endswith(b"%%EOF")
        assert len(pdf_bytes) > MIN_PLAUSIBLE_PDF_BYTES

    def test_converts_a_signed_rtf(self, sample_rtf):
        """The real composition: splice, then convert."""
        signed = insert_signature_rtf(sample_rtf, _png_bytes(), "image/png")

        signed_pdf = convert_to_pdf(signed, ".rtf")
        unsigned_pdf = convert_to_pdf(sample_rtf, ".rtf")

        assert signed_pdf.startswith(b"%PDF-")
        # The spliced image has to have survived into the render: a PDF that
        # silently dropped it would come out the same size as the unsigned
        # one. This is as close to "the signature is on the page" as we can
        # get without a PDF parser.
        assert len(signed_pdf) > len(unsigned_pdf)

    def test_the_suffix_is_a_hint_not_a_filter_selector(self, sample_rtf):
        """Measured behaviour, recorded so the router doesn't lean on the
        wrong thing: soffice sniffs the content and converts RTF handed to it
        as ".docx" just the same. The suffix only steers genuinely ambiguous
        input, so it is not a format check -- the sniffing in the router
        (Task 3) is what rejects a mismatched file.

        Sizes rather than bytes: LibreOffice stamps each PDF with a creation
        date and document ID, so two renders of the same input are never
        byte-identical."""
        as_docx = convert_to_pdf(sample_rtf, ".docx")
        as_rtf = convert_to_pdf(sample_rtf, ".rtf")

        assert as_docx.startswith(b"%PDF-")
        assert abs(len(as_docx) - len(as_rtf)) < 100

    def test_concurrent_conversions_both_succeed(self, sample_rtf):
        """Regression test for the isolated LibreOffice profile (Decision 7).
        Sharing the default profile, one of these two exits 1 and silently
        writes no output file."""
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(convert_to_pdf, sample_rtf, ".rtf") for _ in range(2)
            ]
            results = [future.result() for future in futures]

        for pdf_bytes in results:
            assert pdf_bytes.startswith(b"%PDF-")
            assert len(pdf_bytes) > MIN_PLAUSIBLE_PDF_BYTES


class TestFailures:
    def test_rejects_garbage_input(self):
        with pytest.raises(ConversionError):
            convert_to_pdf(b"\x00\x01\x02 this is not a document", ".rtf")

    def test_empty_input_renders_a_blank_pdf_rather_than_failing(self):
        """Also measured rather than assumed: soffice treats an empty file as
        an empty document and emits a ~1.4 KB blank PDF, exit 0. So an empty
        upload cannot be caught here and must be rejected upstream -- the
        RTF magic check in insert_signature_rtf already does that, and the
        router must keep calling it before this."""
        pdf_bytes = convert_to_pdf(b"", ".rtf")

        assert pdf_bytes.startswith(b"%PDF-")
        assert len(pdf_bytes) < MIN_PLAUSIBLE_PDF_BYTES

    def test_timeout_raises_conversion_error(self, sample_rtf):
        """A timeout short enough that no process could finish, so the test
        proves the path is wired without depending on a slow document."""
        with pytest.raises(ConversionError, match="timed out"):
            convert_to_pdf(sample_rtf, ".rtf", timeout=0.001)

    def test_missing_libreoffice_reports_unavailable(self, sample_rtf, monkeypatch):
        monkeypatch.setattr(
            "app.documents.pdf_convert.SOFFICE_BIN", "soffice-does-not-exist"
        )

        with pytest.raises(ConversionError, match="unavailable"):
            convert_to_pdf(sample_rtf, ".rtf")
