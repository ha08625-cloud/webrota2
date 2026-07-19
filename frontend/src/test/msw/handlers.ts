import type { HttpHandler } from "msw";
import { HttpResponse, http } from "msw";

import { makeClinicCounter, makeSystemCounter } from "@/test/fixtures/reference";

/**
 * Default handlers, overridden per-test via server.use(...) for
 * test-specific payloads (see RotaDetailPage_test.tsx for the pattern).
 * Empty-array defaults keep tests that don't care about these endpoints
 * from needing to stub them individually.
 */
export const handlers: HttpHandler[] = [
  // Auth (Task 5). /auth/me 401s by default since LoginGate only calls it
  // when a token is stored, which most tests never set - a per-test
  // server.use() overrides this for the auth-specific test files.
  http.get("/api/v1/auth/me", () =>
    HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
  ),
  http.post("/api/v1/auth/login", () =>
    HttpResponse.json({ detail: "Invalid email or password" }, { status: 401 }),
  ),
  http.post("/api/v1/auth/logout", () => new HttpResponse(null, { status: 204 })),
  http.get("/api/v1/rooms", () => HttpResponse.json([])),
  http.get("/api/v1/clinic-types", () => HttpResponse.json([])),
  http.get("/api/v1/doctors", () => HttpResponse.json([])),
  http.get("/api/v1/leave", () => HttpResponse.json([])),
  http.get("/api/v1/duty", () => HttpResponse.json([])),
  http.get("/api/v1/duty/counts", () => HttpResponse.json([])),
  http.get("/api/v1/closures", () => HttpResponse.json([])),
  http.get("/api/v1/counters/clinic", () => HttpResponse.json([])),
  http.get("/api/v1/counters/system", () => HttpResponse.json([])),
  http.post("/api/v1/counters/clinic/:id/reset", () => HttpResponse.json(makeClinicCounter())),
  http.post("/api/v1/counters/system/:id/reset", () => HttpResponse.json(makeSystemCounter())),
  http.post("/api/v1/counters/clinic/reset-all", () => new HttpResponse(null, { status: 204 })),
  http.post("/api/v1/counters/system/reset-all", () => new HttpResponse(null, { status: 204 })),
  // Empty-array default so pages that check for an active draft (e.g.
  // CountersPage's reset-confirmation wording) don't force every other
  // test in the suite to stub this endpoint individually.
  http.get("/api/v1/rota", () => HttpResponse.json([])),
  http.get("/api/v1/rota/:id/issues", () => HttpResponse.json([])),
  http.get("/api/v1/rota/:id/log", () => HttpResponse.json([])),
  http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
    HttpResponse.json({
      session: {
        session_id: 1,
        doctor_id: 1,
        doctor_code: "AB",
        doctor_type: "Partner",
        week: 1,
        day: "Monday",
        period: "AM",
        session_type: "requires_room",
        room_id: null,
        room_code: null,
      },
      displaced_session: null,
    }),
  ),
  http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
    HttpResponse.json(
      {
        session: {
          session_id: 999,
          doctor_id: 1,
          doctor_code: "AB",
          doctor_type: "Partner",
          week: 1,
          day: "Monday",
          period: "AM",
          session_type: "requires_room",
          room_id: null,
          room_code: null,
        },
        displaced_session: null,
      },
      { status: 201 },
    ),
  ),
  http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
    new HttpResponse(null, { status: 204 }),
  ),
  // Signatures feature (Task 4) - empty-list default, plus binary defaults
  // for the image and apply endpoints so tests that don't care about the
  // exact bytes don't need to stub them individually.
  http.get("/api/v1/signatures", () => HttpResponse.json([])),
  http.get("/api/v1/signatures/:doctorId/image", () =>
    new HttpResponse(new Uint8Array([137, 80, 78, 71]).buffer, {
      headers: { "Content-Type": "image/png" },
    }),
  ),
  http.post("/api/v1/signatures/:doctorId", () =>
    HttpResponse.json({ doctor_id: 1, content_type: "image/png", uploaded_at: "2026-07-18T00:00:00Z" }),
  ),
  http.delete("/api/v1/signatures/:doctorId", () => new HttpResponse(null, { status: 204 })),
  http.post("/api/v1/signatures/:doctorId/apply", () =>
    new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": 'attachment; filename="document-signed.docx"',
      },
    }),
  ),
];