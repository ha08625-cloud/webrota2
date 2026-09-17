"""The per-user permission set: its shape, its default, and the presets.

Seven permissions replace the single `access_level` tier as the thing the
API actually consults. Four of them are levels rather than flags -- "clinical
rota, read only" is not a separate permission from "clinical rota", it is
the same permission at a lower level -- and three are booleans, because there is no meaningful read-only
view of a document generator or of user administration:

    clinical    none / read / write   the whole /clinical section
    reception   none / read / write   the whole /reception section
    research    none / read / write   the whole /research section
    nurse_rota  none / read / write   the whole /nurse-rota section
    signatures  bool                  upload, delete, apply, and VIEW
    study_eoi   bool                  the EOI autofill tool
    user_admin  bool                  user management and the audit log

For the booleans, true grants read and write on that area and false denies
both, GETs included.

This module deliberately imports nothing from FastAPI or SQLAlchemy: the
ORM model, the Pydantic schemas, the seed script and (indirectly, via the
same literal strings) the Alembic migration all need these values, and a
dependency-free module is the only place all four can share them.

DEFAULT_PERMISSIONS denies everything. That is the value a row inserted
outside the app gets, for the same reason `access_level` server-defaults to
`nurse`: an accidental viewer is recoverable, an accidental manager is a
silent security hole. It is NOT a legal state for a user created through
the API -- see `is_empty` and the schema validator that uses it.

PRESETS are starting points for the form, not roles. Nothing consults a
preset at request time; the permission set stands alone once saved. Note
what "Rota admin" does NOT include: today's `admin` tier can upload and
apply signatures, and this preset cannot. That narrowing is the point of
the feature -- a scanned signature should be available to as few logins as
possible -- but it means an existing admin login loses signature access the
moment its permissions are set.

PRESET_FOR_ACCESS_LEVEL maps the old tier onto the closest preset. It is
keyed by the enum's *value* rather than by AccessLevel itself, to keep this
module free of the ORM import; it exists for the two places that have to
translate a tier they did not choose -- the 010 migration's backfill and
seed_users.py.
"""
from __future__ import annotations

import json
from typing import Literal

# The three levels an area permission can take, in increasing order.
AccessArea = Literal["none", "read", "write"]

NONE: AccessArea = "none"
READ: AccessArea = "read"
WRITE: AccessArea = "write"

AREA_LEVELS: tuple[AccessArea, ...] = (NONE, READ, WRITE)

# Levelled permissions and boolean ones, separately: the two groups are
# validated, rendered and checked differently, and every consumer needs to
# tell them apart.
AREA_KEYS: tuple[str, ...] = ("clinical", "reception", "research", "nurse_rota")
FLAG_KEYS: tuple[str, ...] = ("signatures", "study_eoi", "user_admin")
PERMISSION_KEYS: tuple[str, ...] = AREA_KEYS + FLAG_KEYS

# The areas a section editing lock can be held on (see models/edit_lock.py).
# This is deliberately a separate tuple rather than an alias of AREA_KEYS:
# being locked out of a section means being downgraded to read-only for as
# long as someone else holds it, and only a levelled permission has a read
# level to be downgraded to -- a boolean area (signatures, study_eoi,
# user_admin) has no such state, so it cannot be locked. Aliasing AREA_KEYS
# would silently make any future levelled permission lockable, and aliasing
# in the other direction would silently stop expressing that a lockable area
# must be levelled.
#
# `research` is the case that proves the point. It is levelled, and it is
# deliberately NOT lockable: the lock exists because two people editing one
# shared rota grid overwrite each other, whereas research is a per-study
# page of small independent fields. Locking the whole section so that one
# person can tick a setup step would be worse than the collision it
# prevents.
#
# `nurse_rota` is lockable for the same reason clinical is -- it is a
# shared rota grid, and two people editing it overwrite each other -- but
# it is the first case of two locks over ONE table. The nurse rota and the
# master rota both mutate `master_rota_sessions`; what keeps the two locks
# over disjoint row sets is the nurse router's rule that a write may only
# target a doctor whose type is NURSE, and may not displace a non-nurse
# holder of a room. Without that rule the two locks would be over the same
# rows and neither would mean anything.
#
# The residual hole, recorded rather than closed: a clinical writer holding
# the clinical lock can still edit nurse rows from the Master Rota while a
# nurse holds the nurse lock. `clinical: write` is deliberately the
# superset, and closing the hole would mean master rota writes taking both
# locks -- which would let any nurse block the rota administrator out of
# their whole section.
LOCKABLE_AREAS: tuple[str, ...] = ("clinical", "reception", "nurse_rota")

# The structural half of the rule above, checked at import: a lockable area
# that is not a levelled area is a bug, whichever tuple gained the entry.
assert set(LOCKABLE_AREAS) <= set(AREA_KEYS)

PermissionSetDict = dict[str, str | bool]

DEFAULT_PERMISSIONS: PermissionSetDict = {
    "clinical": NONE,
    "reception": NONE,
    "research": NONE,
    "nurse_rota": NONE,
    "signatures": False,
    "study_eoi": False,
    "user_admin": False,
}

# The literal the users.permissions column server-defaults to, and the one
# the migration writes. sort_keys so the column default, the audit snapshot
# and the migration all render byte-identical JSON.
DEFAULT_PERMISSIONS_JSON = json.dumps(DEFAULT_PERMISSIONS, sort_keys=True)

