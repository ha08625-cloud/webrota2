import type { HttpHandler } from "msw";
import { HttpResponse, http } from "msw";

/**
 * Default handlers, overridden per-test via server.use(...) for
 * test-specific payloads (see RotaDetailPage_test.tsx for the pattern).
 * Empty-array defaults keep tests that don't care about these endpoints
 * from needing to stub them individually.
 */
export const handlers: HttpHandler[] = [
  http.get("/api/v1/rooms", () => HttpResponse.json([])),
  http.get("/api/v1/clinic-types", () => HttpResponse.json([])),
  http.get("/api/v1/doctors", () => HttpResponse.json([])),
  http.get("/api/v1/leave", () => HttpResponse.json([])),
  http.get("/api/v1/duty", () => HttpResponse.json([])),
  http.get("/api/v1/rota/:id/issues", () => HttpResponse.json([])),
];