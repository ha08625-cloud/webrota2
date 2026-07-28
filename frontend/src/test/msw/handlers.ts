import type { HttpHandler } from "msw";
import { HttpResponse, http } from "msw";

import { makeClinicCounter, makeSystemCounter } from "@/test/fixtures/reference";
import { makeStaging, makeStagingSession } from "@/test/fixtures/staging";

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
  http.get("/api/v1/extra-sessions", () => HttpResponse.json([])),
  http.post("/api/v1/extra-sessions", () =>
    HttpResponse.json(
      { id: 999, doctor_id: 1, date: "2026-08-03", period: "AM" },
      { status: 201 },
    ),
  ),
  http.delete("/api/v1/extra-sessions/:id", () => new HttpResponse(null, { status: 204 })),
  // Leave planning (annual leave planning, Task 4). Empty coverage means
  // every total renders "-"; tests that assert on the cover row stub this
  // with real slots. The bulk default is the all-clean response, so a
  // test only interested in *what was posted* can override with a
  // body-capturing handler without also having to invent a payload.
  http.get("/api/v1/leave-planning/coverage", () => HttpResponse.json([])),
  http.post("/api/v1/leave-planning/bulk", () =>
    HttpResponse.json({ applied: 0, skipped: [], superseded_extra_sessions: [] }),
  ),
  http.get("/api/v1/duty", () => HttpResponse.json([])),
  http.get("/api/v1/duty/counts", () => HttpResponse.json([])),
  http.get("/api/v1/closures", () => HttpResponse.json([])),
  http.get("/api/v1/recurring-notes", () => HttpResponse.json([])),
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
  // No active template by default, mirroring the auth/me and
  // staging/active convention above: pages that need one stub it
  // per-test, and both MasterRotaPage and LeavePlanningPage already
  // handle its absence (the latter simply reads zero cover).
  http.get("/api/v1/master-rota/active", () =>
    HttpResponse.json({ detail: "No active template" }, { status: 404 }),
  ),
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
  // Staging (Task 5). No active staging by default - the expected steady
  // state (staging plan, Design Decision 7: at most one exists globally)
  // - so RotaPage's default-path tests never need to stub this
  // individually; per-test server.use() supplies an active staging where
  // needed, mirroring the auth/me 401 default's convention above.
  http.get("/api/v1/staging/active", () =>
    HttpResponse.json({ detail: "No active staging" }, { status: 404 }),
  ),
  http.post("/api/v1/staging", () => HttpResponse.json(makeStaging(), { status: 201 })),
  http.patch("/api/v1/staging/:stagingId/sessions/:sessionId", () =>
    HttpResponse.json({ session: makeStagingSession(), displaced_session: null }),
  ),
  http.post("/api/v1/staging/:stagingId/sessions", () =>
    HttpResponse.json(
      { session: makeStagingSession({ session_id: 999 }), displaced_session: null },
      { status: 201 },
    ),
  ),
  http.delete("/api/v1/staging/:stagingId/sessions/:sessionId", () =>
    new HttpResponse(null, { status: 204 }),
  ),
  http.delete("/api/v1/staging/:stagingId", () => new HttpResponse(null, { status: 204 })),
  http.post("/api/v1/staging/:stagingId/complete", () =>
    HttpResponse.json({ rota_id: 1, status: "draft", issues: [] }),
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