MANAGER_PRESET = "manager"
ROTA_ADMIN_PRESET = "rota_admin"
RECEPTION_ADMIN_PRESET = "reception_admin"
DOCUMENTS_PRESET = "documents"
RESEARCH_PRESET = "research"
READ_ONLY_PRESET = "read_only"
NURSE_ROTA_PRESET = "nurse_rota"

PRESETS: dict[str, PermissionSetDict] = {
    MANAGER_PRESET: {
        "clinical": WRITE,
        "reception": WRITE,
        "research": WRITE,
        "nurse_rota": WRITE,
        "signatures": True,
        "study_eoi": True,
        "user_admin": True,
    },
    ROTA_ADMIN_PRESET: {
        "clinical": WRITE,
        "reception": WRITE,
        "research": NONE,
        "nurse_rota": WRITE,
        "signatures": False,
        "study_eoi": False,
        "user_admin": False,
    },
    # Reception's rota is built against the clinical one, so a reception
    # administrator gets clinical READ by default.
    RECEPTION_ADMIN_PRESET: {
        "clinical": READ,
        "reception": WRITE,
        "research": NONE,
        "nurse_rota": NONE,
        "signatures": False,
        "study_eoi": False,
        "user_admin": False,
    },
    DOCUMENTS_PRESET: {
        "clinical": NONE,
        "reception": NONE,
        "research": NONE,
        "nurse_rota": NONE,
        "signatures": True,
        "study_eoi": True,
        "user_admin": False,
    },
    # Exactly the research section and nothing else: the person who runs
    # studies has no business with a scanned signature, and the point of
    # the permission model is that they do not have to be given one.
    RESEARCH_PRESET: {
        "clinical": NONE,
        "reception": NONE,
        "research": WRITE,
        "nurse_rota": NONE,
        "signatures": False,
        "study_eoi": False,
        "user_admin": False,
    },
    # The three rotas at read, and research at none. A rota is something
    # everybody benefits from seeing; a study page is not.
    READ_ONLY_PRESET: {
        "clinical": READ,
        "reception": READ,
        "research": NONE,
        "nurse_rota": READ,
        "signatures": False,
        "study_eoi": False,
        "user_admin": False,
    },
    # The nursing team's login: the nurse rota and nothing else, not even
    # read on the clinical rota. It is the tightest preset in the table,
    # and it is the one the nurse_rota area exists for -- a login that can
    # edit nurse rows in the master template without being able to reach a
    # doctor's row at all.
    NURSE_ROTA_PRESET: {
        "clinical": NONE,
        "reception": NONE,
        "research": NONE,
        "nurse_rota": WRITE,
        "signatures": False,
        "study_eoi": False,
        "user_admin": False,
    },
}

# AccessLevel value -> preset name. See the module docstring.
PRESET_FOR_ACCESS_LEVEL: dict[str, str] = {
    "manager": MANAGER_PRESET,
    "admin": ROTA_ADMIN_PRESET,
    "doctor": READ_ONLY_PRESET,
    "nurse": READ_ONLY_PRESET,
}


def preset(name: str) -> PermissionSetDict:
    """A fresh copy of a preset. Never hand out the module-level dict: it
    would be shared by every user it was assigned to, and one in-place edit
    would rewrite the preset for the whole process."""
    return dict(PRESETS[name])


def default_permissions() -> PermissionSetDict:
    """A fresh deny-everything set; see `preset` on why this copies."""
    return dict(DEFAULT_PERMISSIONS)


def is_empty(permissions: PermissionSetDict) -> bool:
    """True when the set grants nothing at all.

    An empty set is refused on save: it is never what anyone means, and a
    login that can reach nothing but its own password form is
    indistinguishable from a bug. Deactivating the user is the way to say
    "no access".
    """
    if any(permissions.get(key, NONE) != NONE for key in AREA_KEYS):
        return False
    return not any(bool(permissions.get(key)) for key in FLAG_KEYS)


EMPTY_PERMISSIONS_MESSAGE = (
    "A user needs at least one permission. To remove someone's access "
    "entirely, deactivate the user instead."
)


def can_read_area(permissions: PermissionSetDict, area: str) -> bool:
    """True when `permissions` admits safe methods on `area`.

    The one place the levelled/boolean distinction is resolved, so callers
    that only want the answer do not each restate it: a levelled area is
    readable at READ or WRITE, a boolean area is readable exactly when it
    is set (there is no read-only view of a document generator -- see the
    module docstring). api/deps.py's gates are written in terms of these
    two functions, and api/routers/locks.py reuses them for an area it
    resolves per request rather than at registration time.
    """
    granted = permissions.get(area)
    if area in AREA_KEYS:
        return granted in (READ, WRITE)
    return bool(granted)


def can_write_area(permissions: PermissionSetDict, area: str) -> bool:
    """True when `permissions` admits unsafe methods on `area`.

    Levelled areas need WRITE; a boolean area grants both halves or
    neither, so it is the same test as `can_read_area`. Named after the
    frontend's `canWriteArea`, which implements the same rule -- there is
    no codegen between the two, so the pair is kept in step by hand.
    """
    granted = permissions.get(area)
    if area in AREA_KEYS:
        return granted == WRITE
    return bool(granted)
