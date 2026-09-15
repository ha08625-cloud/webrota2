import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useWriteGate } from "@/auth/AuthContext";

import { StudyFormDialog } from "./StudyFormDialog";
import { useStudies } from "./api";
import { STAGE_LABELS, STUDY_STAGE_ORDER } from "./types";
import type { Study, StudyStage } from "./types";

/**
 * The Research section's index: one row per study, grouped by stage.
 *
 * No search and no pagination, per the app-wide convention for reference
 * data - a practice runs a dozen studies. Grouping by stage and
 * collapsing Closed is the only affordance that size needs: the studies
 * somebody is working on are the ones that are not closed, and a closed
 * study is looked up rather than scanned for.
 */

/** Closed studies are a record rather than a working list: the group is
 * counted but not listed until somebody asks for it. */
const COLLAPSED_BY_DEFAULT: StudyStage = "closed";

function StudyRow({ study }: { study: Study }) {
  return (
    <li className="border-t border-border py-2 first:border-t-0">
      <Link
        to={`/research/studies/${study.id}`}
        className="text-sm font-medium text-accent hover:underline"
      >
        {study.name}
      </Link>
      <span className="ml-2 text-xs text-ink/50">
        {study.cpms_code ? `CPMS ${study.cpms_code}` : "No CPMS code"}
        {study.study_type ? ` - ${study.study_type}` : ""}
        {study.owner_name ? ` - ${study.owner_name}` : ""}
      </span>
    </li>
  );
}

export function StudiesPage() {
  const writeGate = useWriteGate();
  const navigate = useNavigate();
  const { data: studies, isLoading, isError } = useStudies();
  const [creating, setCreating] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);

  const byStage = new Map<StudyStage, Study[]>(
    STUDY_STAGE_ORDER.map((stage) => [stage, []]),
  );
  for (const study of studies ?? []) {
    byStage.get(study.stage)?.push(study);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">Studies</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
          {...writeGate}
        >
          New study
        </button>
      </div>

      <p className="mt-3 rounded border border-border bg-surface p-3 text-sm text-ink/80">
        <strong className="font-semibold">Never store participant information here.</strong>{" "}
        Blank study templates - the current patient information leaflet and the blank
        consent form - belong on a study page. Anything filled in about a real person does
        not: no recruitment or screening logs, no signed consent forms, no participant
        lists or NHS numbers. Those stay on the intranet.
      </p>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load studies.</p> : null}

      {studies && studies.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No studies yet.</p>
      ) : null}

      {studies && studies.length > 0
        ? STUDY_STAGE_ORDER.map((stage) => {
            const rows = byStage.get(stage) ?? [];
            if (rows.length === 0) {
              return null;
            }
            const collapsible = stage === COLLAPSED_BY_DEFAULT;
            const shown = !collapsible || closedOpen;
            return (
              <section key={stage} className="mt-5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink/70">{STAGE_LABELS[stage]}</h3>
                  <span className="text-xs text-ink/50">({rows.length})</span>
                  {collapsible ? (
                    <button
                      type="button"
                      onClick={() => setClosedOpen((open) => !open)}
                      aria-expanded={closedOpen}
                      className="text-xs text-accent"
                    >
                      {closedOpen ? "Hide" : "Show"}
                    </button>
                  ) : null}
                </div>
                {shown ? (
                  <ul aria-label={STAGE_LABELS[stage]} className="mt-1 rounded border border-border px-3">
                    {rows.map((study) => (
                      <StudyRow key={study.id} study={study} />
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })
        : null}

      {creating ? (
        <StudyFormDialog
          key="new"
          open
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          onCreated={(study) => navigate(`/research/studies/${study.id}`)}
        />
      ) : null}
    </div>
  );
}
