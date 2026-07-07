import type { Rota, RotaSummary } from "@/api/types";

export function makeRotaSummary(overrides: Partial<RotaSummary> = {}): RotaSummary {
  return {
    rota_id: 1,
    status: "draft",
    created_at: "2026-07-06T10:00:00Z",
    start_date: "2026-07-06",
    num_weeks: 2,
    template_start_week: 1,
    ...overrides,
  };
}

export function makeRota(overrides: Partial<Rota> = {}): Rota {
  return {
    rota_id: 1,
    status: "draft",
    created_at: "2026-07-06T10:00:00Z",
    start_date: "2026-07-06",
    num_weeks: 2,
    template_start_week: 1,
    sessions: [],
    ...overrides,
  };
}