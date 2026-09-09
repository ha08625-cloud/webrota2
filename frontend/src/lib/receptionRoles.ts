import type { ReceptionRole } from "@/api/types";

/**
 * Fixed display order for the role dropdown and any other place all
 * roles are listed together. Not alphabetical - phones first (the
 * historical default and the only role coverage rules track), other last
 * (the catch-all), the rest in the order the roles were added.
 */
export const RECEPTION_ROLE_ORDER: ReceptionRole[] = [
  "phones",
  "prescriptions",
  "registrations",
  "front_desk",
  "admin",
  "online_triage",
  "rotas",
  "tasks",
  "lunch",
  "not_working",
  "cutteslowe",
  "wolvercote",
  "other",
];

export const RECEPTION_ROLE_LABELS: Record<ReceptionRole, string> = {
  phones: "Phones",
  prescriptions: "Prescriptions",
  registrations: "Registrations",
  front_desk: "Front desk",
  admin: "Admin",
  online_triage: "Online triage",
  rotas: "Rotas",
  tasks: "Tasks",
  lunch: "Lunch",
  not_working: "Off",
  cutteslowe: "Cutteslowe",
  wolvercote: "Wolvercote",
  other: "Other",
};

/**
 * Tailwind classes for the way a session is painted in the two reception
 * grids (master template and generated day, both rendered by ReceptionGrid).
 * `bar` is the background and border of the coloured bar; `text` is the
 * colour of the role label, which is a separate field because the label does
 * not live inside the bar - a run's label is one element centred across every
 * cell of the run, while the bar is drawn per cell.
 *
 * The bar - not the `<td>` - carries the colour, so a run of slots reads as
 * one rounded block on a timeline rather than a row of filled spreadsheet
 * cells. ReceptionGrid supplies the border *sides* (top and bottom on every
 * segment, left/right only at a run's ends) so a multi-slot run is outlined
 * as one capsule with no internal rules.
 *
 * Pale -50 grounds with -700 text, deliberately lower-chroma than the
 * -100/-800 pairs this replaced: at this density a whole row of saturated
 * bands is what made the grid read as garish. The outline, not the fill, is
 * what keeps thirteen roles apart, and hues are spaced around the wheel
 * rather than assigned in the order roles were added - phones (the accent)
 * and prescriptions in particular must not both land on lavender, which is
 * the one pairing a user is likely to misread. Distinct from the clinical
 * rota's red/blue/green cell-background language (RotaGrid.tsx) so the two
 * never read as the same colour code.
 *
 * `not_working` is the exception and is meant to be: "Off" is the single most
 * common value on the grid, so giving it a colour of its own made absence the
 * loudest thing on the page. It recedes to a near-background wash with no
 * outline, leaving the eye on the hours somebody is working.
 */
export const RECEPTION_ROLE_COLOURS: Record<ReceptionRole, { bar: string; text: string }> = {
  phones: { bar: "bg-accent/[0.10] border-accent/30", text: "text-accent" },
  prescriptions: { bar: "bg-orange-50 border-orange-200", text: "text-orange-700" },
  registrations: { bar: "bg-teal-50 border-teal-300", text: "text-teal-700" },
  front_desk: { bar: "bg-purple-50 border-purple-300", text: "text-purple-700" },
  admin: { bar: "bg-sky-50 border-sky-300", text: "text-sky-700" },
  online_triage: { bar: "bg-fuchsia-50 border-fuchsia-300", text: "text-fuchsia-700" },
  rotas: { bar: "bg-lime-50 border-lime-400", text: "text-lime-700" },
  tasks: { bar: "bg-cyan-50 border-cyan-300", text: "text-cyan-700" },
  lunch: { bar: "bg-yellow-50 border-yellow-400", text: "text-yellow-700" },
  not_working: { bar: "bg-ink/[0.035] border-transparent", text: "text-ink/45" },
  cutteslowe: { bar: "bg-emerald-50 border-emerald-300", text: "text-emerald-700" },
  wolvercote: { bar: "bg-rose-100 border-rose-300", text: "text-rose-700" },
  other: { bar: "bg-ink/[0.06] border-ink/15", text: "text-ink/60" },
};
