import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AuditLogEntry } from "@/api/types";
import { PERMISSION_PRESETS, makeAuthUser, makeDoctor } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { AuditLogPage } from "./AuditLogPage";

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 1,
    at: "2026-08-16T09:30:00",
    user_id: 3,
    user_email: "manager@example.com",
    user_access_level: "manager",
    method: "PATCH",
    route: "/rota/{rota_id}/sessions/{session_id}",
    path: "/api/v1/rota/12/sessions/45",
    path_params: { rota_id: "12", session_id: "45" },
    request_body: { room_id: 5 },
    status_code: 200,
    outcome_detail: null,
    duration_ms: 14,
    client_ip: "10.0.0.1",
    // Server-derived, not columns; the API always sends them.
    summary: "Changed a session in rota 12",
    outcome: "Done",
    ...overrides,
  };
}

/**
 * Records every /audit request the page makes, so a test can assert on the
 * query string rather than only on what came back. The users and doctors
 * lists are stubbed alongside it: the page fetches both as name lookups
 * (the user filter's labels, and ids inside request bodies).
 */
function setUpServer(response: { items: AuditLogEntry[]; total: number }) {
  const urls: URL[] = [];
  server.use(
    http.get("/api/v1/users", () =>
      HttpResponse.json([makeAuthUser({ id: 3, name: "Mo Manager", email: "manager@example.com" })]),
    ),
    http.get("/api/v1/doctors", () => HttpResponse.json([makeDoctor({ id: 7, code: "AB" })])),
    http.get("/api/v1/audit", ({ request }) => {
      urls.push(new URL(request.url));
      return HttpResponse.json(response);
    }),
  );
  return urls;
}

describe("AuditLogPage", () => {
  it("leads with the server's sentence and outcome, not the method and status code", async () => {
    setUpServer({
      items: [
        makeEntry({ id: 1 }),
        makeEntry({
          id: 2,
          method: "DELETE",
          path: "/api/v1/leave/9",
          status_code: 404,
          summary: "Deleted a leave entry",
          outcome: "Not found",
        }),
      ],
      total: 2,
    });
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText("Changed a session in rota 12")).toBeInTheDocument();
    const row = screen.getByText("Deleted a leave entry").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Not found")).toBeInTheDocument();
    // The raw shape is behind the expander now, not in the row.
    expect(within(row as HTMLElement).queryByText("DELETE")).not.toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText("404")).not.toBeInTheDocument();
  });

  it("shows the request body as labelled fields, not JSON", async () => {
    setUpServer({
      items: [makeEntry({ request_body: { room_id: 5, sessions_per_week: 8 } })],
      total: 1,
    });
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText("Room: 5, Sessions per week: 8")).toBeInTheDocument();
  });

  it("resolves a doctor id in the body to the doctor's code", async () => {
    setUpServer({ items: [makeEntry({ request_body: { doctor_id: 7 } })], total: 1 });
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText("Doctor: AB")).toBeInTheDocument();
  });

  it("names the person by their user record rather than their email", async () => {
    setUpServer({ items: [makeEntry({ user_id: 3 })], total: 1 });
    renderWithProviders(<AuditLogPage />);

    // Scoped to the table: the same name is also an option in the Who filter.
    const table = await screen.findByRole("table", { name: "Audit log" });
    expect(within(table).getByText("Mo Manager")).toBeInTheDocument();
    expect(within(table).queryByText("manager@example.com")).not.toBeInTheDocument();
  });

  it("falls back to the frozen email when the user record is gone", async () => {
    setUpServer({
      items: [makeEntry({ user_id: 99, user_email: "left@example.com" })],
      total: 1,
    });
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText("left@example.com")).toBeInTheDocument();
  });

  it("expands a row to show the full body and the technical detail", async () => {
    setUpServer({ items: [makeEntry({ outcome_detail: "Session not found" })], total: 1 });
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />);
    await screen.findByText("Changed a session in rota 12");

    await user.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByText("Session not found")).toBeInTheDocument();
    expect(screen.getByText("PATCH /api/v1/rota/12/sessions/45")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("14 ms")).toBeInTheDocument();
  });

  it("requests the first page with the default page size", async () => {
    const urls = setUpServer({ items: [makeEntry()], total: 1 });
    renderWithProviders(<AuditLogPage />);
    await screen.findByText("Changed a session in rota 12");

    expect(urls[0].searchParams.get("limit")).toBe("50");
    expect(urls[0].searchParams.get("offset")).toBe("0");
    // Nothing else is sent, so the backend applies its own defaults.
    expect(urls[0].searchParams.get("path_contains")).toBeNull();
  });

  it("shows the empty state when nothing matches", async () => {
    setUpServer({ items: [], total: 0 });
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText(/No audit entries match/)).toBeInTheDocument();
  });

  it("surfaces a failed load", async () => {
    server.use(
      http.get("/api/v1/users", () => HttpResponse.json([])),
      http.get("/api/v1/audit", () => HttpResponse.json({ detail: "boom" }, { status: 500 })),
    );
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText(/Could not load the audit log/)).toBeInTheDocument();
  });
});

