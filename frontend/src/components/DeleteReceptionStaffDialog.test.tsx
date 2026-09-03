import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DeleteReceptionStaffDialog } from "./DeleteReceptionStaffDialog";

const staff = makeReceptionStaff({ id: 4, code: "AB", active: false });

function stubUsage(overrides: Partial<Record<string, number>> = {}) {
  server.use(
    http.get("/api/v1/reception/staff/4/usage", () =>
      HttpResponse.json({
        master_sessions: 6,
        rota_sessions: 12,
        generated_days: 5,
        leave_entries: 3,
        ...overrides,
      }),
    ),
  );
}

function renderDialog(props: Partial<Parameters<typeof DeleteReceptionStaffDialog>[0]> = {}) {
  return renderWithProviders(
    <DeleteReceptionStaffDialog staff={staff} open onOpenChange={() => {}} {...props} />,
  );
}

describe("DeleteReceptionStaffDialog", () => {
  it("renders the usage counts once they load", async () => {
    stubUsage();
    renderDialog();

    expect(await screen.findByText(/12 rows on 5 already-generated days/)).toBeInTheDocument();
    expect(screen.getByText(/6 slots on the weekday template/)).toBeInTheDocument();
    expect(screen.getByText(/3 leave records/)).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until the staff code is typed exactly", async () => {
    stubUsage();
    const user = userEvent.setup();
    renderDialog();

    const confirmButton = screen.getByRole("button", { name: "Permanently delete" });
    const input = screen.getByLabelText("Type AB to confirm");
    expect(confirmButton).toBeDisabled();

    await user.type(input, "ab");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "A");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "AB");
    expect(confirmButton).toBeEnabled();
  });

  it("deletes the right staff member, then closes and reports it", async () => {
    stubUsage();
    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/reception/staff/4", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ deleted: { master_sessions: 6, rota_sessions: 12, leave_entries: 3 } });
      }),
    );

    const onOpenChange = vi.fn();
    const onDeleted = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onOpenChange, onDeleted });

    await user.type(screen.getByLabelText("Type AB to confirm"), "AB");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(capturedUrl).toContain("/api/v1/reception/staff/4");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the API error detail when the delete fails", async () => {
    stubUsage();
    server.use(
      http.delete("/api/v1/reception/staff/4", () =>
        HttpResponse.json({ detail: "Reception staff 'AB' is active -- deactivate before deleting" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Type AB to confirm"), "AB");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByText(/is active -- deactivate before deleting/)).toBeInTheDocument();
  });

  it("still allows the delete when the usage query fails", async () => {
    server.use(
      http.get("/api/v1/reception/staff/4/usage", () => new HttpResponse(null, { status: 500 })),
    );
    let deleted = false;
    server.use(
      http.delete("/api/v1/reception/staff/4", () => {
        deleted = true;
        return HttpResponse.json({ deleted: { master_sessions: 0, rota_sessions: 0, leave_entries: 0 } });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    expect(await screen.findByText(/Could not load what this would delete/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Type AB to confirm"), "AB");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    await vi.waitFor(() => expect(deleted).toBe(true));
  });
});
