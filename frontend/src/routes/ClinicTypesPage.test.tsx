import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
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
});