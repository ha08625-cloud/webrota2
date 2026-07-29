import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionStaffPage } from "./ReceptionStaffPage";

function setUpServer(staff: ReturnType<typeof makeReceptionStaff>[]) {
  server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
}

describe("ReceptionStaffPage", () => {
  it("shows an empty-state message when there is no reception staff", async () => {
    setUpServer([]);
    renderWithProviders(<ReceptionStaffPage />);

    expect(await screen.findByText(/No reception staff yet/)).toBeInTheDocument();
  });

  it("renders a row per staff member, flagging inactive ones", async () => {
    setUpServer([
      makeReceptionStaff({ id: 1, code: "JS", name: "Jo Smith", active: true }),
      makeReceptionStaff({ id: 2, code: "AB", name: "Amy Brown", active: false }),
    ]);
    renderWithProviders(<ReceptionStaffPage />);

    expect(await screen.findByText("Jo Smith")).toBeInTheDocument();
    const inactiveRow = (await screen.findByText("Amy Brown")).closest("tr");
    expect(inactiveRow).not.toBeNull();
    expect(inactiveRow?.textContent).toContain("(inactive)");
  });

  it("New Reception Staff opens the dialog in create mode", async () => {
    setUpServer([]);
    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByRole("button", { name: "New Reception Staff" });

    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));

    expect(await screen.findByRole("heading", { name: "New Reception Staff" })).toBeInTheDocument();
  });

  it("create succeeds and the new staff member appears in the list", async () => {
    // GET is stateful here (unlike setUpServer's fixed-array default)
    // because a create invalidates and refetches the list - a fixed
    // empty-array handler would make the new row vanish again on refetch.
    let currentStaff: ReturnType<typeof makeReceptionStaff>[] = [];
    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json(currentStaff)),
      http.post("/api/v1/reception/staff", async ({ request }) => {
        const body = (await request.json()) as { code: string; name: string };
        const created = makeReceptionStaff({ id: 5, code: body.code, name: body.name });
        currentStaff = [...currentStaff, created];
        return HttpResponse.json(created, { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));
    await user.type(screen.getByLabelText("Code"), "PQ");
    await user.type(screen.getByLabelText("Name"), "Pat Quinn");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Pat Quinn")).toBeInTheDocument();
  });

  it("a duplicate-code 409 on create shows on the code field", async () => {
    setUpServer([]);
    server.use(
      http.post("/api/v1/reception/staff", () =>
        HttpResponse.json({ detail: "Reception staff code 'JS' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await user.click(screen.getByRole("button", { name: "New Reception Staff" }));
    await user.type(screen.getByLabelText("Code"), "JS");
    await user.type(screen.getByLabelText("Name"), "Jo Smith");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Reception staff code 'JS' already exists")).toBeInTheDocument();
  });

  it("Deactivate confirms, then DELETEs the staff member", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer([makeReceptionStaff({ id: 1, code: "JS", name: "Jo Smith", active: true })]);
    let deleted = false;
    server.use(
      http.delete("/api/v1/reception/staff/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("Jo Smith");

    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(deleted).toBe(true);
  });

  it("does not deactivate when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setUpServer([makeReceptionStaff({ id: 1, code: "JS", name: "Jo Smith", active: true })]);
    let deleted = false;
    server.use(
      http.delete("/api/v1/reception/staff/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("Jo Smith");
    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(deleted).toBe(false);
  });

  it("Reactivate does not prompt for confirmation and PATCHes active=true", async () => {
    setUpServer([makeReceptionStaff({ id: 1, code: "JS", name: "Jo Smith", active: false })]);
    let patchedActiveTrue = false;
    server.use(
      http.patch("/api/v1/reception/staff/1", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        patchedActiveTrue = body.active === true;
        return HttpResponse.json(makeReceptionStaff({ id: 1, code: "JS", name: "Jo Smith", active: true }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffPage />);
    await screen.findByText("Jo Smith");

    await user.click(screen.getByRole("button", { name: "Reactivate" }));

    expect(patchedActiveTrue).toBe(true);
  });
});
