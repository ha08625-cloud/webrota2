"""Research router package. Each module exposes a module-level `router: APIRouter`.

Both modules share the `/research/studies` prefix -- `studies.py` owns the
study itself, its stage transitions and its setup checklist, `documents.py`
owns the files hanging off it. Two APIRouters under one prefix is
deliberate: the document endpoints are a separate concern with their own
upload rules, and splitting them keeps either file readable.
"""
