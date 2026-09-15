import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import type { ApiError } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { ToastDisplay, useToast } from "@/components/Toast";

import { RecruitmentOpenStage } from "./RecruitmentOpenStage";
import { SetupStage } from "./SetupStage";
import { StudyDocumentSlot } from "./StudyDocumentSlot";
import { StudyFormDialog } from "./StudyFormDialog";
import { useAdvanceStudy, useDeleteStudy, useRevertStudy, useStudy } from "./api";
import { KEY_DOCUMENT_SLOTS, SETUP_STEPS } from "./catalogue";
import { STAGE_LABELS, STUDY_STAGE_ORDER } from "./types";
import type { Study, StudyStage } from "./types";

/**
 * One study: the persistent header, the stage, and the body for whichever
 * stage the study is in.
 *
 * The header is rendered here rather than by each stage body (Decision
 * 13). The six fields, the contacts and the three key documents are the
 * whole reason the section exists, so they are visible in every stage,
 * and no stage body has to remember to draw them. Setup's data is
 * *hidden* in later stages, never deleted - which is what makes moving a
 * stage backwards safe rather than destructive.
 *
 * The transition confirmation lives here too, for the same reason: it is
 * the header's control, and the outstanding-steps list it shows comes
 * from data this page already holds. The checklist never blocks a
 * transition - a hard gate on eight ticks teaches people to
 * tick things they have not done - so the dialog names what is
 * outstanding and then lets the user through.
 */

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as ApiError | undefined)?.detail;
  return typeof detail === "string" ? detail : fallback;
}

function neighbourStage(stage: StudyStage, offset: number): StudyStage | null {
  const index = STUDY_STAGE_ORDER.indexOf(stage);
  const target = index + offset;
  return target >= 0 && target < STUDY_STAGE_ORDER.length ? STUDY_STAGE_ORDER[target] : null;
}

/** Steps with no row, or a row that is not ticked. A missing row is "not
 * done" - absence is data (see research/catalogue.py). */
function outstandingSteps(study: Study): string[] {
  const done = new Set(
    study.setup_steps.filter((step) => step.done).map((step) => step.step_key),
  );
  return SETUP_STEPS.filter((step) => !done.has(step.key)).map((step) => step.label);
}

function StageIndicator({ stage }: { stage: StudyStage }) {
  const current = STUDY_STAGE_ORDER.indexOf(stage);
  return (
    <ol aria-label="Stage" className="flex flex-wrap gap-1 text-xs">
      {STUDY_STAGE_ORDER.map((candidate, index) => {
        const isCurrent = candidate === stage;
        return (
          <li
            key={candidate}
            aria-current={isCurrent ? "step" : undefined}
            className={`rounded px-2 py-0.5 ${
              isCurrent
                ? "bg-accent font-medium text-white"
                : index < current
                  ? "bg-surface text-ink/70"
                  : "text-ink/40"
            }`}
          >
            {STAGE_LABELS[candidate]}
          </li>
        );
      })}
    </ol>
  );
}

interface TransitionDialogProps {
  study: Study;
  direction: "advance" | "revert";
  onOpenChange: (open: boolean) => void;
  showToast: (message: string) => void;
}

