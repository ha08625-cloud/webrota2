import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS, makeDoctor } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { NurseFormDialog } from "./NurseFormDialog";

function renderDialog(props: Partial<Parameters<typeof NurseFormDialog>[0]> = {}) {
  return renderWithProviders(<NurseFormDialog open onOpenChange={() => {}} {...props} />, {
    area: "nurse_rota",
    permissions: PERMISSION_PRESETS.nurseRota,
  });
}

describe("NurseFormDialog", () => {
  // The fields that are NOT here are the point of the component: a type
  // select would let a nurse_rota-only login mint a Partner, and the
  // preference/sessions fields feed engine mechanisms no nurse is
  // considered by.
  it("offers only a name and the employment window", () => {
    renderDialog();

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Start date")).toBeInTheDocument();
    expect(screen.getByLabelText("End date")).toBeInTheDocument();
    expect(screen.queryByLabelText(/type/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/sessions/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/preference/i)).not.toBeInTheDocument();
  });

  it("posts a new nurse with no doctor_type in the body", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/v1/nurse-rota/nurses", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeDoctor({ id: 9, code: "NA", doctor_type: "Nurse" }), {
          status: 201,
        });
      }),
    );

    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onOpenChange });

    await user.type(screen.getByLabelText("Name"), "NA");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(body).toEqual({ code: "NA", start_date: null, end_date: null });
  });

  it("patches an existing nurse, sending blank dates as null so a window can be cleared", async () => {
    const nurse = makeDoctor({
      id: 4,
      code: "NA",
      doctor_type: "Nurse",
      start_date: "2026-01-01",
      end_date: "2026-06-30",
    });
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/v1/nurse-rota/nurses/4", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(nurse);
      }),
    );

    const user = userEvent.setup();
    renderDialog({ nurse });

    await user.clear(screen.getByLabelText("End date"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ code: "NA", start_date: "2026-01-01", end_date: null });
  });

  it("rejects an end date before the start date without calling the API", async () => {
    let called = false;
    server.use(
      http.post("/api/v1/nurse-rota/nurses", () => {
        called = true;
        return HttpResponse.json(makeDoctor(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "NA");
    await user.type(screen.getByLabelText("Start date"), "2026-06-30");
    await user.type(screen.getByLabelText("End date"), "2026-01-01");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("End date must not be before the start date")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("requires a name", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
  });

  // The backend says "Staff code", not "Doctor code", because the
  // collision may be with a doctor this section never shows. The message
  // is written to be read, so it is surfaced verbatim.
  it("shows the 409 detail verbatim against the name field", async () => {
    server.use(
      http.post("/api/v1/nurse-rota/nurses", () =>
        HttpResponse.json({ detail: "Staff code 'NA' is already in use" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "NA");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Staff code 'NA' is already in use")).toBeInTheDocument();
  });
});
