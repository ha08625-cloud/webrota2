import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeReceptionStaff } from "@/test/fixtures/reception";
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

  it("renders a row per staff member, including inactive ones", async () => {
    setUpServer({
      staff: [
        makeReceptionStaff({ id: 1, code: "AB", name: "Ann Brown" }),
        makeReceptionStaff({ id: 2, code: "CD", name: "Cai Davies", active: false }),
      ],
    });
    renderWithProviders(<ReceptionStaffPage />);

    expect(await screen.findByText("AB")).toBeInTheDocument();
    expect(screen.getByText("CD")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
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
        return HttpResponse.json(makeReceptionStaff({ id: 9, code: "JS", name: "Jo Smith" }), { status: 201 });
      }),
      http.get("/api/v1/reception/staff", () =>
        HttpResponse.json(created ? [makeReceptionStaff({ id: 9, code: "JS", name: "Jo Smith" })] : []),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText(/No reception staff yet/);

    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));
    await user.type(screen.getByLabelText("Code"), "JS");
    await user.type(screen.getByLabelText("Name"), "Jo Smith");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("JS")).toBeInTheDocument();
  });

  it("a duplicate-code 409 is shown on the code field within the dialog", async () => {
    setUpServer({ staff: [makeReceptionStaff({ id: 1, code: "AB", name: "Ann Brown" })] });
    server.use(
      http.post("/api/v1/reception/staff", () =>
        HttpResponse.json({ detail: "Reception staff code 'AB' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("AB");

    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));
    await user.type(screen.getByLabelText("Code"), "AB");
    await user.type(screen.getByLabelText("Name"), "Another Name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Reception staff code 'AB' already exists")).toBeInTheDocument();
  });

  it("deactivate then reactivate toggles the status column", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ staff: [makeReceptionStaff({ id: 1, code: "AB", name: "Ann Brown" })] });
    let active = true;
    server.use(
      http.delete("/api/v1/reception/staff/1", () => {
        active = false;
        return new HttpResponse(null, { status: 204 });
      }),
      http.patch("/api/v1/reception/staff/1", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        active = body.active ?? active;
        return HttpResponse.json(makeReceptionStaff({ id: 1, code: "AB", name: "Ann Brown", active }));
      }),
      http.get("/api/v1/reception/staff", () =>
        HttpResponse.json([makeReceptionStaff({ id: 1, code: "AB", name: "Ann Brown", active })]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("AB");
    expect(screen.getByText("Active")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reactivate" }));
    expect(await screen.findByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });
});

describe("ReceptionStaffPage for a read-only user", () => {
  // Same treatment as the clinical pages - the reception side is gated
  // the same way, since the backend gate is one global dependency.
  it("disables the write controls and says why", async () => {
    setUpServer({ staff: [makeReceptionStaff({ id: 1, code: "AB", name: "Ann Brown" })] });
    renderWithProviders(<ReceptionStaffPage />, { accessLevel: "nurse" });
    await screen.findByText("Ann Brown");

    const create = screen.getByRole("button", { name: "New Reception Staff" });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute("title", expect.stringContaining("does not allow changes"));
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeDisabled();
  });
});
