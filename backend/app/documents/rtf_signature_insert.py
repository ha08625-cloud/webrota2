"""Splices a signature image into an RTF certificate under the "Signature" label.

The RTF path is splice-then-convert: this module returns modified RTF, which
only LibreOffice ever reads before it becomes a PDF. The intermediate is
never the deliverable, so the generated \\pict group only has to satisfy
LibreOffice's RTF reader, not Word's.

Two deliberate constraints:

Bytes throughout, never str. RTF is nominally 7-bit ASCII with escapes, but
real EMIS exports carry raw high bytes, and a decode/encode round trip risks
corrupting them.

Splice, do not parse. The insertion is a pure string operation between two
already-balanced groups; an RTF group-tree parser would be disproportionate
for an edit this narrow. Every assumption is asserted and a violation raises
DocumentFormatError with a message aimed at a non-technical admin -- the
same loud-failure philosophy as signature_insert.py's column-count check, on
the view that a wrong-but-silent insertion into a medico-legal document is
worse than a visible failure.
"""
import re

from docx.image.exceptions import (
    InvalidImageStreamError,
    UnexpectedEndOfFileError,
    UnrecognizedImageError,
)
from docx.image.image import Image

from .errors import DocumentFormatError

# The anchor is the "Signature" label *plus* its paragraph break, and that
# \par is load-bearing. A bare search for "Signature" matches three times in
# a real export, and the first two hits are the built-in style names
# "Signature;" and "E-mail Signature;" in the RTF stylesheet and latent style
# table -- splicing at the first hit would inject the image into the style
# definitions, not the document body. Those entries are followed by ";" and
# the next style's \lsd* flags, never by \par.
#
# The [\s]* tolerances matter because RTF line breaks are cosmetic: Word wraps
# its output at roughly 255 characters, so the exact position of the \r\n
# around the \par is not stable across exports and must not be hard-coded.
_ANCHOR_RE = re.compile(rb"Signature[\s]*\\par[\s]*\}")

# The "Date" cell to the right of the Signature cell. This anchor cannot
# mirror _ANCHOR_RE, because the two labels are not terminated the same way
# in a real export:
#
#   {FMT Signature\par }{FMT \cell }{FMT Date\cell }
#
# The Signature cell holds a second, empty paragraph, so its label paragraph
# ends with an explicit \par and the \cell arrives in a later run. The Date
# cell holds one paragraph only, so \cell terminates the label paragraph
# directly and no \par is ever written. An earlier version of this module
# looked for "Date...\par" and therefore never matched a real certificate.
#
# Both terminators are accepted and captured, because either is legal Word
# output for a cell's last paragraph, and the insertion (below) is the same
# shape in both cases.
#
# The leading \{([^{}]*?) captures the label run's own character formatting,
# which the inserted line reuses so it picks up the template's font and size
# rather than hard-coding them. Anchoring on the run's opening brace also
# rules out the "Date;" style names in the stylesheet and latent style table
# by construction: those are followed by ";", never by \par or \cell.
_DATE_ANCHOR_RE = re.compile(rb"\{([^{}]*?)Date[\s]*(\\par|\\cell)[\s]*\}")

# Bold, in both its Latin (\b) and associated/complex-script (\ab) forms, as
# whole control words -- the trailing lookahead stops \b matching inside
# \brdrw and keeps \b0 (bold *off*) intact. Stripped from the formatting the
# inserted date inherits, so the date is not bold like its label.
_BOLD_RE = re.compile(rb"\\a?b(?![a-zA-Z0-9])")

# Signature images are validated as JPEG or PNG at upload time, so no
# re-encoding is needed -- the stored bytes are hex-encoded as-is under the
# matching blip keyword.
_BLIP_BY_CONTENT_TYPE = {
    "image/png": b"pngblip",
    "image/jpeg": b"jpegblip",
}

# Rendered width, mirroring the docx module's fixed Cm(4): 4 cm x 567
# twips/cm.
_TARGET_WIDTH_TWIPS = 2268

# Fallback for images whose header declares no (or a zero) DPI, so the
# native-size calculation never divides by zero.
_FALLBACK_DPI = 96

_HUNDREDTHS_MM_PER_INCH = 2540


def insert_signature_rtf(
    rtf_bytes: bytes, image_bytes: bytes, content_type: str
) -> bytes:
    """Insert image_bytes as a picture directly beneath the "Signature"
    label in rtf_bytes, and return the modified RTF bytes.

    content_type is the signature's stored MIME type ("image/png" or
    "image/jpeg"); where it disagrees with the type parsed from the image
    header, the header wins.

    Raises DocumentFormatError if rtf_bytes is not RTF, if the Signature
    anchor is missing or appears more than once (the template has changed
    and positional assumptions are no longer safe), or if image_bytes is
    not a readable PNG or JPEG.
    """
    _require_rtf(rtf_bytes)

    matches = _ANCHOR_RE.findall(rtf_bytes)
    if not matches:
        raise DocumentFormatError(
            "Could not find the Signature label in this document"
        )
    if len(matches) > 1:
        raise DocumentFormatError(
            f"Found the Signature label {len(matches)} times in this document, "
            "expected exactly one -- the certificate template may have changed"
        )

    match = _ANCHOR_RE.search(rtf_bytes)
    picture = _build_picture_group(image_bytes, content_type)

    return rtf_bytes[: match.end()] + picture + rtf_bytes[match.end() :]


