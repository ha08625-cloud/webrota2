import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Permissions } from "@/api/types";
import { PERMISSION_PRESETS, makeDoctor } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { NurseStaffPage } from "./NurseStaffPage";

const activeNurse = makeDoctor({ id: 1, code: "NA", doctor_type: "Nurse", active: true });
const inactiveNurse = makeDoctor({ id: 2, code: "NB", doctor_type: "Nurse", active: false });

function stubNurses(nurses = [activeNurse, inactiveNurse]) {
  server.use(http.get("/api/v1/nurse-rota/nurses", () => HttpResponse.json(nurses)));
}

function renderPage(permissions: Permissions = PERMISSION_PRESETS.nurseRota) {
  return renderWithProviders(<NurseStaffPage />, { area: "nurse_rota", permissions });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NurseStaffPage", () => {
  it("reads the section's own nurse list, including inactive rows", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/nurse-rota/nurses", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([activeNurse, inactiveNurse]);
      }),
      // Deliberately 403: the page must not fall back to GET /doctors,
      // which is shared-read for a reason that is not this page.
      http.get("/api/v1/doctors", () => HttpResponse.json({ detail: "Forbidden" }, { status: 403 })),
    );
    renderPage();

    expect(await screen.findByText("NA")).toBeInTheDocument();
    expect(capturedUrl).toContain("/api/v1/nurse-rota/nurses?include_inactive=true");
  });

  it("splits active from inactive", async () => {
    stubNurses();
    renderPage();

    const active = (await screen.findByRole("heading", { name: "Active" })).closest("section");
    const inactive = screen.getByRole("heading", { name: "Inactive" }).closest("section");

    expect(within(active as HTMLElement).getByText("NA")).toBeInTheDocument();
    expect(within(inactive as HTMLElement).getByText("NB")).toBeInTheDocument();
  });

  it("deactivates through a PATCH once confirmed", async () => {
    stubNurses();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/v1/nurse-rota/nurses/1", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...activeNurse, active: false });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    renderPage();

    const row = (await screen.findByText("NA")).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Deactivate" }));

    await vi.waitFor(() => expect(body).toEqual({ active: false }));
  });

  it("does not PATCH when the deactivate confirmation is declined", async () => {
    stubNurses();
    let called = false;
    server.use(
      http.patch("/api/v1/nurse-rota/nurses/1", () => {
        called = true;
        return HttpResponse.json(activeNurse);
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const user = userEvent.setup();
    renderPage();

    const row = (await screen.findByText("NA")).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Deactivate" }));

    expect(called).toBe(false);
  });

  // Reactivation is the same PATCH and deliberately skips the confirm:
  // it is the reversible direction.
  it("reactivates an inactive nurse without a confirmation", async () => {
    stubNurses();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/v1/nurse-rota/nurses/2", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...inactiveNurse, active: true });
      }),
    );
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    renderPage();

    const row = (await screen.findByText("NB")).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Reactivate" }));

    await vi.waitFor(() => expect(body).toEqual({ active: true }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  // The backend 409s a delete on an active row - deactivate first, delete
  // later - so the button is not offered there.
  it("offers Delete on an inactive row only", async () => {
    stubNurses();
    renderPage();

    const activeRow = (await screen.findByText("NA")).closest("tr") as HTMLElement;
    const inactiveRow = screen.getByText("NB").closest("tr") as HTMLElement;

    expect(within(activeRow).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(inactiveRow).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  // The one line that must NOT be copied from ReceptionStaffPage: that
  // page gates Delete on useCanAdminUsers(), and this endpoint carries no
  // user_admin dependency precisely so a nurse_rota-only login can delete.
  it("enables Delete for a nurse_rota-only login, which has no user_admin", async () => {
    stubNurses();
    expect(PERMISSION_PRESETS.nurseRota.user_admin).toBe(false);
    renderPage();

    const row = (await screen.findByText("NB")).closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("disables every write control for a read-only login", async () => {
    stubNurses();
    renderPage({ ...PERMISSION_PRESETS.nurseRota, nurse_rota: "read" });

    const row = (await screen.findByText("NB")).closest("tr") as HTMLElement;
    expect(screen.getByRole("button", { name: "New Nurse" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("reports a failed load rather than showing an empty table", async () => {
    server.use(
      http.get("/api/v1/nurse-rota/nurses", () => new HttpResponse(null, { status: 500 })),
    );
    renderPage();

    expect(await screen.findByText("Could not load nurses.")).toBeInTheDocument();
  });

  it("says so when there are no nurses yet", async () => {
    stubNurses([]);
    renderPage();

    expect(await screen.findByText("No nurses yet.")).toBeInTheDocument();
  });
});
