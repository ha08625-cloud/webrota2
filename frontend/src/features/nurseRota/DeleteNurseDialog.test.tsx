import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS, makeDoctor } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DeleteNurseDialog } from "./DeleteNurseDialog";

const nurse = makeDoctor({ id: 4, code: "NA", doctor_type: "Nurse", active: false });

function stubUsage(overrides: Partial<Record<string, number>> = {}) {
  server.use(
    http.get("/api/v1/nurse-rota/nurses/4/usage", () =>
      HttpResponse.json({
        master_sessions: 6,
        rota_sessions: 12,
        committed_rotas: 2,
        staging_sessions: 1,
        leave_entries: 3,
        duty_assignments: 0,
        extra_sessions: 0,
        blocked_entries: 0,
        ...overrides,
      }),
    ),
  );
}

function renderDialog(props: Partial<Parameters<typeof DeleteNurseDialog>[0]> = {}) {
  return renderWithProviders(
    <DeleteNurseDialog nurse={nurse} open onOpenChange={() => {}} {...props} />,
    { area: "nurse_rota", permissions: PERMISSION_PRESETS.nurseRota },
  );
}

describe("DeleteNurseDialog", () => {
  it("renders the usage counts once they load", async () => {
    stubUsage();
    renderDialog();

    expect(await screen.findByText(/12 rows on generated rotas, 2 of them committed/)).toBeInTheDocument();
    expect(screen.getByText(/6 slots on the master template/)).toBeInTheDocument();
    expect(screen.getByText(/1 staged row/)).toBeInTheDocument();
  });

  // The four counts that look structurally zero for a nurse are shown
  // anyway: no clinical router has a doctor_type check, so a clinical
  // administrator can record any of them against a nurse, and a dialog
  // that omitted a count which turned out to be non-zero would be worse
  // than one showing zeroes.
  it("shows the leave, duty, extra-session and blocked counts even when they are zero", async () => {
    stubUsage();
    renderDialog();

    expect(
      await screen.findByText(
        /3 leave records, 0 duty assignments, 0 extra sessions and 0 blocked entries/,
      ),
    ).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until the nurse's name is typed exactly", async () => {
    stubUsage();
    const user = userEvent.setup();
    renderDialog();

    const confirmButton = screen.getByRole("button", { name: "Permanently delete" });
    const input = screen.getByLabelText("Type NA to confirm");
    expect(confirmButton).toBeDisabled();

    await user.type(input, "na");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "NA");
    expect(confirmButton).toBeEnabled();
  });

  it("deletes the right nurse, then closes and reports it", async () => {
    stubUsage();
    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/nurse-rota/nurses/4", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ deleted: { master_rota_sessions: 6, rota_sessions: 12 } });
      }),
    );

    const onOpenChange = vi.fn();
    const onDeleted = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onOpenChange, onDeleted });

    await user.type(screen.getByLabelText("Type NA to confirm"), "NA");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(capturedUrl).toContain("/api/v1/nurse-rota/nurses/4");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the API error detail when the delete fails", async () => {
    stubUsage();
    server.use(
      http.delete("/api/v1/nurse-rota/nurses/4", () =>
        HttpResponse.json(
          { detail: "Nurse 'NA' is active -- deactivate before deleting" },
          { status: 409 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Type NA to confirm"), "NA");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByText(/is active -- deactivate before deleting/)).toBeInTheDocument();
  });

  it("still allows the delete when the usage query fails", async () => {
    let deleted = false;
    server.use(
      http.get("/api/v1/nurse-rota/nurses/4/usage", () => new HttpResponse(null, { status: 500 })),
      http.delete("/api/v1/nurse-rota/nurses/4", () => {
        deleted = true;
        return HttpResponse.json({ deleted: {} });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    expect(await screen.findByText(/Could not load what this would delete/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Type NA to confirm"), "NA");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    await vi.waitFor(() => expect(deleted).toBe(true));
  });
});
