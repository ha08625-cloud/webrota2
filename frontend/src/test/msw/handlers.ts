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
  // Password reset. forgot-password 204s unconditionally, which is what
  // the real endpoint does for every outcome it has - unknown address,
  // inactive user, throttled, Mailgun failure - so there is no
  // "not found" variant for a test to stub. reset-password 400s by
  // default (the stale-link case, and the one the frontend has to handle
  // specially); tests about a successful reset stub a 204.
  http.post("/api/v1/auth/forgot-password", () => new HttpResponse(null, { status: 204 })),
  http.post("/api/v1/auth/reset-password", () =>
    HttpResponse.json(
      { detail: "This reset link is invalid or has expired. Please request a new one." },
      { status: 400 },
    ),
  ),
  // Section editing locks. Nobody holds anything by default, so every
  // existing suite keeps seeing a writable section; a test about being
  // locked out stubs a row. The two writes are stubbed because
  // EditLockProvider fires them on entering and leaving a lockable shell,
  // which App.test.tsx does on every render.
  http.get("/api/v1/locks", () => HttpResponse.json([])),
  http.post("/api/v1/locks/:area", ({ params }) =>
    HttpResponse.json({
      area: params.area,
      user_id: 1,
      user_name: "Test User",
      acquired_at: "2026-01-01T09:00:00Z",
      last_activity_at: "2026-01-01T09:00:00Z",
      idle: false,
    }),
  ),
  http.delete("/api/v1/locks/:area", () => new HttpResponse(null, { status: 204 })),
  http.get("/api/v1/rooms", () => HttpResponse.json([])),
  http.get("/api/v1/clinic-types", () => HttpResponse.json([])),
  http.get("/api/v1/doctors", () => HttpResponse.json([])),
  http.get("/api/v1/leave", () => HttpResponse.json([])),
  // Leave entitlement (leave entitlement and balances). The empty default
  // means no doctor has a balance line or a sessions/week mismatch flag, so
  // every LeavePage and DoctorsPage test that isn't about those stays
  // unaffected; tests that are about them stub real rows.
  http.get("/api/v1/leave/entitlement", () =>
    HttpResponse.json({
      year: 2026,
      from_date: "2026-01-01",
      to_date: "2026-12-31",
      doctors: [],
    }),
  ),
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
  http.get("/api/v1/schools", () => HttpResponse.json([])),
  http.get("/api/v1/closures/bank-holidays", () =>
    HttpResponse.json([
      { key: "new_year", name: "New Year's Day", date: null },
      { key: "good_friday", name: "Good Friday", date: null },
      { key: "easter_monday", name: "Easter Monday", date: null },
      { key: "early_may", name: "Early May bank holiday", date: null },
      { key: "spring", name: "Spring bank holiday", date: null },
      { key: "summer", name: "Summer bank holiday", date: null },
      { key: "christmas_day", name: "Christmas Day bank holiday", date: null },
      { key: "boxing_day", name: "Boxing Day bank holiday", date: null },
    ]),
  ),
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
  // state (at most one exists globally)
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
  // Per-run notes. POST and PATCH echo the whole staging back, as the
  // real endpoints do; the default is an empty-note staging, so tests
  // that assert on what the panel renders after a write stub these with
  // the staging they expect.
  http.post("/api/v1/staging/:stagingId/notes", () =>
    HttpResponse.json(makeStaging(), { status: 201 }),
  ),
  http.patch("/api/v1/staging/:stagingId/notes/:noteId", () => HttpResponse.json(makeStaging())),
  http.delete("/api/v1/staging/:stagingId/notes/:noteId", () =>
    new HttpResponse(null, { status: 204 }),
  ),
  http.delete("/api/v1/staging/:stagingId", () => new HttpResponse(null, { status: 204 })),
  http.post("/api/v1/staging/:stagingId/complete", () =>
    HttpResponse.json({ rota_id: 1, status: "draft", issues: [] }),
  ),
  // Signatures feature (Task 4) - empty-list default, plus binary defaults
  // for the image and apply endpoints so tests that don't care about the
  // exact bytes don't need to stub them individually.
  // Calendar feed (calendar feed, Task 5). One default token, so any test
  // that lands on CalendarFeedPage gets a stable URL without stubbing;
  // tests about rotation override the POST to return a second token.
  http.get("/api/v1/doctors/:doctorId/calendar-feed", ({ params }) =>
    HttpResponse.json({
      doctor_id: Number(params.doctorId),
      token: "feed-token",
      feed_path: "/api/v1/calendar/feed-token.ics",
    }),
  ),
  http.post("/api/v1/doctors/:doctorId/calendar-feed/rotate", ({ params }) =>
    HttpResponse.json({
      doctor_id: Number(params.doctorId),
      token: "rotated-token",
      feed_path: "/api/v1/calendar/rotated-token.ics",
    }),
  ),
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
  // The default apply response is the RTF branch's PDF, since that is the
  // format EMIS certificates arrive in; docx-specific tests stub their own.
  http.post("/api/v1/signatures/:doctorId/apply", () =>
    new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="cert-signed.pdf"',
      },
    }),
  ),
  // Reception rota (Task 5). Empty-list defaults for the three reference
  // endpoints, mirroring /doctors and /closures above. GET .../rota 404s
  // by default (no rota generated for the queried date), the same
  // no-active-record convention as auth/me and staging/active.
  http.get("/api/v1/reception/staff", () => HttpResponse.json([])),
  http.get("/api/v1/reception/master", () => HttpResponse.json([])),
  http.get("/api/v1/reception/rota", () =>
    HttpResponse.json({ detail: "No rota for this date" }, { status: 404 }),
  ),
];