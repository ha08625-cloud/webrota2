"""Applies Word's Restrict Editing (read-only, password-protected) to a
loaded python-docx Document by inserting a w:documentProtection element
directly into the settings part.

python-docx exposes document.settings.element as the w:settings lxml root,
so this is a single in-place mutation before one document.save() call --
no re-zipping, no [Content_Types].xml handling.

Password hashing follows the modern ISO/IEC 29500 password verifier (the
form current Word itself writes), not the legacy 32-bit hash:

    salt = os.urandom(16)
    h = sha512(salt + password.encode("utf-16-le"))
    for i in range(100_000):
        h = sha512(h + i.to_bytes(4, "little"))

w:hash and w:salt are base64 of that digest and salt respectively. This is
a deterrent matching the previously-unprotected baseline, not real
document security -- the node can be stripped by unzipping the docx. The
password itself is supplied by the caller (the router reads it from an env
var); this module stays configuration-free, only holding the fallback
default.
"""
import base64
import hashlib
import io
import os

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

# Fallback only, for callers that have nothing configured to pass in.
DEFAULT_LOCK_PASSWORD = "rota-signatures"

_SPIN_COUNT = 100_000


def _hash_password(password: str, salt: bytes) -> bytes:
    h = hashlib.sha512(salt + password.encode("utf-16-le")).digest()
    for i in range(_SPIN_COUNT):
        h = hashlib.sha512(h + i.to_bytes(4, "little")).digest()
    return h


def apply_read_only_protection(document: Document, password: str) -> None:
    """Mutate document's settings part in place so Word opens it under
    Restrict Editing (read-only), unlockable only with `password`.

    Idempotent: a pre-existing w:documentProtection element is removed
    before the new one is inserted, so re-applying replaces rather than
    duplicates it.
    """
    settings = document.settings.element

    for existing in settings.findall(qn("w:documentProtection")):
        settings.remove(existing)

    salt = os.urandom(16)
    digest = _hash_password(password, salt)

    protection = OxmlElement("w:documentProtection")
    protection.set(qn("w:edit"), "readOnly")
    protection.set(qn("w:enforcement"), "1")
    protection.set(qn("w:cryptProviderType"), "rsaAES")
    protection.set(qn("w:cryptAlgorithmClass"), "hash")
    protection.set(qn("w:cryptAlgorithmType"), "typeAny")
    protection.set(qn("w:cryptAlgorithmSid"), "14")  # SHA-512
    protection.set(qn("w:cryptSpinCount"), str(_SPIN_COUNT))
    protection.set(qn("w:hash"), base64.b64encode(digest).decode("ascii"))
    protection.set(qn("w:salt"), base64.b64encode(salt).decode("ascii"))

    settings.insert(0, protection)


def save_docx(document: Document) -> bytes:
    """Save document to bytes. Lets the router compose
    insert_signature -> apply_read_only_protection -> save_docx without
    knowing any python-docx internals."""
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
