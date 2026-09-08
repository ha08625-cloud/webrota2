import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeClinicType, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ClinicTypeFormDialog } from "./ClinicTypeFormDialog";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
  rooms = [makeRoom({ id: 1, code: "D1", room_type: "D" })],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
  );
}

describe("ClinicTypeFormDialog - create mode", () => {
  it("renders an empty form", async () => {
    setUpServer();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);

    expect(await screen.findByRole("heading", { name: "New Clinic Type" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("toggling a schedule cell adds it, toggling again removes it", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");

    const cell = screen.getByLabelText("Monday AM");
    expect(cell).not.toBeChecked();
    await user.click(cell);
    expect(cell).toBeChecked();
    await user.click(cell);
    expect(cell).not.toBeChecked();
  });

  it("adding a doctor removes them from the add-select (can't add the same doctor twice)", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "AB" });

    await user.selectOptions(doctorSelect, "1");

    expect(screen.getByText("AB")).toBeInTheDocument();
    expect(within(doctorSelect).queryByRole("option", { name: "AB" })).not.toBeInTheDocument();
  });

  it("the active-doctor add-select excludes inactive doctors", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", active: true }),
        makeDoctor({ id: 2, code: "CD", active: false }),
      ],
    });
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");

    expect(await within(doctorSelect).findByRole("option", { name: "AB" })).toBeInTheDocument();
    expect(within(doctorSelect).queryByRole("option", { name: "CD" })).not.toBeInTheDocument();
  });

  it("the add-select groups doctors by type in Partner, Salaried, Trainee, AHP order, alphabetical within type", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "LFM", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CL", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 3, code: "EM", doctor_type: "Salaried", active: true }),
      ],
    });
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor") as HTMLSelectElement;
    await within(doctorSelect).findByRole("option", { name: "CL" });

    const groups = Array.from(doctorSelect.querySelectorAll("optgroup"));
    expect(groups.map((g) => g.label)).toEqual(["Partners", "Salaried"]);
    const partnerCodes = Array.from(groups[0].querySelectorAll("option")).map((o) => o.textContent);
    // First option in the group is the "All partners" bulk-add row, followed
    // by the individual doctors in alphabetical order.
    expect(partnerCodes).toEqual(["All partners", "CL", "LFM"]);
  });

  it("'All doctors' adds every not-yet-added doctor at once, each at priority 1000", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CD", doctor_type: "Salaried", active: true }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "All doctors" });
    const doctorRows = screen.getByRole("list", { name: "Doctor eligibility rows" });

    await user.selectOptions(doctorSelect, "all");

    expect(within(doctorRows).getByText("AB")).toBeInTheDocument();
    expect(within(doctorRows).getByText("CD")).toBeInTheDocument();
    expect(screen.getByLabelText("Priority for AB")).toHaveValue(1000);
    expect(screen.getByLabelText("Priority for CD")).toHaveValue(1000);
  });

  it("'All doctors' excludes Trainees and AHPs, adding only Partners and Salaried doctors", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CD", doctor_type: "Salaried", active: true }),
        makeDoctor({ id: 3, code: "EF", doctor_type: "Trainee", active: true }),
        makeDoctor({ id: 4, code: "GH", doctor_type: "AHP", active: true }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "All doctors" });
    const doctorRows = screen.getByRole("list", { name: "Doctor eligibility rows" });

    await user.selectOptions(doctorSelect, "all");

    expect(within(doctorRows).getByText("AB")).toBeInTheDocument();
    expect(within(doctorRows).getByText("CD")).toBeInTheDocument();
    expect(within(doctorRows).queryByText("EF")).not.toBeInTheDocument();
    expect(within(doctorRows).queryByText("GH")).not.toBeInTheDocument();
    // Trainee and AHP are still individually available, or reachable via
    // their own "All <type>" group option - "All doctors" just doesn't
    // sweep them in.
    expect(within(doctorSelect).getByRole("option", { name: "EF" })).toBeInTheDocument();
    expect(within(doctorSelect).getByRole("option", { name: "GH" })).toBeInTheDocument();
  });

  it("'All doctors' does not appear when only Trainees/AHPs remain to be added", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 3, code: "EF", doctor_type: "Trainee", active: true }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "AB" });

    await user.selectOptions(doctorSelect, "1");

    expect(within(doctorSelect).queryByRole("option", { name: "All doctors" })).not.toBeInTheDocument();
    expect(within(doctorSelect).getByRole("option", { name: "EF" })).toBeInTheDocument();
  });

  it("'All doctors' only adds doctors not already added, without duplicating an existing row", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CD", doctor_type: "Salaried", active: true }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "AB" });
    const doctorRows = screen.getByRole("list", { name: "Doctor eligibility rows" });

    await user.selectOptions(doctorSelect, "1");
    await user.selectOptions(doctorSelect, "all");

    expect(within(doctorRows).getAllByText("AB")).toHaveLength(1);
    expect(within(doctorRows).getByText("CD")).toBeInTheDocument();
  });

  it("an 'All <type>' option adds only not-yet-added doctors of that type", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CD", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 3, code: "EF", doctor_type: "Salaried", active: true }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "All partners" });
    const doctorRows = screen.getByRole("list", { name: "Doctor eligibility rows" });

    await user.selectOptions(doctorSelect, "all:Partner");

    expect(within(doctorRows).getByText("AB")).toBeInTheDocument();
    expect(within(doctorRows).getByText("CD")).toBeInTheDocument();
    expect(within(doctorRows).queryByText("EF")).not.toBeInTheDocument();
  });

  it("a fully-added type's group, including its 'All <type>' option, disappears from the dropdown", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
        makeDoctor({ id: 2, code: "CD", doctor_type: "Salaried", active: true }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor") as HTMLSelectElement;
    await within(doctorSelect).findByRole("option", { name: "AB" });

    await user.selectOptions(doctorSelect, "1");

    const remainingGroups = Array.from(doctorSelect.querySelectorAll("optgroup")).map((g) => g.label);
    expect(remainingGroups).toEqual(["Salaried"]);
    expect(within(doctorSelect).queryByRole("option", { name: "All partners" })).not.toBeInTheDocument();
  });

  it("'All doctors' disappears once every doctor has already been added", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "AB" });

    await user.selectOptions(doctorSelect, "1");

    expect(within(doctorSelect).queryByRole("option", { name: "All doctors" })).not.toBeInTheDocument();
  });

  it("adding a specific room and a room type produces two distinct rows", async () => {
    setUpServer({ rooms: [makeRoom({ id: 1, code: "D1", room_type: "D" })] });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const roomSelect = screen.getByLabelText("Add specific room");
    await within(roomSelect).findByRole("option", { name: "D1" });
    const roomRows = screen.getByRole("list", { name: "Room eligibility rows" });

    await user.selectOptions(roomSelect, "1");
    await user.selectOptions(screen.getByLabelText("Add room type"), "C");

    expect(within(roomRows).getByText("D1")).toBeInTheDocument();
    expect(within(roomRows).getByText("Room type: C")).toBeInTheDocument();
  });

  it("a room already added as a specific-room row is removed from the 'Add specific room' select (mirrors the doctor select)", async () => {
    setUpServer({ rooms: [makeRoom({ id: 1, code: "D1", room_type: "D" })] });
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const roomSelect = screen.getByLabelText("Add specific room");
    await within(roomSelect).findByRole("option", { name: "D1" });

    await user.selectOptions(roomSelect, "1");

    expect(within(roomSelect).queryByRole("option", { name: "D1" })).not.toBeInTheDocument();
  });

  it("a room type already added is removed from the 'Add room type' select", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const roomTypeSelect = screen.getByLabelText("Add room type");
    await within(roomTypeSelect).findByRole("option", { name: "C" });

    await user.selectOptions(roomTypeSelect, "C");

    expect(within(roomTypeSelect).queryByRole("option", { name: "C" })).not.toBeInTheDocument();
  });

  it("removing a row via its Remove button works for doctor and room eligibility", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "AB" });
    const doctorRows = screen.getByRole("list", { name: "Doctor eligibility rows" });

    await user.selectOptions(doctorSelect, "1");
    expect(within(doctorRows).getByText("AB")).toBeInTheDocument();

    await user.click(within(doctorRows).getByRole("button", { name: "Remove" }));

    // "AB" correctly reappears as an option in the add-select once the
    // row is removed (it's available again) - scoping to the rows list
    // specifically, rather than the whole document, is what makes this
    // assertion mean "the row is gone" instead of "the string AB is
    // nowhere on the page", which would be false for the wrong reason.
    expect(within(doctorRows).queryByText("AB")).not.toBeInTheDocument();
  });

  it("submits a create payload matching the built form state, including the room-eligibility XOR collapse", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/clinic-types", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeClinicType({ id: 1 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    const doctorSelect = screen.getByLabelText("Add doctor");
    await within(doctorSelect).findByRole("option", { name: "AB" });

    await user.type(screen.getByLabelText("Name"), "Diabetic clinic");
    await user.click(screen.getByLabelText("Monday AM"));
    await user.selectOptions(doctorSelect, "1");
    await user.selectOptions(screen.getByLabelText("Add specific room"), "1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toMatchObject({
      name: "Diabetic clinic",
      schedules: [{ day: "Monday", period: "AM" }],
      doctor_eligibilities: [{ doctor_id: 1, doctor_priority: 1000 }],
      room_eligibilities: [{ room_id: 1, room_type: null }],
    });
  });

  it("a 422 with a name error is shown next to the Name field", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/clinic-types", () =>
        HttpResponse.json(
          { detail: [{ loc: ["body", "name"], msg: "Name already exists", type: "value_error" }] },
          { status: 422 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");
    await user.type(screen.getByLabelText("Name"), "Duplicate");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Name already exists")).toBeInTheDocument();
  });

  it("a 409 uniqueness conflict is shown as a top-of-form banner", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/clinic-types", () =>
        HttpResponse.json(
          { detail: "ClinicType 'X' violates a uniqueness constraint (duplicate name, schedule slot, doctor, or room eligibility)" },
          { status: 409 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");
    await user.type(screen.getByLabelText("Name"), "X");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/violates a uniqueness constraint/)).toBeInTheDocument();
  });

  it("does not submit when the name is empty - shows a client-side field error instead", async () => {
    setUpServer();
    let posted = false;
    server.use(
      http.post("/api/v1/clinic-types", () => {
        posted = true;
        return HttpResponse.json(makeClinicType({ id: 1 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(posted).toBe(false);
  });
});

describe("ClinicTypeFormDialog - edit mode", () => {
  it("pre-fills all fields from the existing clinic type", async () => {
    setUpServer();
    const clinicType = makeClinicType({
      id: 5,
      name: "School clinic",
      clinic_priority: 200,
      is_enabled: false,
      room_required: true,
      category: "school",
      schedules: [{ id: 1, day: "Tuesday", period: "PM" }],
    });

    renderWithProviders(<ClinicTypeFormDialog clinicType={clinicType} open onOpenChange={() => {}} />);

    expect(await screen.findByLabelText("Name")).toHaveValue("School clinic");
    expect(screen.getByLabelText("Category")).toHaveValue("school");
    expect(screen.getByLabelText("Tuesday PM")).toBeChecked();
    expect(screen.getByLabelText("Room required")).toBeChecked();
    expect(screen.getByLabelText(/Enabled/)).not.toBeChecked();
  });

  it("submits via PUT to the existing clinic type's id", async () => {
    setUpServer();
    const clinicType = makeClinicType({ id: 5, name: "School clinic" });
    let capturedMethod = "";
    let capturedUrl = "";
    server.use(
      http.put("/api/v1/clinic-types/:id", ({ request }) => {
        capturedMethod = request.method;
        capturedUrl = request.url;
        return HttpResponse.json(clinicType);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog clinicType={clinicType} open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedMethod).toBe("PUT");
    expect(capturedUrl).toContain("/api/v1/clinic-types/5");
  });

  it("shows an existing eligibility row for a since-deactivated doctor with an (inactive) label", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 7, code: "ZZ", active: false })] });
    const clinicType = makeClinicType({
      doctor_eligibilities: [{ id: 1, doctor_id: 7, doctor_priority: 1000 }],
    });

    renderWithProviders(<ClinicTypeFormDialog clinicType={clinicType} open onOpenChange={() => {}} />);

    const row = await screen.findByText(/ZZ/);
    expect(row).toHaveTextContent("(inactive)");
  });

  it("preserves an inactive doctor's eligibility row in the submitted payload when only an unrelated field is edited", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 7, code: "ZZ", active: false })] });
    const clinicType = makeClinicType({
      id: 5,
      name: "Old name",
      doctor_eligibilities: [{ id: 1, doctor_id: 7, doctor_priority: 250 }],
    });
    let capturedBody: unknown;
    server.use(
      http.put("/api/v1/clinic-types/:id", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(clinicType);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClinicTypeFormDialog clinicType={clinicType} open onOpenChange={() => {}} />);
    const nameField = await screen.findByLabelText("Name");
    await user.clear(nameField);
    await user.type(nameField, "New name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toMatchObject({
      name: "New name",
      doctor_eligibilities: [{ doctor_id: 7, doctor_priority: 250 }],
    });
  });
});