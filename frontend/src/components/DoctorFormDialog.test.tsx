import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeDoctorDetail, makeRoom } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DoctorFormDialog } from "./DoctorFormDialog";

function setUpServer({
  rooms = [makeRoom({ id: 1, code: "D1", room_type: "D" })],
  doctorDetail,
}: { rooms?: ReturnType<typeof makeRoom>[]; doctorDetail?: ReturnType<typeof makeDoctorDetail> } = {}) {
  server.use(http.get("/api/v1/rooms", () => HttpResponse.json(rooms)));
  if (doctorDetail) {
    server.use(http.get(`/api/v1/doctors/${doctorDetail.id}`, () => HttpResponse.json(doctorDetail)));
  }
}

describe("DoctorFormDialog - create mode", () => {
  it("renders an empty form with no preferred-rooms section", async () => {
    setUpServer();
    renderWithProviders(<DoctorFormDialog open onOpenChange={() => {}} />);

    expect(await screen.findByRole("heading", { name: "New Doctor" })).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveValue("");
    expect(screen.queryByText("Preferred rooms")).not.toBeInTheDocument();
    expect(screen.getByText(/reopen Edit afterwards/)).toBeInTheDocument();
  });

  it("submits a create payload via POST /doctors", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/doctors", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeDoctor({ id: 9, code: "XY" }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.type(screen.getByLabelText("Code"), "XY");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({ code: "XY", doctor_type: "Partner", sessions_per_week: "10.0" });
  });

  it("does not submit when code is empty - shows a client-side field error", async () => {
    setUpServer();
    let posted = false;
    server.use(
      http.post("/api/v1/doctors", () => {
        posted = true;
        return HttpResponse.json(makeDoctor({ id: 1 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Code is required")).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("a 409 duplicate-code conflict is shown as a top-of-form banner", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/doctors", () =>
        HttpResponse.json({ detail: "Doctor code 'XY' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.type(screen.getByLabelText("Code"), "XY");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Doctor code 'XY' already exists")).toBeInTheDocument();
  });
});

describe("DoctorFormDialog - edit mode", () => {
  it("pre-fills scalar fields and shows existing preferred-room rows from the detail fetch", async () => {
    const doctor = makeDoctor({ id: 5, code: "AB", doctor_type: "Salaried", sessions_per_week: "8.0" });
    const detail = makeDoctorDetail({
      ...doctor,
      preferred_rooms: [
        { id: 1, preference_order: 1, room_id: 1, room_type: null },
        { id: 2, preference_order: 2, room_id: null, room_type: "C" },
      ],
    });
    setUpServer({ doctorDetail: detail });

    renderWithProviders(<DoctorFormDialog doctor={doctor} open onOpenChange={() => {}} />);

    expect(await screen.findByLabelText("Code")).toHaveValue("AB");
    expect(screen.getByLabelText("Sessions per week")).toHaveValue(8);
    const rows = await screen.findByRole("list", { name: "Preferred room rows" });
    // The room-code label depends on the separate /rooms fetch resolving
    // (labelForRow looks up roomsById), which can land after the
    // preferred-rooms list itself renders from the doctor detail fetch -
    // two independent queries. findByText waits for that, rather than
    // racing it with a synchronous getByText.
    expect(await within(rows).findByText("D1")).toBeInTheDocument();
    expect(within(rows).getByText("Room type: C")).toBeInTheDocument();
  });

  it("adding a specific room and a room type produces two distinct rows, each removable", async () => {
    const doctor = makeDoctor({ id: 5, code: "AB" });
    const detail = makeDoctorDetail({ ...doctor, preferred_rooms: [] });
    setUpServer({ doctorDetail: detail, rooms: [makeRoom({ id: 1, code: "D1", room_type: "D" })] });

    const user = userEvent.setup();
    renderWithProviders(<DoctorFormDialog doctor={doctor} open onOpenChange={() => {}} />);
    const roomSelect = await screen.findByLabelText("Add specific room");
    await within(roomSelect).findByRole("option", { name: "D1" });

    await user.selectOptions(roomSelect, "1");
    await user.selectOptions(screen.getByLabelText("Add room type"), "C");

    const rows = screen.getByRole("list", { name: "Preferred room rows" });
    expect(within(rows).getByText("D1")).toBeInTheDocument();
    expect(within(rows).getByText("Room type: C")).toBeInTheDocument();

    await user.click(within(rows).getAllByRole("button", { name: /Remove/ })[0]);
    expect(within(rows).queryByText("D1")).not.toBeInTheDocument();
  });

  it("submits PATCH for scalar fields then PUT for preferred rooms, in order 1..n", async () => {
    const doctor = makeDoctor({ id: 5, code: "AB" });
    const detail = makeDoctorDetail({
      ...doctor,
      preferred_rooms: [{ id: 1, preference_order: 1, room_id: 1, room_type: null }],
    });
    setUpServer({ doctorDetail: detail, rooms: [makeRoom({ id: 1, code: "D1" })] });

    let patched = false;
    let putBody: unknown;
    server.use(
      http.patch("/api/v1/doctors/5", () => {
        patched = true;
        return HttpResponse.json(doctor);
      }),
      http.put("/api/v1/doctors/5/preferred-rooms", async ({ request }) => {
        putBody = await request.json();
        return HttpResponse.json(detail);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorFormDialog doctor={doctor} open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    // Wait for the seeded row to actually be in the DOM (detail fetch +
    // the effect that populates `rows` from it) before saving - clicking
    // Save while `rows` is still its initial empty array would submit an
    // empty PUT instead of the row this test is checking for.
    const rows = await screen.findByRole("list", { name: "Preferred room rows" });
    await within(rows).findByText("D1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(patched).toBe(true);
    expect(putBody).toEqual([{ preference_order: 1, room_id: 1, room_type: null }]);
  });

  it("a PUT failure after a successful PATCH is reported as a partial save, not rolled back", async () => {
    const doctor = makeDoctor({ id: 5, code: "AB" });
    const detail = makeDoctorDetail({ ...doctor, preferred_rooms: [] });
    setUpServer({ doctorDetail: detail });

    server.use(
      http.patch("/api/v1/doctors/5", () => HttpResponse.json(doctor)),
      http.put("/api/v1/doctors/5/preferred-rooms", () =>
        HttpResponse.json({ detail: "Duplicate preference_order or invalid room reference" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorFormDialog doctor={doctor} open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Doctor details saved\./)).toBeInTheDocument();
    expect(screen.getByText(/Duplicate preference_order/)).toBeInTheDocument();
  });
});