"""The skip guard for tests that shell out to LibreOffice.

`shutil.which("soffice")` is not the question these tests need answered.
`libreoffice-core` puts soffice on PATH without the Writer module, and in
that state every conversion fails with a misleading "source file could not
be loaded" -- so a presence check passes and the tests then fail for a
reason that has nothing to do with the code. CI's install step already
warns about exactly this trap (see .github/workflows/ci.yml); this module
is what makes the guard agree with it.

So the guard is a capability probe: convert a tiny RTF for real, once per
pytest session, and skip only if that fails. RTF specifically, because
RTF -> PDF is the conversion the guarded tests actually perform, and it is
the pair of filters (Writer's RTF import, the PDF export) whose absence
causes the misleading failure.

The probe deliberately does NOT call app.documents.pdf_convert: a guard
built on the code under test would turn a real regression in that code into
a suite-wide skip, which is the one failure mode worse than a red test. It
borrows SOFFICE_BIN from there because that is configuration, not
behaviour.

Cost is one soffice launch, cached for the session, and only paid when a
module carrying the marker is collected -- an unrelated `pytest
tests/test_engine/` never launches it. Where Writer is missing the probe
fails in well under a second, because soffice gives up before it renders
anything.

A probe can be wrong in a way a PATH check cannot: if it ever returned
False on CI, the guarded tests would skip and the build would go green
having tested nothing. REQUIRE_SOFFICE closes that off -- CI sets it, and
with it set a failed probe is a collection error instead of a skip. It is
the machine-checked version of the warning in ci.yml.
"""
import functools
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from app.documents.pdf_convert import SOFFICE_BIN

# A complete RTF document in one line. Small enough that the probe measures
# the filters rather than the render.
_PROBE_RTF = rb"{\rtf1\ansi probe}"

# Generous: a cold first launch builds a user profile before it converts
# anything. A wedged soffice must not hang collection, so it is bounded.
_PROBE_TIMEOUT_SECONDS = 90


@functools.cache
def soffice_can_convert() -> bool:
    """Whether this machine can actually turn an RTF into a PDF.

    Cached, so the probe runs at most once per pytest session. Any failure
    -- missing binary, missing Writer, timeout, a soffice that exits 0
    having written nothing (it does that on load failures) -- reads as "no".
    """
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        source = work / "probe.rtf"
        source.write_bytes(_PROBE_RTF)
        try:
            subprocess.run(
                [
                    SOFFICE_BIN,
                    "--headless",
                    "--norestore",
                    f"-env:UserInstallation=file://{work / 'profile'}",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(work),
                    str(source),
                ],
                capture_output=True,
                timeout=_PROBE_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        # Not the exit code: soffice reports a load failure on stdout and
        # still exits 0. The output file is the only honest signal.
        return (work / "probe.pdf").is_file()


_UNAVAILABLE_REASON = (
    "LibreOffice cannot convert documents here. If soffice is on PATH, the "
    "Writer module is probably missing -- install libreoffice-writer rather "
    "than libreoffice-core."
)

if os.environ.get("REQUIRE_SOFFICE") and not soffice_can_convert():
    raise RuntimeError(
        f"REQUIRE_SOFFICE is set but the conversion probe failed. "
        f"{_UNAVAILABLE_REASON}"
    )

requires_soffice = pytest.mark.skipif(
    not soffice_can_convert(), reason=_UNAVAILABLE_REASON
)
