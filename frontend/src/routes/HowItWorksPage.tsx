interface Phase {
  id: string;
  title: string;
  summary: string;
  body: string[];
}

/**
 * Plain-English narrative of backend/app/engine/'s pipeline, for clinical
 * staff rather than developers - see documentation/phase_pipeline.md for
 * the precise technical spec this is translated from. Content only; kept
 * out of the architecture docs deliberately; see that file's own header
 * for why a plain-English page and a developer reference are not the
 * same document and should not be merged.
 */
const PHASES: Phase[] = [
  {
    id: "phase-0",
    title: "Step 1 — Sanity checks",
    summary: "Before anything is built, the system checks the basics make sense. If they don't, nothing is generated.",
    body: [
      "The very first thing the system does is check that the request makes sense and that the underlying data isn't broken in some way that would make the rest of the process meaningless. This includes things like: there being exactly one active master rota template to build from, the start date being a Monday, the number of weeks being 1, 2 or 4, and every doctor named in the template still being an active member of staff.",
      "It also checks duty assignments specifically: a duty doctor can't be on leave for a session they're assigned to, can't be assigned to a session that's closed (a bank holiday, for example), and can't be assigned duty on a slot that doesn't exist for them (no surgery, admin time, or a date outside their employment dates).",
      "If any of these checks fail, generation stops immediately. Nothing is created, nothing is saved. You'll see the list of problems and need to fix the underlying data — for example, correcting the master template or removing a clashing duty assignment — before trying again.",
    ],
  },
  {
    id: "phase-2",
    title: "Step 2 — Build the empty week from the template",
    summary: "The rota's basic shape comes from the master template, and fairness counters are loaded ready for later steps.",
    body: [
      "The system copies the master rota.  You can choose how many weeks you want to generate and which week template to use.",
      "If a doctor simply has no entry in the template for a given day and period, they get nothing there in the generated rota — that's not a bug, it's how part-time working, and days a doctor doesn't normally work, are represented. The same thing happens for a closed session (a bank holiday, say) or a date outside a doctor's employment window: no session is created there at all, so nothing downstream needs to treat it as a special case.",
      "At the same time, the system loads the current fairness counters — running totals of how many clinics, room moves, and supervision sessions each doctor has done — which the later steps use to keep things fair. Any recurring notes (like \"Partners meeting\") that apply to a slot are also stamped on at this point, purely as a label — they never affect who gets assigned where.",
    ],
  },
  {
    id: "phase-4",
    title: "Step 3 — Place duty doctors",
    summary: "Pre-planned duty doctors are put in and given a room, with the system trying to keep them in one room for the whole day.",
    body: [
      "Duty is planned in advance — the system isn't choosing who's on duty, it's applying assignments that were already entered on the Duty page. This step's job is to put those assignments onto the rota and, importantly, to find each duty doctor a proper D room for their duty session, since duty always needs to be based from a D room.",
      "If a duty doctor's usual room is free, they get it. If it's occupied by someone who can be moved, that person is moved elsewhere and the duty doctor takes the room. Certain doctors are protected from being moved this way — Partners, AHPs, and anyone already holding another role — so the system falls back to finding any other suitable D room instead, and if it absolutely has to, it will move a Salaried doctor out of a D room to make space (Trainees and Locums are never moved this way).",
      "Because duty follows a slightly different daily shift pattern to normal clinical sessions, the system then makes a second pass and tries to move the duty doctor into the same room for their other session that day too, so they're not shuffling rooms partway through the day. This is done opportunistically — it only happens if it can find a sensible way to do it — so it doesn't always succeed, and a doctor left in two different rooms isn't a mistake, just a case where no better option was available at this point in the process (a later step can still improve on it).",
    ],
  },
  {
    id: "phase-5",
    title: "Step 4 — Fill in the clinics",
    summary: "Every clinic slot (schools, colleges, care homes, duty-helper sessions and so on) gets a doctor, chosen fairly, and a room if it needs one.",
    body: [
      "Clinic types are processed in a fixed priority order (the order you can set on the Clinic Types page), and within each clinic type, slot by slot through the week. For each slot, the system works out which doctors are actually eligible: they need to be one of the doctors set up for that clinic, active, not on leave or working from home that session, not already committed to admin time or no-surgery, and not already holding another role (like duty, or an earlier clinic) that session.",
      "Among the eligible doctors, the system picks whoever has the strongest priority for that clinic (set on the Clinic Types page). If there's a tie, it picks whoever has done the fewest of that clinic type so far, scaled by how many sessions a week they normally work — so a part-time doctor isn't expected to keep pace with a full-time one for fairness purposes. If it's still tied, it goes alphabetically by doctor code. Once someone is picked, their running total for that clinic type goes up by one, which affects who's picked next time round.",
      "If the clinic needs a specific kind of room, the system tries to give the doctor one of their eligible rooms. If none is free, it will try to move a lower-priority occupant out of the way — but never someone on leave, on duty, or running a higher-priority clinic — using that person's own preferred rooms to relocate them. If none of that works, the doctor is still assigned to the clinic; they just don't get a room yet, which shows up as a warning at the end so it can be fixed by hand if needed.",
    ],
  },
  {
    id: "phase-7-9a",
    title: "Step 5 — Sort out the remaining rooms",
    summary: "Whatever rooms are still unresolved get worked through in three passes, generally giving Trainees and AHPs priority for D rooms.",
    body: [
      "By this point most rooms are settled, but some sessions still need a room resolved. This happens in three passes, run one after another over the whole rota:",
      "The first pass looks for Trainees and AHPs who need the same D room for both their morning and afternoon session that day. If nothing is free, it will move a Partner or Salaried doctor who's occupying a D room all day out of the way, favouring doctors who'd free up two D rooms at once (because they hold a different D room in the morning and afternoon) over one who's sitting in the same room all day. Whoever's moved goes to a plain backup room (a C, W or SR room), and the system also checks whether their old room can now be reused for the whole day rather than leaving the Trainee split across two rooms.",
      "The second pass does the same thing but session by session, for any slot the first pass couldn't fully resolve as a whole day.",
      "The third and final pass covers whichever Partner or Salaried doctors still don't have a room. Nobody gets displaced at this point — the system tries the doctor's own preferred rooms first, and if none are free, forces them into whatever room is available, D rooms included (since by this stage, any D room still free is genuine spare capacity, not something a Trainee needs). Only if every room in the building is taken does this produce a warning rather than an assignment.",
      "One thing worth knowing: a doctor who's on leave still technically has a session slot from Step 2 (the template doesn't know in advance who's off), but this step correctly leaves them alone and doesn't try to give them a room — the final validation step (Step 8) knows to ignore this too, so it's not reported as a problem.",
    ],
  },
  {
    id: "phase-9b",
    title: "Step 6 — Undo pointless room swaps",
    summary: "If two doctors end up in each other's morning room for the afternoon, the system decides whether to leave it or put them back.",
    body: [
      "Sometimes, after all the room shuffling above, two Partner or Salaried doctors end up having effectively swapped rooms between the morning and afternoon — Doctor A is in Room X in the morning and Room Y in the afternoon, while Doctor B has done the exact opposite. This step looks specifically for that pattern (only among Partners and Salaried doctors, and only where neither doctor has leave, no-surgery, or an unresolved session that day) and decides whether to keep the swap or undo it.",
      "The decision comes down to room preferences: if one doctor genuinely prefers their own morning room and the other doesn't, the swap is undone and both stay in their morning room all day. If instead one doctor genuinely prefers the other room, the swap is left as it is. If neither case applies clearly — including the case where both doctors would equally like either room — the system defaults to undoing the swap, on the basis that an unnecessary room change during the day should be avoided unless there's a clear reason for it.",
      "\"Prefers\" here means the room appears anywhere on that doctor's list of preferred rooms — not necessarily their top choice.",
    ],
  },
  {
    id: "phase-9c",
    title: "Step 7 — Assign supervision for Trainees",
    summary: "Any session with a Trainee who needs supervision gets a supervising doctor, chosen fairly from whoever's eligible that session.",
    body: [
      "For every session, the system counts how many Trainees are present who need supervision that session (a Trainee who's on leave, working from home, or not actually working — no-surgery or admin time — doesn't count). If there are none, nothing happens for that session.",
      "If there are, the system builds a pool of every doctor in that session who could supervise: they need to be a Partner or Salaried doctor, not already doing something else (no duty, no clinic, no duty-helper role), not on leave or working from home, and sitting in a D or SR room. There's no automatic preference for whoever happens to be in the SR room — everyone eligible is compared on the same footing.",
      "From that pool, the system picks whoever has done the fewest supervision sessions recently, scaled by how many sessions a week they normally work, in the same fairness style as clinic and room-move assignments — and it also takes into account each doctor's own stated supervision preference (a doctor who's said they'd rather do less supervision is deprioritised, though not excluded outright: if they're the only eligible doctor in the session, they'll still be asked, because someone has to supervise). If nobody at all is eligible, a warning is raised instead so this can be fixed by hand.",
      "Once someone is chosen, if they're not already in the SR room and someone else is occupying it, the two doctors swap rooms — the new supervisor moves into SR and the other doctor takes their old room — since SR is the natural room for supervision. If the chosen supervisor is already in SR, or SR is empty, nothing else moves.",
    ],
  },
  {
    id: "phase-12",
    title: "Step 8 — Final check",
    summary: "A read-only pass over the finished rota that flags anything worth double-checking. These are warnings, not blockers.",
    body: [
      "The last step doesn't change anything — it just looks over the finished rota and reports anything that looks off, so it can be reviewed before the rota is committed. Nothing in this step stops generation (that only happens in Step 1); everything here is a warning to look at, not an error that blocks you.",
      "It checks six things: that every session has exactly one primary duty doctor (and a secondary duty doctor only on the week's first fully open weekday, usually Monday); that every enabled clinic slot has exactly one doctor assigned; that every session needing a specific room actually has one (ignoring sessions where the doctor is on leave or working from home, since those genuinely don't need a room); that nobody's been left holding a duty or clinic role on a session that shouldn't have one, such as no-surgery, admin time, leave or working from home; and two checks on supervision — that every session with Trainees needing supervision actually has a valid supervisor assigned, and that nobody's still flagged as supervising a session they're no longer eligible to supervise.",
      "These warnings are exactly what you'll see if you make a manual edit afterwards too — every edit to a generated rota re-runs this same check, so the warnings panel always reflects the rota's true current state, not just what generation originally produced.",
    ],
  },
];

