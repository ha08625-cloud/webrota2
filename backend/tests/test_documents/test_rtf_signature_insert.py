"""Tests for app.documents.rtf_signature_insert.insert_signature_rtf.

Images are generated in-test (bytes in, bytes out, matching the module's
contract). The RTF side uses a committed fixture,
tests/fixtures/certificate_sample.rtf, because the properties under test --
the decoy "Signature;" style names, the pre-existing crest \\pngblip, the
cosmetic line break between the label and its \\par -- are exactly the ones
a hand-rolled minimal string would omit.
"""
import re
import struct
import zlib
from pathlib import Path

import pytest

from app.documents.errors import DocumentFormatError
from app.documents.rtf_signature_insert import insert_signature_rtf

SAMPLE_PATH = Path(__file__).parent.parent / "fixtures" / "certificate_sample.rtf"

ANCHOR_RE = re.compile(rb"Signature[\s]*\\par[\s]*\}")


@pytest.fixture
def sample_rtf() -> bytes:
    return SAMPLE_PATH.read_bytes()


def _png_bytes(width: int = 200, height: int = 80) -> bytes:
    """A structurally valid solid-colour RGB PNG of the requested size."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + b"\x10\x20\x30" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def _jpeg_bytes(width: int = 200, height: int = 80) -> bytes:
    """A minimal JPEG far enough along to be parsed for dimensions: SOI,
    JFIF APP0 (carrying the DPI), SOF0 (carrying the size), EOI."""
    app0 = (
        b"\xff\xe0"
        + struct.pack(">H", 16)
        + b"JFIF\x00"
        + b"\x01\x02"
        + b"\x01"  # density units: dots per inch
        + struct.pack(">HH", 72, 72)
        + b"\x00\x00"
    )
    sof0 = (
        b"\xff\xc0"
        + struct.pack(">H", 11)
        + b"\x08"
        + struct.pack(">HH", height, width)
        + b"\x01"
        + b"\x01\x11\x00"
    )
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


class TestInsertSignatureRtf:
    def test_inserts_one_picture_into_the_sample(self, sample_rtf):
        result = insert_signature_rtf(sample_rtf, _png_bytes(), "image/png")

        assert result.startswith(rb"{\rtf1")
        # The sample already carries one \pngblip (the crest), so the
        # splice must take the count from one to two.
        assert sample_rtf.count(rb"\pngblip") == 1
        assert result.count(rb"\pngblip") == 2
        assert rb"\pict" in result

    def test_inserts_after_the_anchor(self, sample_rtf):
        image_bytes = _png_bytes()
        result = insert_signature_rtf(sample_rtf, image_bytes, "image/png")

        anchor_end = ANCHOR_RE.search(result).end()
        assert result.index(b"{{\\pict") == anchor_end

    def test_insertion_is_in_the_body_not_the_stylesheet(self, sample_rtf):
        """Regression test for the anchor's \\par (Decision 3): a bare
        "Signature" search hits the stylesheet's "Signature;" and
        "E-mail Signature;" style names first. This is what stops a future
        simplification of the anchor regex from splicing into the style
        table."""
        result = insert_signature_rtf(sample_rtf, _png_bytes(), "image/png")

        splice_offset = result.index(b"{{\\pict")
        last_style_name = result.rfind(b"E-mail Signature;")

        assert last_style_name != -1, "fixture no longer exercises the decoy"
        assert splice_offset > last_style_name

    def test_is_a_pure_insertion(self, sample_rtf):
        """Everything either side of the splice point survives byte for
        byte -- nothing in the original document is rewritten."""
        result = insert_signature_rtf(sample_rtf, _png_bytes(), "image/png")

        anchor_end = ANCHOR_RE.search(sample_rtf).end()
        inserted_length = len(result) - len(sample_rtf)

        assert result[:anchor_end] == sample_rtf[:anchor_end]
        assert result[anchor_end + inserted_length :] == sample_rtf[anchor_end:]

    def test_embeds_the_image_bytes_as_hex(self, sample_rtf):
        image_bytes = _png_bytes()
        result = insert_signature_rtf(sample_rtf, image_bytes, "image/png")

        assert image_bytes.hex().encode("ascii") in result

    def test_scales_to_four_centimetres_preserving_aspect_ratio(self, sample_rtf):
        result = insert_signature_rtf(sample_rtf, _png_bytes(200, 80), "image/png")

        # 4 cm = 2268 twips wide; height scales by 80/200.
        assert rb"\picwgoal2268" in result
        assert rb"\pichgoal907" in result

    def test_jpeg_uses_the_jpeg_blip(self, sample_rtf):
        result = insert_signature_rtf(sample_rtf, _jpeg_bytes(), "image/jpeg")

        assert rb"\jpegblip" in result
        assert result.count(rb"\pngblip") == 1  # only the crest

    def test_image_header_wins_over_a_wrong_content_type(self, sample_rtf):
        """The stored content type is a hint; the file header is
        authoritative."""
        result = insert_signature_rtf(sample_rtf, _png_bytes(), "image/jpeg")

        assert rb"\jpegblip" not in result
        assert result.count(rb"\pngblip") == 2


class TestRejectsBadInput:
    @pytest.mark.parametrize(
        "rtf_bytes",
        [
            pytest.param(b"PK\x03\x04\x14\x00\x00\x00", id="docx"),
            pytest.param(b"\x7f\x45\x4c\x46\x02\x01\x01", id="random-bytes"),
            pytest.param(b"", id="empty"),
            pytest.param(b"Signature\\par }", id="plain-text-with-anchor"),
        ],
    )
    def test_rejects_non_rtf(self, rtf_bytes):
        with pytest.raises(DocumentFormatError, match="not a valid .rtf"):
            insert_signature_rtf(rtf_bytes, _png_bytes(), "image/png")

    def test_accepts_a_leading_bom_and_whitespace(self, sample_rtf):
        prefixed = b"\xef\xbb\xbf\r\n  " + sample_rtf

        result = insert_signature_rtf(prefixed, _png_bytes(), "image/png")

        assert result.count(rb"\pngblip") == 2

    def test_rejects_a_missing_anchor(self, sample_rtf):
        # Rename the body label, leaving the stylesheet decoys in place.
        without_anchor = ANCHOR_RE.sub(b"Endorsement\\\\par }", sample_rtf)
        assert ANCHOR_RE.search(without_anchor) is None

        with pytest.raises(DocumentFormatError, match="Could not find the Signature"):
            insert_signature_rtf(without_anchor, _png_bytes(), "image/png")

    def test_rejects_a_duplicated_anchor(self, sample_rtf):
        match = ANCHOR_RE.search(sample_rtf)
        duplicated = (
            sample_rtf[: match.end()]
            + sample_rtf[match.start() : match.end()]
            + sample_rtf[match.end() :]
        )

        with pytest.raises(DocumentFormatError, match="2 times"):
            insert_signature_rtf(duplicated, _png_bytes(), "image/png")

    @pytest.mark.parametrize(
        "image_bytes",
        [
            pytest.param(b"not an image at all", id="garbage"),
            pytest.param(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32, id="truncated-png"),
            pytest.param(b"", id="empty"),
        ],
    )
    def test_rejects_an_unreadable_image(self, sample_rtf, image_bytes):
        with pytest.raises(DocumentFormatError, match="signature image"):
            insert_signature_rtf(sample_rtf, image_bytes, "image/png")

    def test_rejects_an_unsupported_image_format(self, sample_rtf):
        # A GIF: python-docx reads it happily, but RTF has no gifblip and
        # the upload endpoint never stores one.
        gif_bytes = (
            b"GIF89a"
            + struct.pack("<HH", 1, 1)
            + b"\x00\x00\x00"
            + b"\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b"
        )

        with pytest.raises(DocumentFormatError, match="PNG or JPEG"):
            insert_signature_rtf(sample_rtf, gif_bytes, "image/gif")
