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
    summary: "Before anything is built, the system checks the basics make sense. If something's wrong, nothing is generated.",
    body: [
      "Before building anything, the system checks that everything it needs is in order — for example, that the master rota template is set up properly, that every doctor on it is still active staff, and that no duty doctor has been assigned to a session they can't actually work (because they're on leave, or the session is closed for a bank holiday, for example).",
      "If anything is wrong, generation stops straight away. Nothing is created and nothing is saved.",
      "What to do: on the Rota page, before you click \"Start staging\", check the Duty status and Clinics lists shown on the form — these flag anything that looks incomplete. If you click \"Start staging\" and something is genuinely wrong, a red \"Generation failed\" box appears listing the problems. Fix the issue it names (for example, on the Master Rota page or the Duty page) and try again.",
    ],
  },
  {
    id: "phase-2",
    title: "Step 2 — Build the empty week from the template",
    summary: "The rota's basic shape comes from the master template you choose.",
    body: [
      "The system copies the master rota template to create the blank shape of the new rota, before anyone is filled in.",
      "If a doctor has no entry in the template for a particular day and session, they simply get nothing there — that's normal, and is how part-time working and non-working days are represented. The same applies to closed sessions (like bank holidays) and dates outside a doctor's employment period.",
      "What to do: the template itself is edited on the Master Rota page — it has four tabs (Week 1 to Week 4). Click the faint \"+\" on an empty cell to add a session, or click an existing session to edit it. When you're ready to generate, go to the Rota page and use the \"Generate a rota\" form: choose the week starting date, the number of weeks (1, 2 or 4), and which template week to start copying from, then click \"Start staging\".",
    ],
  },
  {
    id: "phase-4",
    title: "Step 3 — Place duty doctors",
    summary: "Duty doctors are assigned in advance, not chosen by the system. This step puts them onto the rota and gives them a room.",
    body: [
      "Duty doctors are assigned ahead of time by an admin — either using the \"Assign duty\" button in the menu (drag and drop a doctor's name onto the duty rota, or click to remove them), or from the Generate rota tab. The system works in 4-week chunks and shows a counter of how many duty sessions each doctor has done, including a version weighted by session, so duty can be shared out fairly.",
      "This step doesn't decide who's on duty — that's already been done. Its job is to take those assignments and put them onto the generated rota, giving each duty doctor a room to work from.",
      "Duty doctors get priority for their preferred room. The system also tries to keep them in the same room for both their morning and afternoon session, so they don't have to move partway through the day. This isn't always possible, and if a duty doctor ends up in two different rooms that day, it's not a mistake — it's just how the rooms happened to work out.",
    ],
  },
  {
    id: "phase-5",
    title: "Step 4 — Fill in the clinics",
    summary: "Every clinic slot gets a doctor, chosen fairly, and a room if it needs one.",
    body: [
      "The system works through each clinic type (schools, colleges, care homes and so on) in turn, filling every slot for that clinic type before moving to the next.",
      "For each slot, it looks at who's actually eligible — doctors set up for that clinic, who are working, not on leave, and not already busy with something else that session — and picks whoever has the strongest priority for that clinic. If several doctors are equally eligible, it picks whoever has done the fewest of that clinic type recently, so the work stays spread out fairly, scaled for part-time doctors.",
      "It then tries to give that doctor a suitable room. If the room they need is taken, it may move a lower-priority doctor out of the way to free it up. If it still can't find a room, the doctor is assigned to the clinic anyway, and it shows up as a warning at the end so it can be fixed by hand.",
      "What to do: the order clinic types are filled in, which doctors are eligible for a clinic type, and each doctor's priority for it, are all set on the Clinic Types page. Drag a clinic type up or down in the list to change its priority. Open a clinic type and use \"Add doctor...\" in the Doctor eligibility section to add a doctor and set their priority number for it.",
    ],
  },
  {
    id: "phase-7-9a",
    title: "Step 5 — Sort out the remaining rooms",
    summary: "Whatever rooms are still unresolved get worked through automatically, generally giving Trainees and AHPs priority for D rooms.",
    body: [
      "By this point most doctors have a room, but a few sessions may not. The system works through what's left automatically, generally giving Trainees and AHPs first priority for D rooms (since supervision and training need to happen from a D room), and moving other doctors to a different room to make space where needed.",
      "Doctors who are on leave are correctly left alone at this stage — they don't need a room, and this isn't treated as a problem.",
      "What to do: there's nothing to do here directly, but a doctor's own room preferences (used when the system needs to relocate them) are set on the Doctors page — open a doctor and use the \"Preferred rooms\" list. Drag rooms into order; the first one is their preferred room and the rest are fallback options.",
    ],
  },
  {
    id: "phase-9b",
    title: "Step 6 — Undo pointless room swaps",
    summary: "If two doctors end up swapping rooms for no good reason, the system tidies this up automatically.",
    body: [
      "Occasionally, after all the room shuffling above, two doctors end up having effectively swapped rooms between morning and afternoon for no real benefit. The system checks for this and, if neither doctor has a strong preference for the room they ended up in, puts them both back in their morning room for the whole day, so people aren't moving rooms unnecessarily.",
      "There's nothing to configure here — this step is fully automatic.",
    ],
  },
  {
    id: "phase-9c",
    title: "Step 7 — Assign supervision for Trainees",
    summary: "Any session with a Trainee who needs supervision gets a supervising doctor, chosen fairly.",
    body: [
      "For every session with a Trainee who needs supervision, the system builds a list of doctors in that session who could supervise (Partners and Salaried doctors who aren't already busy with something else), and picks whoever has done the least supervision recently — taking into account each doctor's own stated preference for doing more or less of it. If nobody at all is available, a warning is raised so it can be sorted out by hand.",
      "The doctor chosen to supervise is moved into the SR room if they're not already there, since that's the usual room for supervision.",
      "What to do: a doctor's supervision preference is set on the Doctors page, in the \"Supervision\" column for that doctor — choose Less, Normal or More.",
    ],
  },
  {
    id: "phase-12",
    title: "Step 8 — Final check",
    summary: "A read-only pass over the finished rota that flags anything worth double-checking. These are warnings, not blockers.",
    body: [
      "The last step doesn't change anything — it just looks over the finished rota and flags anything worth checking, such as a clinic slot with no doctor, a session missing a room it needs, or a Trainee session with no supervisor. These are warnings to look at, not errors that stop you — only Step 1 can do that.",
      "What to do: after generating, open the rota and check the \"Validation issues\" panel on the right. Click any item in the list to jump straight to that cell so you can fix it. This same check runs again every time you make a manual edit, so the panel always reflects the rota's true current state.",
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
