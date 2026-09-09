import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeReceptionStaff } from "@/test/fixtures/reception";
import { PERMISSION_PRESETS } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionStaffPage } from "./ReceptionStaffPage";

function setUpServer({ staff }: { staff: ReturnType<typeof makeReceptionStaff>[] }) {
  server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
}

describe("ReceptionStaffPage", () => {
  it("shows an empty-state message when there is no reception staff", async () => {
    setUpServer({ staff: [] });
    renderWithProviders(<ReceptionStaffPage />);

    expect(await screen.findByText(/No reception staff yet/)).toBeInTheDocument();
  });

  it("lists inactive staff in their own section below the active ones", async () => {
    setUpServer({
      staff: [
        makeReceptionStaff({ id: 1, code: "AB" }),
        makeReceptionStaff({ id: 2, code: "CD", active: false }),
      ],
    });
    renderWithProviders(<ReceptionStaffPage />);

    const activeSection = (await screen.findByRole("heading", { name: "Active" })).closest("section");
    const inactiveSection = screen.getByRole("heading", { name: "Inactive" }).closest("section");
    expect(activeSection).not.toBeNull();
    expect(inactiveSection).not.toBeNull();

    expect(within(activeSection as HTMLElement).getByText("AB")).toBeInTheDocument();
    expect(within(activeSection as HTMLElement).queryByText("CD")).not.toBeInTheDocument();
    expect(within(inactiveSection as HTMLElement).getByText("CD")).toBeInTheDocument();

    // Inactive comes after active in document order.
    expect(
      (activeSection as HTMLElement).compareDocumentPosition(inactiveSection as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("omits the inactive section when every staff member is active", async () => {
    setUpServer({ staff: [makeReceptionStaff({ id: 1, code: "AB" })] });
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("AB");

    expect(screen.queryByRole("heading", { name: "Inactive" })).not.toBeInTheDocument();
  });

  it("says so when every staff member is inactive", async () => {
    setUpServer({ staff: [makeReceptionStaff({ id: 2, code: "CD", active: false })] });
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("CD");

    expect(screen.getByText("No active reception staff.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inactive" })).toBeInTheDocument();
  });

  it("New Reception Staff opens the dialog in create mode", async () => {
    setUpServer({ staff: [] });
    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByRole("button", { name: "New Reception Staff" });

    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));

    expect(await screen.findByRole("heading", { name: "New Reception Staff" })).toBeInTheDocument();
  });

  it("create succeeds and the new staff member appears in the list", async () => {
    setUpServer({ staff: [] });
    let created = false;
    server.use(
      http.post("/api/v1/reception/staff", () => {
        created = true;
        return HttpResponse.json(makeReceptionStaff({ id: 9, code: "JS" }), { status: 201 });
      }),
      http.get("/api/v1/reception/staff", () =>
        HttpResponse.json(created ? [makeReceptionStaff({ id: 9, code: "JS" })] : []),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText(/No reception staff yet/);

    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));
    await user.type(screen.getByLabelText("Name"), "JS");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("JS")).toBeInTheDocument();
  });

  it("a duplicate-name 409 is shown on the name field within the dialog", async () => {
    setUpServer({ staff: [makeReceptionStaff({ id: 1, code: "AB" })] });
    server.use(
      http.post("/api/v1/reception/staff", () =>
        HttpResponse.json({ detail: "Reception staff name 'AB' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("AB");

    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));
    await user.type(screen.getByLabelText("Name"), "AB");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Reception staff name 'AB' already exists")).toBeInTheDocument();
  });

  it("deactivate then reactivate moves the row between the two sections", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ staff: [makeReceptionStaff({ id: 1, code: "AB" })] });
    let active = true;
    server.use(
      http.patch("/api/v1/reception/staff/1", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        active = body.active ?? active;
        return HttpResponse.json(makeReceptionStaff({ id: 1, code: "AB", active }));
      }),
      http.get("/api/v1/reception/staff", () =>
        HttpResponse.json([makeReceptionStaff({ id: 1, code: "AB", active })]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("AB");
    expect(screen.queryByRole("heading", { name: "Inactive" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    const inactiveSection = screen.getByRole("heading", { name: "Inactive" }).closest("section");
    expect(within(inactiveSection as HTMLElement).getByText("AB")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reactivate" }));
    expect(await screen.findByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inactive" })).not.toBeInTheDocument();
  });

  it("offers Delete only on an inactive row", async () => {
    setUpServer({
      staff: [
        makeReceptionStaff({ id: 1, code: "AB" }),
        makeReceptionStaff({ id: 2, code: "CD", active: false }),
      ],
    });
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("AB");

    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
    // The one Delete belongs to the inactive row, not the active one.
    const inactiveRow = screen.getByText("CD").closest("tr");
    expect(inactiveRow).not.toBeNull();
    expect(within(inactiveRow as HTMLElement).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  // The backend puts require_capability("user_admin") on this DELETE on top
  // of the reception gate, so writing the reception rota is not enough: the
  // delete is irreversible and destroys history.
  it("hides Delete from a reception writer without user administration", async () => {
    setUpServer({ staff: [makeReceptionStaff({ id: 2, code: "CD", active: false })] });
    renderWithProviders(<ReceptionStaffPage />, {
      area: "reception",
      permissions: PERMISSION_PRESETS.receptionAdmin,
    });
    await screen.findByText("CD");

    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("Delete opens the confirm dialog and the purge removes the row", async () => {
    let staff = [makeReceptionStaff({ id: 2, code: "CD", active: false })];
    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)),
      http.get("/api/v1/reception/staff/2/usage", () =>
        HttpResponse.json({ master_sessions: 0, rota_sessions: 0, generated_days: 0, leave_entries: 0 }),
      ),
      http.delete("/api/v1/reception/staff/2", () => {
        staff = [];
        return HttpResponse.json({ deleted: { master_sessions: 0, rota_sessions: 0, leave_entries: 0 } });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("CD");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.type(await screen.findByLabelText("Type CD to confirm"), "CD");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByText(/No reception staff yet/)).toBeInTheDocument();
  });

});

describe("ReceptionStaffPage for a read-only user", () => {
  // Same treatment as the clinical pages - the reception side is gated
  // the same way, since the backend gate is one global dependency.
  it("disables the write controls and says why", async () => {
    setUpServer({ staff: [makeReceptionStaff({ id: 1, code: "AB" })] });
    renderWithProviders(<ReceptionStaffPage />, {
      area: "reception",
      permissions: PERMISSION_PRESETS.readOnly,
    });
    await screen.findByText("AB");

    const create = screen.getByRole("button", { name: "New Reception Staff" });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute("title", expect.stringContaining("do not allow changes"));
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeDisabled();
  });
});
