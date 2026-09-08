import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ForceDeleteRotaDialog } from "./ForceDeleteRotaDialog";

describe("ForceDeleteRotaDialog", () => {
  it("renders the trigger button", () => {
    renderWithProviders(<ForceDeleteRotaDialog rotaId={8} onDeleted={() => {}} />);

    expect(screen.getByRole("button", { name: "Force delete rota" })).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until DELETE is typed exactly", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForceDeleteRotaDialog rotaId={8} onDeleted={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Force delete rota" }));
    const confirmButton = await screen.findByRole("button", { name: "Permanently delete" });
    const input = screen.getByLabelText("Type DELETE to confirm");

    expect(confirmButton).toBeDisabled();

    await user.type(input, "delete");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "DELET");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "DELETE");
    expect(confirmButton).toBeEnabled();
  });

  it("fires the force-delete endpoint and calls onDeleted on success", async () => {
    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/rota/:id/force-delete", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const onDeleted = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ForceDeleteRotaDialog rotaId={8} onDeleted={onDeleted} />);

    await user.click(screen.getByRole("button", { name: "Force delete rota" }));
    await user.type(await screen.findByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByRole("button", { name: "Force delete rota" })).toBeInTheDocument();
    expect(capturedUrl).toContain("/api/v1/rota/8/force-delete");
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("renders a 409 response's detail string as an error", async () => {
    server.use(
      http.delete("/api/v1/rota/:id/force-delete", () =>
        HttpResponse.json({ detail: "Rota 8 is a draft and cannot be force-deleted" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ForceDeleteRotaDialog rotaId={8} onDeleted={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Force delete rota" }));
    await user.type(await screen.findByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByText("Rota 8 is a draft and cannot be force-deleted")).toBeInTheDocument();
  });

  it("cancel resets the input, so reopening shows a disabled confirm button again", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForceDeleteRotaDialog rotaId={8} onDeleted={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Force delete rota" }));
    await user.type(await screen.findByLabelText("Type DELETE to confirm"), "DELETE");
    expect(screen.getByRole("button", { name: "Permanently delete" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Force delete rota" }));
    expect(await screen.findByLabelText("Type DELETE to confirm")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Permanently delete" })).toBeDisabled();
  });
});