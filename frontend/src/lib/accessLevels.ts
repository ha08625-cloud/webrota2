import type { AccessLevel } from "@/api/types";

/**
 * The four access levels, in descending order of the privilege they used
 * to carry, for display in selectors and tables.
 *
 * They are labels and nothing else. Since fine-grained permissions landed,
 * nothing - frontend or backend - consults access_level to decide what a
 * login may do; that is the permission set (lib/permissionPresets.ts, read
 * through auth/AuthContext.tsx). The descriptions below therefore say who
 * someone is, not what they can reach: a "Manager" with no permissions can
 * do nothing, and a "Nurse" with the Manager preset can do everything.
 */
export const ACCESS_LEVELS: readonly AccessLevel[] = ["manager", "admin", "doctor", "nurse"];

const LABELS: Record<AccessLevel, string> = {
  manager: "Manager",
  admin: "Admin",
  doctor: "Doctor",
  nurse: "Nurse",
};

const DESCRIPTIONS: Record<AccessLevel, string> = {
  manager: "Practice manager or partner",
  admin: "Administrative staff",
  doctor: "Clinician",
  nurse: "Nursing staff",
};

export function accessLevelLabel(level: AccessLevel): string {
  return LABELS[level];
}

export function accessLevelDescription(level: AccessLevel): string {
  return DESCRIPTIONS[level];
}
