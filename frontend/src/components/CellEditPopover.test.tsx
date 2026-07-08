import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeRotaSession } from "@/test/fixtures/rota";

import { CellEditPopover } from "./CellEditPopover";

describe("CellEditPopover", () => {
  it("opens on click and shows the current WFH/notes values", async () => {
    const session = makeRotaSession({ is_wfh: true, notes: "Covering for AB" });
    const user = userEvent.setup();

    render(
      <CellEditPopover session={session} onSave={vi.fn()} saving={false}>
        <div>Cell content</div>
      </CellEditPopover>,
    );

    await user.click(screen.getByText("Cell content"));

    expect(await screen.findByLabelText("Working from home")).toBeChecked();
    expect(screen.getByLabelText("Notes")).toHaveValue("Covering for AB");
  });

  it("Save sends both fields explicitly, matching the edited form state", async () => {
    const session = makeRotaSession({ is_wfh: false, notes: null });
    const onSave = vi.fn();
    const user = userEvent.setup();

    render(
      <CellEditPopover session={session} onSave={onSave} saving={false}>
        <div>Cell content</div>
      </CellEditPopover>,
    );

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.type(screen.getByLabelText("Notes"), "Back from leave");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(true, "Back from leave");
  });

  it("an emptied notes field is sent as null, not an empty string", async () => {
    const session = makeRotaSession({ is_wfh: false, notes: "Old note" });
    const onSave = vi.fn();
    const user = userEvent.setup();

    render(
      <CellEditPopover session={session} onSave={onSave} saving={false}>
        <div>Cell content</div>
      </CellEditPopover>,
    );

    await user.click(screen.getByText("Cell content"));
    const notesField = await screen.findByLabelText("Notes");
    await user.clear(notesField);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(false, null);
  });

  it("Cancel closes the popover without calling onSave", async () => {
    const session = makeRotaSession();
    const onSave = vi.fn();
    const user = userEvent.setup();

    render(
      <CellEditPopover session={session} onSave={onSave} saving={false}>
        <div>Cell content</div>
      </CellEditPopover>,
    );

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onSave).not.toHaveBeenCalled();
  });
});