function TransitionDialog({ study, direction, onOpenChange, showToast }: TransitionDialogProps) {
  const advance = useAdvanceStudy();
  const revert = useRevertStudy();
  const target = neighbourStage(study.stage, direction === "advance" ? 1 : -1);
  const outstanding = study.stage === "setup" && direction === "advance" ? outstandingSteps(study) : [];

  const isPending = advance.isPending || revert.isPending;

  function handleConfirm() {
    const mutation = direction === "advance" ? advance : revert;
    mutation.mutate(study.id, {
      onSuccess: () => onOpenChange(false),
      onError: (err) => showToast(errorMessage(err, "Could not move this study")),
    });
  }

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {direction === "advance"
              ? `Move to ${target ? STAGE_LABELS[target] : "the next stage"}?`
              : `Move back to ${target ? STAGE_LABELS[target] : "the previous stage"}?`}
          </Dialog.Title>

          {direction === "advance" ? (
            <p className="mt-2 text-sm text-ink/70">
              {study.name} moves on from {STAGE_LABELS[study.stage]}.
            </p>
          ) : (
            <p className="mt-2 text-sm text-ink/70">
              {study.name} goes back to {target ? STAGE_LABELS[target] : "the previous stage"}.
              Nothing is deleted - the page returns to how it was, so this is safe to use
              for a misclick.
            </p>
          )}

          {outstanding.length > 0 ? (
            <div className="mt-3 rounded border border-border p-2">
              <p className="text-sm font-medium">Still outstanding in setup:</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-ink/70">
                {outstanding.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink/50">
                These do not block the move - tick them when they are actually done.
              </p>
            </div>
          ) : null}

          <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
            <Dialog.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Dialog.Close>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isPending}
              className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              {direction === "advance" ? "Move on" : "Move back"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HeaderField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink/50">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * The stage bodies. Setup is built; the recruitment, recruitment-finished
 * and close-down bodies are a later plan, written once the setup page has
 * been used in anger, and until then all three share one stub. The stub
 * keeps the page shape - header above, one body below - settled before
 * anything fills it.
 */
function StageBody({
  study,
  showToast,
}: {
  study: Study;
  showToast: (message: string) => void;
}) {
  if (study.stage === "setup") {
    return <SetupStage study={study} showToast={showToast} />;
  }
  return <RecruitmentOpenStage stage={study.stage} />;
}

export function StudyPage() {
  const params = useParams();
  const navigate = useNavigate();
  const writeGate = useWriteGate();
  const { toast, showToast } = useToast();

  const parsedId = Number(params.studyId);
  const studyId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
  const { data: study, isLoading, isError, error } = useStudy(studyId);

  const deleteStudy = useDeleteStudy();
  const [editing, setEditing] = useState(false);
  const [transition, setTransition] = useState<"advance" | "revert" | null>(null);

  if (studyId === null) {
    return <p className="text-sm text-red-700">That is not a study.</p>;
  }

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading...</p>;
  }

  if (isError || !study) {
    const status = (error as ApiError | undefined)?.status;
    return (
      <div>
        <p className="text-sm text-red-700">
          {status === 404 ? "That study no longer exists." : "Could not load this study."}
        </p>
        <Link to="/research" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to studies
        </Link>
      </div>
    );
  }

  const canAdvance = neighbourStage(study.stage, 1) !== null;
  const canRevert = neighbourStage(study.stage, -1) !== null;

  function handleDelete() {
    if (!study) {
      return;
    }
    const confirmed = window.confirm(
      `Delete "${study.name}" and everything on this page? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }
    deleteStudy.mutate(study.id, {
      onSuccess: () => navigate("/research"),
      onError: (err) => showToast(errorMessage(err, "Could not delete this study")),
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/research" className="text-sm text-accent hover:underline">
        Back to studies
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink">{study.name}</h2>
          <div className="mt-1">
            <StageIndicator stage={study.stage} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
            {...writeGate}
          >
            Edit details
          </button>
          {canRevert ? (
            <button
              type="button"
              onClick={() => setTransition("revert")}
              className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
              {...writeGate}
            >
              Move back a stage
            </button>
          ) : null}
          {canAdvance ? (
            <button
              type="button"
              onClick={() => setTransition("advance")}
              className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
              {...writeGate}
            >
              {study.stage === "setup" ? "Open recruitment" : "Move on a stage"}
            </button>
          ) : null}
        </div>
      </div>

      <section className="mt-4 rounded border border-border p-3">
        <h3 className="text-sm font-semibold text-ink/70">Study details</h3>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <HeaderField label="CPMS code">{study.cpms_code ?? "-"}</HeaderField>
          <HeaderField label="Study type">{study.study_type ?? "-"}</HeaderField>
          <HeaderField label="Owner">{study.owner_name ?? "-"}</HeaderField>
          <HeaderField label="Study website">
            {study.website_url ? (
              /* rel="noopener noreferrer" on every outbound link here; the
                 http/https rule that keeps a javascript: URL out of this
                 href is enforced server-side and mirrored in the form. */
              <a
                href={study.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {study.website_url}
              </a>
            ) : (
              "-"
            )}
          </HeaderField>
        </dl>

        <h4 className="mt-4 text-sm font-semibold text-ink/70">Contacts</h4>
        {study.contacts.length === 0 ? (
          <p className="mt-1 text-sm text-ink/50">No contacts recorded.</p>
        ) : (
          <table aria-label="Contacts" className="mt-1 w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-ink/50">
                <th className="py-1 pr-3 font-medium">Name</th>
                <th className="py-1 pr-3 font-medium">Role</th>
                <th className="py-1 pr-3 font-medium">Email</th>
                <th className="py-1 font-medium">Phone</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {study.contacts.map((contact) => (
                <tr key={contact.id}>
                  <td className="py-1 pr-3">{contact.name}</td>
                  <td className="py-1 pr-3">{contact.role ?? "-"}</td>
                  <td className="py-1 pr-3">{contact.email ?? "-"}</td>
                  <td className="py-1">{contact.phone ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-4">
        <h3 className="text-sm font-semibold text-ink/70">Key documents</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {KEY_DOCUMENT_SLOTS.map((keySlot) => (
            <StudyDocumentSlot
              key={keySlot.slot}
              studyId={study.id}
              slot={keySlot.slot}
              label={keySlot.label}
              documents={study.documents.filter((document) => document.slot === keySlot.slot)}
              holdsOne
              showToast={showToast}
            />
          ))}
        </div>
      </section>

      <section className="mt-4 rounded border border-border p-3">
        <h3 className="text-sm font-semibold text-ink/70">{STAGE_LABELS[study.stage]}</h3>
        <div className="mt-2">
          <StageBody study={study} showToast={showToast} />
        </div>
      </section>

      {study.stage === "setup" ? (
        <div className="mt-6 border-t border-border pt-3">
          <button
            type="button"
            onClick={handleDelete}
            className="text-xs text-red-700 disabled:opacity-50"
            {...writeGate}
          >
            Delete this study
          </button>
          <p className="mt-1 text-xs text-ink/50">
            Only a study still in setup can be deleted. A study that has reached
            recruitment is a record - close it instead.
          </p>
        </div>
      ) : null}

      {editing ? (
        <StudyFormDialog
          key={study.id}
          study={study}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        />
      ) : null}

      {transition ? (
        <TransitionDialog
          study={study}
          direction={transition}
          onOpenChange={(open) => {
            if (!open) setTransition(null);
          }}
          showToast={showToast}
        />
      ) : null}

      <ToastDisplay message={toast?.message} />
    </div>
  );
}
