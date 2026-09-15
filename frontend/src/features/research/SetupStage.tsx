import { useEffect, useState } from "react";

import type { ApiError } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";

import { StudyDocumentSlot } from "./StudyDocumentSlot";
import { useUpdateSetupStep } from "./api";
import { SETUP_STEPS } from "./catalogue";
import type { SetupStep } from "./catalogue";
import type { Study, StudySetupStep } from "./types";

/**
 * The Setup checklist: the eight catalogue steps, each a tick, a date and
 * a note, with a many-file document slot on the three that own one.
 *
 * The catalogue is the list, not the server's rows. A study starts with
 * no step rows at all and the first write to a step creates it, so a step
 * the server has never heard of renders as "not done" rather than as
 * missing - absence is data here (Decision 6). That is why this maps over
 * `SETUP_STEPS` and looks each key up, instead of mapping over
 * `study.setup_steps`.
 *
 * Nothing here blocks anything. The checklist is a reminder list; the
 * only thing that reads it is the "Open recruitment" confirmation in
 * `StudyPage`, which names what is still outstanding and then lets the
 * user through (Decision 5).
 */

interface SetupStageProps {
  study: Study;
  showToast: (message: string) => void;
}

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as ApiError | undefined)?.detail;
  return typeof detail === "string" ? detail : fallback;
}

/** Today in the browser's timezone, as the `date` input's `YYYY-MM-DD`.
 * `toISOString` would be UTC and so a day out for an evening tick in
 * BST. */
function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

interface StepRowProps {
  studyId: number;
  step: SetupStep;
  /** The stored row, or undefined when nothing has been written yet. */
  row: StudySetupStep | undefined;
  documents: Study["documents"];
  showToast: (message: string) => void;
}

function StepRow({ studyId, step, row, documents, showToast }: StepRowProps) {
  const writeGate = useWriteGate();
  const updateStep = useUpdateSetupStep();

  const done = row?.done ?? false;
  const storedDate = row?.done_on ?? "";
  const storedNote = row?.note ?? "";

  // The date and the note are free text, so they are held locally while
  // they are being typed and committed on blur - a PATCH per keystroke
  // against an endpoint that returns the whole study would be absurd.
  // Both drafts are re-seeded when the server's value changes, so another
  // writer's edit is not left invisible under a stale draft.
  const [dateDraft, setDateDraft] = useState(storedDate);
  const [noteDraft, setNoteDraft] = useState(storedNote);
  useEffect(() => setDateDraft(storedDate), [storedDate]);
  useEffect(() => setNoteDraft(storedNote), [storedNote]);

  function patch(payload: Parameters<typeof updateStep.mutate>[0]["payload"]) {
    updateStep.mutate(
      { studyId, stepKey: step.key, payload },
      { onError: (err) => showToast(errorMessage(err, "Could not save this step")) },
    );
  }

  function handleToggle(checked: boolean) {
    // Ticking a step with no date fills in today, which is what the date
    // means nine times in ten and saves a second interaction. Unticking
    // leaves the date alone rather than clearing it: the date is still
    // the answer to "when was this done", and a mis-tick is undone by
    // editing the date, not by the checkbox silently discarding it.
    const fillDate = checked && dateDraft === "";
    if (fillDate) {
      setDateDraft(today());
    }
    patch(fillDate ? { done: checked, done_on: today() } : { done: checked });
  }

  function commitDate() {
    if (dateDraft === storedDate) {
      return;
    }
    patch({ done_on: dateDraft === "" ? null : dateDraft });
  }

  function commitNote() {
    if (noteDraft === storedNote) {
      return;
    }
    patch({ note: noteDraft === "" ? null : noteDraft });
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-ink">
          <input
            type="checkbox"
            checked={done}
            onChange={(event) => handleToggle(event.target.checked)}
            className="h-4 w-4"
            {...writeGate}
          />
          {step.label}
        </label>
        <label className="flex items-center gap-2 text-xs text-ink/50">
          Date
          <input
            type="date"
            value={dateDraft}
            onChange={(event) => setDateDraft(event.target.value)}
            onBlur={commitDate}
            aria-label={`${step.label} date`}
            className="rounded border border-border px-2 py-1 text-sm text-ink"
            {...writeGate}
          />
        </label>
      </div>

      <input
        type="text"
        value={noteDraft}
        onChange={(event) => setNoteDraft(event.target.value)}
        onBlur={commitNote}
        placeholder="Note"
        aria-label={`${step.label} note`}
        className="mt-2 w-full rounded border border-border px-2 py-1 text-sm"
        {...writeGate}
      />

      {step.hint ? <p className="mt-1 text-xs text-ink/50">{step.hint}</p> : null}

      {step.hasDocuments ? (
        <div className="mt-2">
          <StudyDocumentSlot
            studyId={studyId}
            slot={step.key}
            label={step.label}
            documents={documents.filter((document) => document.slot === step.key)}
            holdsOne={false}
            showToast={showToast}
          />
        </div>
      ) : null}
    </li>
  );
}

export function SetupStage({ study, showToast }: SetupStageProps) {
  const rows = new Map(study.setup_steps.map((row) => [row.step_key, row]));

  return (
    <div>
      <p className="text-sm text-ink/70">
        None of this blocks opening recruitment - it is a reminder list, and the
        confirmation will tell you what is still outstanding.
      </p>
      <ul className="mt-2 divide-y divide-border">
        {SETUP_STEPS.map((step) => (
          <StepRow
            key={step.key}
            studyId={study.id}
            step={step}
            row={rows.get(step.key)}
            documents={study.documents}
            showToast={showToast}
          />
        ))}
      </ul>
    </div>
  );
}
