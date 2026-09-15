import type { StudyStage } from "./types";

/**
 * The placeholder body for every stage after Setup.
 *
 * It is deliberately empty of fields. The point of building Setup first
 * is to learn what the recruitment page actually needs from using it, and
 * a half-guessed set of accrual fields is harder to remove than to add -
 * so this stub says "more to come here" and nothing else.
 *
 * It does not repeat the persistent details or the three key documents:
 * `StudyPage` draws those above every stage body (Decision 13), so a
 * study that has left setup still shows its current flow chart, leaflet
 * and consent form, and whom to ring about them.
 *
 * The known gap is named rather than papered over: once setup is finished
 * nothing on this page records what meetings are booked or what is
 * outstanding, because the setup checklist was the only thing answering
 * that. Solving it is the next plan's job.
 */

interface RecruitmentOpenStageProps {
  stage: StudyStage;
}

export function RecruitmentOpenStage({ stage }: RecruitmentOpenStageProps) {
  return (
    <div className="text-sm text-ink/50">
      <p>More to come here.</p>
      <p className="mt-2">
        {stage === "recruitment_open"
          ? "Recruitment is open, but what is booked and what is outstanding is not recorded here yet."
          : "This stage has no page of its own yet."}{" "}
        The details and key documents above stay current in every stage.
      </p>
    </div>
  );
}
