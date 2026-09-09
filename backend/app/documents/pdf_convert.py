"""Converts a document (RTF or DOCX bytes) to PDF via headless LibreOffice.

The RTF path is splice-then-convert: the modified RTF produced by
rtf_signature_insert is a temp artifact that only LibreOffice ever reads, and
this module is the step that turns it into the deliverable.

Two things here are load-bearing rather than tuning:

Every invocation gets its own LibreOffice profile. Two concurrent soffice
processes sharing the default profile were measured to collide, and the loser
exited 1 having *silently written no output file* -- so a request would have
failed with no diagnosis. -env:UserInstallation gives each run a private
profile in the same temp directory as its input, which costs about 1.2 s and
550 KB and removes the need for any mutex. tests/test_documents/
test_pdf_convert.py::TestConvertToPdf::test_concurrent_conversions_both_succeed
is the regression test for this and fails without it.

Spawning a whole soffice process per document is the worst case for latency
and it is still cheap enough not to need a resident instance: measured on the
real certificate sample, 1.5 s with a fresh profile and 1.3 s after, peaking
around 215 MB of transient RSS. unoserver would cut that to roughly 0.3-0.8 s
at the cost of a second long-running process to supervise; revisit only if
volume changes.

A converter failure is ours, not the user's. DocumentFormatError means "your
file is wrong" and the router maps it to 422; everything raised here is
ConversionError, mapped to 502, so a broken or missing LibreOffice is never
reported to an admin as a bad upload.
"""
import os
import subprocess
import tempfile
from pathlib import Path

from .errors import ConversionError

# Overridable so a container with LibreOffice somewhere unusual can be pointed
# at it without a code change.
SOFFICE_BIN = os.environ.get("SOFFICE_BIN", "soffice")

# Generous next to a measured ~1.3 s, but an explicit value is mandatory: a
# wedged soffice must never hold a request thread open indefinitely.
DEFAULT_TIMEOUT_SECONDS = 60.0

# How much of soffice's output to carry into the exception message. Enough to
# diagnose from the log, short enough not to dump a screenful.
_OUTPUT_TAIL_CHARS = 500

_UNAVAILABLE_MESSAGE = (
    "PDF conversion is unavailable on this server. Please contact support."
)
_FAILED_MESSAGE = "Could not convert this document to PDF"


def convert_to_pdf(
    doc_bytes: bytes,
    suffix: str = ".rtf",
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> bytes:
    """Render doc_bytes to PDF and return the PDF bytes.

    suffix is the extension given to the temporary input file (".rtf" or
    ".docx"). It is a hint only: soffice sniffs the content and converts an
    RTF handed to it as ".docx" identically, so passing the wrong suffix is
    not a format check -- callers must validate the format themselves.

    Raises ConversionError if LibreOffice is missing, exits non-zero, exceeds
    timeout, or produces no readable PDF.
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        input_path = temp_path / f"document{suffix}"
        out_dir = temp_path / "out"
        profile_dir = temp_path / "profile"
        input_path.write_bytes(doc_bytes)
        out_dir.mkdir()
        profile_dir.mkdir()

        command = [
            SOFFICE_BIN,
            f"-env:UserInstallation={profile_dir.as_uri()}",
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            str(out_dir),
            str(input_path),
        ]

        try:
            result = subprocess.run(
                command,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            raise ConversionError(_UNAVAILABLE_MESSAGE) from exc
        except subprocess.TimeoutExpired as exc:
            raise ConversionError(
                f"{_FAILED_MESSAGE}: conversion timed out after {timeout:g}s"
            ) from exc

        if result.returncode != 0:
            raise ConversionError(
                f"{_FAILED_MESSAGE}: the converter exited with code "
                f"{result.returncode}. {_describe_output(result)}"
            )

        # A zero exit with no output file is a real shape, not a defensive
        # branch -- it is exactly what the profile collision
        # produced. soffice also reports some load failures this way.
        outputs = list(out_dir.glob("*.pdf"))
        if not outputs:
            raise ConversionError(
                f"{_FAILED_MESSAGE}: the converter produced no output. "
                f"{_describe_output(result)}"
            )

        pdf_bytes = outputs[0].read_bytes()

    if not pdf_bytes.startswith(b"%PDF-"):
        raise ConversionError(
            f"{_FAILED_MESSAGE}: the converter produced a file that is not a PDF"
        )
    return pdf_bytes


def _describe_output(result: subprocess.CompletedProcess) -> str:
    """The tail of soffice's output, for the log. soffice is terse and its
    messages are about the document rather than the server's internals, so
    this is safe to show an admin -- but the caller's own wording, not this,
    is what tells them what to do about it."""
    tail = (result.stderr or result.stdout or b"").decode("utf-8", "replace").strip()
    if not tail:
        return "It gave no explanation."
    return f"It reported: {tail[-_OUTPUT_TAIL_CHARS:]}"