def insert_date_rtf(rtf_bytes: bytes, date_text: str) -> bytes:
    """Insert date_text as a new paragraph directly beneath the "Date"
    label in rtf_bytes, and return the modified RTF bytes.

    The new paragraph inherits the label's own character formatting minus
    its bold, so the date picks up whatever font and size the template uses
    rather than hard-coding one.

    Intended to run after insert_signature_rtf, on its output, splicing at
    a separate anchor -- so this is called as a second pass, not folded
    into the same function.

    Raises DocumentFormatError if rtf_bytes is not RTF, or if the Date
    anchor is missing or appears more than once.
    """
    _require_rtf(rtf_bytes)

    matches = _DATE_ANCHOR_RE.findall(rtf_bytes)
    if not matches:
        raise DocumentFormatError("Could not find the Date label in this document")
    if len(matches) > 1:
        raise DocumentFormatError(
            f"Found the Date label {len(matches)} times in this document, "
            "expected exactly one -- the certificate template may have changed"
        )

    match = _DATE_ANCHOR_RE.search(rtf_bytes)
    formatting, terminator = match.group(1), match.group(2)

    # The label run is rewritten rather than appended to: its terminator moves
    # onto the new run, so the label's paragraph now ends with \par and the
    # date's paragraph ends with whatever ended the cell before. The result is
    # two paragraphs where there was one, and the cell still closes exactly
    # once.
    replacement = (
        b"{"
        + formatting
        + b"Date\\par }{"
        + _delimited(_BOLD_RE.sub(b"", formatting))
        + _escape_rtf(date_text)
        + terminator
        + b" }"
    )

    return rtf_bytes[: match.start()] + replacement + rtf_bytes[match.end() :]


def _delimited(formatting: bytes) -> bytes:
    """Guarantee a delimiter between the trailing control word of formatting
    and the text that follows it. Word writes one, but it is not required to:
    "\\fs20" abutting a date would otherwise be read as "\\fs2004", silently
    resizing the text and eating the first digits."""
    if not formatting or formatting[-1:].isspace():
        return formatting
    return formatting + b" "


def _escape_rtf(text: str) -> bytes:
    """Escape the three characters RTF treats as markup. The caller's date is
    generated, not user-supplied, so this is belt and braces rather than a
    sanitiser."""
    escaped = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    return escaped.encode("ascii")


def _require_rtf(rtf_bytes: bytes) -> None:
    """Validate the RTF magic. Some producers emit a UTF-8 BOM or leading
    whitespace before the opening group, so check a stripped copy."""
    head = rtf_bytes[:64]
    if head.startswith(b"\xef\xbb\xbf"):
        head = head[3:]
    if not head.lstrip().startswith(rb"{\rtf1"):
        raise DocumentFormatError("File is not a valid .rtf document")


def _build_picture_group(image_bytes: bytes, content_type: str) -> bytes:
    """Build the RTF group that renders image_bytes at 4 cm wide."""
    try:
        image = Image.from_blob(image_bytes)
    # python-docx has no common base for these: an unknown format raises
    # UnrecognizedImageError, but a truncated or malformed file of a known
    # format raises one of the other two.
    except (
        UnrecognizedImageError,
        InvalidImageStreamError,
        UnexpectedEndOfFileError,
    ):
        raise DocumentFormatError(
            "The stored signature image could not be read"
        )

    # The header is authoritative over the caller's stored content type.
    blip = _BLIP_BY_CONTENT_TYPE.get(image.content_type)
    if blip is None:
        blip = _BLIP_BY_CONTENT_TYPE.get(content_type)
    if blip is None:
        raise DocumentFormatError(
            "The stored signature image must be a PNG or JPEG"
        )

    px_width, px_height = image.px_width, image.px_height
    if not px_width or not px_height:
        raise DocumentFormatError(
            "The stored signature image has no usable dimensions"
        )

    horz_dpi = image.horz_dpi or _FALLBACK_DPI
    vert_dpi = image.vert_dpi or _FALLBACK_DPI

    # picw/pich are the image's *native* size in hundredths of a millimetre,
    # from the header's real DPI; picwgoal/pichgoal are the rendered size in
    # twips, scaled to a fixed 4 cm width.
    picw = round(px_width / horz_dpi * _HUNDREDTHS_MM_PER_INCH)
    pich = round(px_height / vert_dpi * _HUNDREDTHS_MM_PER_INCH)
    picwgoal = _TARGET_WIDTH_TWIPS
    pichgoal = round(_TARGET_WIDTH_TWIPS * px_height / px_width)

    # The hex payload is emitted on a single line. Word wraps it at 128
    # columns, but long lines are legal RTF and LibreOffice reads them.
    return (
        b"{{\\pict"
        + f"\\picw{picw}\\pich{pich}".encode("ascii")
        + f"\\picwgoal{picwgoal}\\pichgoal{pichgoal}".encode("ascii")
        + b"\\"
        + blip
        + b" "
        + image_bytes.hex().encode("ascii")
        + b"}\\par }"
    )
