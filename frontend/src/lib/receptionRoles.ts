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
  not_working: "Not working",
  other: "Other",
};

/**
 * Tailwind classes for the small role chip rendered in a grid cell, one
 * distinct colour per role so the two reception grids (master template and
 * generated day, both rendered by ReceptionGrid) are scannable at a glance.
 * Picked from Tailwind's -100/-800 pairs, distinct from the clinical rota's
 * red/blue/green cell-background language (RotaGrid.tsx) so the two never
 * read as the same colour code. Exact hues are arbitrary - no functional
 * meaning attaches to any of them beyond "not the same as its neighbours".
 */
export const RECEPTION_ROLE_CHIP_CLASSNAME: Record<ReceptionRole, string> = {
  phones: "bg-accent/10 text-accent",
  prescriptions: "bg-purple-100 text-purple-800",
  registrations: "bg-teal-100 text-teal-800",
  front_desk: "bg-orange-100 text-orange-800",
  admin: "bg-sky-100 text-sky-800",
  online_triage: "bg-pink-100 text-pink-800",
  rotas: "bg-lime-100 text-lime-800",
  tasks: "bg-indigo-100 text-indigo-800",
  lunch: "bg-yellow-100 text-yellow-800",
  not_working: "bg-ink/10 text-ink/50",
  other: "bg-ink/10 text-ink/70",
};
