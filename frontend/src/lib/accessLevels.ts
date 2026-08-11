import type { AccessLevel } from "@/api/types";

/**
 * The four labels, in descending order of privilege, for display in
 * selectors and tables (role-based auth, Task 3).
 *
 * Doctor and Nurse are permission-identical - both are read-only - so the
 * order between them is arbitrary and the descriptions say so. The
 * permission decisions themselves live in auth/AuthContext.tsx; this
 * module is presentation only.
 */
export const ACCESS_LEVELS: readonly AccessLevel[] = ["manager", "admin", "doctor", "nurse"];

const LABELS: Record<AccessLevel, string> = {
  manager: "Manager",
  admin: "Admin",
  doctor: "Doctor",
  nurse: "Nurse",
};

const DESCRIPTIONS: Record<AccessLevel, string> = {
  manager: "Full access, including managing users",
  admin: "Can edit rotas and reference data",
  doctor: "Read-only",
  nurse: "Read-only",
};

export function accessLevelLabel(level: AccessLevel): string {
  return LABELS[level];
}

export function accessLevelDescription(level: AccessLevel): string {
  return DESCRIPTIONS[level];
}
