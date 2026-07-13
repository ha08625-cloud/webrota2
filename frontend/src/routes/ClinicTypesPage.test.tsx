import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeClinicType, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ClinicTypesPage } from "./ClinicTypesPage";

function setUpServer({ clinicTypes }: { clinicTypes: ReturnType<typeof makeClinicType>[] }) {
  server.use(
    http.get("/api/v1/clinic-types", () => HttpResponse.json(clinicTypes)),
    http.get("/api/v1/doctors", () => HttpResponse.json([makeDoctor({ id: 1, code: "AB" })])),
    http.get("/api/v1/rooms", () => HttpResponse.json([makeRoom({ id: 1, code: "D1" })])),
  );
}

describe("ClinicTypesPage", () => {
  it("shows an empty-state message when there are no clinic types yet", async () => {
    setUpServer({ clinicTypes: [] });
    renderWithProviders(<ClinicTypesPage />);

    expect(await screen.findByText(/No clinic types yet/)).toBeInTheDocument();
  });

  it("renders a row per clinic type", async () => {
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })] });
    renderWithProviders(<ClinicTypesPage />);

    expect(await screen.findByText("Diabetic clinic")).toBeInTheDocument();
  });

  it("New Clinic Type opens the dialog in create mode", async () => {
    setUpServer({ clinicTypes: [] });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypesPage />);
    await screen.findByRole("button", { name: "New Clinic Type" });

    await user.click(screen.getByRole("button", { name: "New Clinic Type" }));

    expect(await screen.findByRole("heading", { name: "New Clinic Type" })).toBeInTheDocument();
  });

  it("Edit opens the dialog pre-filled with that clinic type", async () => {
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })] });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypesPage />);
    await screen.findByText("Diabetic clinic");

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(await screen.findByRole("heading", { name: "Edit Diabetic clinic" })).toBeInTheDocument();
  });

  it("Delete confirms, calls the endpoint, and the row disappears", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/clinic-types/:id", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/clinic-types", () => HttpResponse.json(deleted ? [] : [makeClinicType({ id: 1, name: "Diabetic clinic" })])),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypesPage />);
    await screen.findByText("Diabetic clinic");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText(/No clinic types yet/)).toBeInTheDocument();
  });

  it("does not delete when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/clinic-types/:id", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypesPage />);
    await screen.findByText("Diabetic clinic");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(false);
    expect(screen.getByText("Diabetic clinic")).toBeInTheDocument();
  });

  it("a 409 delete conflict shows a banner and the row remains", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })] });
    server.use(
      http.delete("/api/v1/clinic-types/:id", () =>
        HttpResponse.json({ detail: "ClinicType 1 is referenced by counter or rota rows" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypesPage />);
    await screen.findByText("Diabetic clinic");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/referenced by counter or rota rows/)).toBeInTheDocument();
    expect(screen.getByText("Diabetic clinic")).toBeInTheDocument();
  });

  it("cancelling the dialog after an edit and reopening the same row shows the original values, not the discarded edit", async () => {
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })] });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypesPage />);
    await screen.findByText("Diabetic clinic");

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const nameField = await screen.findByLabelText("Name");
    await user.clear(nameField);
    await user.type(nameField, "Discarded edit");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Diabetic clinic");
  });

  // -- Enabled/disabled split and drag-and-drop reordering ---------------
  //
  // dnd-kit's PointerSensor isn't reliably simulable through userEvent in
  // jsdom - DoctorFormDialog_test.tsx, which uses the identical
  // DndContext/useSortable pattern for preferred rooms, doesn't attempt a
  // real drag gesture either. These tests cover what's actually
  // observable without one: section membership, sort order, and which
  // rows expose a drag handle.

  it("splits enabled and disabled clinic types into separate sections", async () => {
    setUpServer({
      clinicTypes: [
        makeClinicType({ id: 1, name: "Enabled clinic", is_enabled: true }),
        makeClinicType({ id: 2, name: "Disabled clinic", is_enabled: false }),
      ],
    });
    renderWithProviders(<ClinicTypesPage />);

    expect(await screen.findByRole("heading", { name: "Enabled" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Disabled" })).toBeInTheDocument();
    expect(screen.getByText("Enabled clinic")).toBeInTheDocument();
    expect(screen.getByText("Disabled clinic")).toBeInTheDocument();
  });

  it("does not render a Disabled section when every clinic type is enabled", async () => {
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic", is_enabled: true })] });
    renderWithProviders(<ClinicTypesPage />);

    await screen.findByText("Diabetic clinic");
    expect(screen.queryByRole("heading", { name: "Disabled" })).not.toBeInTheDocument();
  });

  it("shows 'No enabled clinic types' when every clinic type is disabled, without hiding the disabled section", async () => {
    setUpServer({ clinicTypes: [makeClinicType({ id: 1, name: "Old clinic", is_enabled: false })] });
    renderWithProviders(<ClinicTypesPage />);

    expect(await screen.findByText("No enabled clinic types.")).toBeInTheDocument();
    expect(screen.getByText("Old clinic")).toBeInTheDocument();
  });

  it("sorts the disabled section by name, independent of priority or creation order", async () => {
    setUpServer({
      clinicTypes: [
        makeClinicType({ id: 1, name: "Zebra clinic", is_enabled: false }),
        makeClinicType({ id: 2, name: "Alpha clinic", is_enabled: false }),
      ],
    });
    renderWithProviders(<ClinicTypesPage />);

    await screen.findByText("Zebra clinic");
    const rows = screen.getAllByRole("row").filter((r) => within(r).queryByText(/clinic$/));
    const names = rows.map((r) => within(r).getByText(/clinic$/).textContent);
    expect(names).toEqual(["Alpha clinic", "Zebra clinic"]);
  });

  it("only enabled rows expose a drag handle", async () => {
    setUpServer({
      clinicTypes: [
        makeClinicType({ id: 1, name: "Enabled clinic", is_enabled: true }),
        makeClinicType({ id: 2, name: "Disabled clinic", is_enabled: false }),
      ],
    });
    renderWithProviders(<ClinicTypesPage />);
    await screen.findByText("Enabled clinic");

    expect(screen.getByLabelText("Reorder Enabled clinic")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reorder Disabled clinic")).not.toBeInTheDocument();
  });

  it("enabled clinic types render in server-provided (priority) order, not alphabetically", async () => {
    setUpServer({
      clinicTypes: [
        makeClinicType({ id: 1, name: "Zebra clinic", is_enabled: true }),
        makeClinicType({ id: 2, name: "Alpha clinic", is_enabled: true }),
      ],
    });
    renderWithProviders(<ClinicTypesPage />);

    await screen.findByText("Zebra clinic");
    const rows = screen.getAllByRole("row").filter((r) => within(r).queryByText(/clinic$/));
    const names = rows.map((r) => within(r).getByText(/clinic$/).textContent);
    expect(names).toEqual(["Zebra clinic", "Alpha clinic"]);
  });
});
