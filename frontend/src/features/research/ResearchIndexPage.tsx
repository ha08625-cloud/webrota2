/**
 * The Research section's index, and for now its only page.
 *
 * The section exists to answer two questions at a glance for each study the
 * practice is a recruitment site for: what stage is it at, and where are the
 * three documents the team actually opens. It is deliberately NOT a document
 * management system - the practice intranet holds the full site pack and the
 * patient database, and remains the record.
 *
 * This placeholder ships ahead of the study data model on purpose: the
 * permission, the landing tile and the route guard are worth proving on
 * their own, before there is anything behind them to get wrong. The study
 * list replaces the body below; the standing data-protection line does not,
 * and is here from the first commit rather than added alongside the first
 * upload control.
 */
export function ResearchIndexPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-semibold text-ink">Studies</h2>
      <p className="mt-2 text-sm text-ink/70">
        Study pages are not built yet. This section will hold one page per study the
        practice is a recruitment site for: its stage, who to contact, and the current
        flow chart, patient information leaflet and consent form.
      </p>
      <p className="mt-4 rounded border border-border bg-surface p-3 text-sm text-ink/80">
        <strong className="font-semibold">Never store participant information here.</strong>{" "}
        Blank study templates - the current patient information leaflet and the blank
        consent form - belong on a study page. Anything filled in about a real person does
        not: no recruitment or screening logs, no signed consent forms, no participant
        lists or NHS numbers. Those stay on the intranet.
      </p>
    </div>
  );
}