describe("AuditLogPage filters", () => {
  it("does not request until Apply is pressed, then sends every filled filter", async () => {
    const urls = setUpServer({ items: [makeEntry()], total: 1 });
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />);
    await screen.findByText("Changed a session in rota 12");
    expect(urls).toHaveLength(1);

    await user.type(screen.getByLabelText("Address contains"), "/rota/12/");
    // Typing alone must not fire a request: the substring filter is a full
    // table scan server-side.
    expect(urls).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText("Action"), "PATCH");
    await user.selectOptions(screen.getByLabelText("Who"), "3");
    await user.selectOptions(screen.getByLabelText("Outcome"), "problem");
    await user.type(screen.getByLabelText("From"), "2026-08-01");
    await user.type(screen.getByLabelText("To"), "2026-08-16");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(urls.length).toBeGreaterThan(1));
    const params = urls[urls.length - 1].searchParams;
    expect(params.get("path_contains")).toBe("/rota/12/");
    expect(params.get("method")).toBe("PATCH");
    expect(params.get("user_id")).toBe("3");
    expect(params.get("status_min")).toBe("400");
    expect(params.get("status_max")).toBe("599");
    expect(params.get("since")).toBe("2026-08-01T00:00:00");
    // The end date is inclusive of the whole day, not midnight at its start.
    expect(params.get("until")).toBe("2026-08-16T23:59:59");
  });

  it("Clear drops every filter from the request", async () => {
    const urls = setUpServer({ items: [makeEntry()], total: 1 });
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />);
    await screen.findByText("Changed a session in rota 12");

    await user.type(screen.getByLabelText("Address contains"), "/rota/12/");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(urls[urls.length - 1].searchParams.get("path_contains")).toBe("/rota/12/"));

    await user.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(urls[urls.length - 1].searchParams.get("path_contains")).toBeNull(),
    );
    expect(screen.getByLabelText("Address contains")).toHaveValue("");
  });
});

describe("AuditLogPage paging", () => {
  function pageOf(total: number, startId: number) {
    return {
      items: Array.from({ length: Math.min(50, total - startId + 1) }, (_, i) =>
        makeEntry({ id: startId + i, path: `/api/v1/rota/${startId + i}` }),
      ),
      total,
    };
  }

  it("shows the range and total, and pages forward and back", async () => {
    const urls: URL[] = [];
    server.use(
      http.get("/api/v1/users", () => HttpResponse.json([])),
      http.get("/api/v1/audit", ({ request }) => {
        const url = new URL(request.url);
        urls.push(url);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return HttpResponse.json(pageOf(120, offset + 1));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText("1-50 of 120")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("51-100 of 120")).toBeInTheDocument();
    expect(urls[urls.length - 1].searchParams.get("offset")).toBe("50");

    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(await screen.findByText("1-50 of 120")).toBeInTheDocument();
  });

  it("disables Next on the last page", async () => {
    setUpServer({ items: [makeEntry()], total: 1 });
    renderWithProviders(<AuditLogPage />);

    expect(await screen.findByText("1-1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("applying a filter returns to the first page", async () => {
    const urls: URL[] = [];
    server.use(
      http.get("/api/v1/users", () => HttpResponse.json([])),
      http.get("/api/v1/audit", ({ request }) => {
        const url = new URL(request.url);
        urls.push(url);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return HttpResponse.json(pageOf(120, offset + 1));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />);
    await screen.findByText("1-50 of 120");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("51-100 of 120");

    await user.type(screen.getByLabelText("Address contains"), "/rota/");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(urls[urls.length - 1].searchParams.get("path_contains")).toBe("/rota/"));
    expect(urls[urls.length - 1].searchParams.get("offset")).toBe("0");
  });
});

describe("AuditLogPage below manager", () => {
  // The nav entry is hidden for these users (App.tsx), but the route stays
  // registered, so a deep link has to land on something sane rather than on
  // a list that just 403s.
  it.each(["rotaAdmin", "receptionAdmin", "readOnly"] as const)(
    "tells a %s, who has no user administration permission, they have no access",
    async (presetName) => {
      let listed = false;
      server.use(
        http.get("/api/v1/audit", () => {
          listed = true;
          return HttpResponse.json({ items: [], total: 0 });
        }),
      );

      renderWithProviders(<AuditLogPage />, { permissions: PERMISSION_PRESETS[presetName] });

      expect(await screen.findByText(/do not have access to the audit log/i)).toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "Audit log" })).not.toBeInTheDocument();
      // Not even the list request goes out - the backend would 403 it.
      expect(listed).toBe(false);
    },
  );
});
