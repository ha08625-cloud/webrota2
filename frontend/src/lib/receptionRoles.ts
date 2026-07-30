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
 * Tailwind classes for the small role chip rendered in a grid cell.
 * Phones keeps its existing accent colour (Decision: coverage rules only
 * track phones, so it stays visually distinct); the rest share a neutral
 * palette rather than inventing a brand colour per tag for tags with no
 * further semantics.
 */
export const RECEPTION_ROLE_CHIP_CLASSNAME: Record<ReceptionRole, string> = {
  phones: "bg-accent/10 text-accent",
  prescriptions: "bg-ink/10 text-ink/70",
  registrations: "bg-ink/10 text-ink/70",
  front_desk: "bg-ink/10 text-ink/70",
  admin: "bg-ink/10 text-ink/70",
  online_triage: "bg-ink/10 text-ink/70",
  rotas: "bg-ink/10 text-ink/70",
  tasks: "bg-ink/10 text-ink/70",
  lunch: "bg-ink/10 text-ink/70",
  not_working: "bg-ink/10 text-ink/70",
  other: "bg-ink/10 text-ink/70",
};