export function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-lg font-semibold text-ink">How rota generation works</h1>
      <p className="mt-2 text-sm text-ink/70">
        When you generate a rota, the system builds it in a fixed sequence of steps. Each step adds one
        layer — first the basic shape of the week, then duty, then clinics, then rooms, then a final
        check — and every step follows the same repeatable rules every time, in the same order. Nothing
        here is random or trial-and-error. This page walks through what each step actually does, in
        plain terms, so you can understand why a generated rota looks the way it does.
      </p>

      <nav className="mt-4 rounded border border-border bg-surface p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Jump to a step</p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {PHASES.map((phase) => (
            <li key={phase.id}>
              <a href={`#${phase.id}`} className="text-accent hover:underline">
                {phase.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-4 space-y-3">
        {PHASES.map((phase, index) => (
          <details key={phase.id} id={phase.id} open={index === 0} className="rounded border border-border bg-surface p-4">
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              {phase.title}
              <span className="ml-2 font-normal text-ink/60">— {phase.summary}</span>
            </summary>
            <div className="mt-3 space-y-3">
              {phase.body.map((paragraph, i) => (
                <p key={i} className="text-sm text-ink/80">
                  {paragraph}
                </p>
              ))}
            </div>
          </details>
        ))}
      </div>

      <p className="mt-6 text-xs text-ink/50">
        This is a plain-English guide, not the full technical specification — see the project's phase
        pipeline documentation for the precise rules if you need the exact detail.
      </p>
    </div>
  );
}
