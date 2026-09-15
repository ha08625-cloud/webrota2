"""The Research section: studies the practice is a recruitment site for.

Everything the section owns lives in this package (models, catalogue, and
later schemas and services) plus `app/api/routers/research/` -- the
domain-first layout described under "Adding a Module" in
`documentation/architecture.md`. Research is the first section built that
way, so this package is the reference for the next one, not reception.

What the section is for is worth stating once, because it decides what does
*not* go in here: the practice intranet holds the full site pack and the
patient database, and remains the record. This section is a signpost -- a
one-glance view of what stage each study is at, and a shortcut to the three
documents the team actually opens. It is not a document management system.

**No participant-identifiable data, ever.** Blank, current study templates
(the patient information leaflet, the consent form) are two of the three
reasons the section exists. Anything filled in about a real person --
recruitment or screening logs, *signed* consent forms, participant lists,
NHS numbers -- never belongs here. Delegation and training logs are staff
documents and are fine. Nothing in the schema can enforce that line; the
controls are the narrow `research` permission and the standing copy on
every study page.

What may be imported from here: the shared kernel listed under "Module
Boundaries" in the architecture doc, and this package's own internals.
Another section's model, schema, service or router is a boundary break, and
the `import-linter` contract in `backend/pyproject.toml` fails the build
when one appears.

Deliberately no re-exports: callers import the submodule they want
(`from ..research.catalogue import SETUP_STEPS`), which is also what keeps
a cross-domain reference a *direct* import edge the contracts can see.
"""
