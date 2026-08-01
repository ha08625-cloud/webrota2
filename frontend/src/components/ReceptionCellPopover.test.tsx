import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeReceptionMasterSession } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";

import { ReceptionCellPopover } from "./ReceptionCellPopover";

interface RenderPopoverOptions {
  session?: ReturnType<typeof makeReceptionMasterSession> | null;
  onSave?: ReturnType<typeof vi.fn>;
  onDelete?: ReturnType<typeof vi.fn>;
  canDelete?: boolean;
  hourCount?: number;
  saving?: boolean;
}

function renderPopover(options: RenderPopoverOptions = {}) {
  const session =
    options.session === undefined
      ? makeReceptionMasterSession({ session_id: 1, role: "phones", note: null })
      : options.session;
  const onSave = options.onSave ?? vi.fn();
  const onDelete = options.onDelete;
  const canDelete = options.canDelete ?? (onDelete !== undefined && session !== null);
  const hourCount = options.hourCount;
  const saving = options.saving ?? false;

  renderWithProviders(
    <ReceptionCellPopover
      session={session}
      onSave={onSave}
      onDelete={onDelete}
      canDelete={canDelete}
      hourCount={hourCount}
      saving={saving}
    >
      <button type="button">Cell</button>
    </ReceptionCellPopover>,
  );
  return { session, onSave, onDelete };
}

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByText("Cell"));
  await screen.findByLabelText("Note");
  return user;
}

describe("ReceptionCellPopover: edit mode", () => {
  it("shows the current role selected and the current note pre-filled", async () => {
    renderPopover({
      session: makeReceptionMasterSession({ session_id: 1, role: "other", note: "Filing" }),
    });
    await open();

    expect(screen.getByLabelText("Role")).toHaveValue("other");
    expect(screen.getByLabelText("Note")).toHaveValue("Filing");
  });

  it("Save calls onSave with the edited role and note, and closes", async () => {
    const { onSave } = renderPopover({
      session: makeReceptionMasterSession({ session_id: 1, role: "phones", note: null }),
    });
    const user = await open();

    await user.selectOptions(screen.getByLabelText("Role"), "other");
    await user.type(screen.getByLabelText("Note"), "Post run");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("other", "Post run");
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
  });

  it("blank note is sent as null, not an empty string", async () => {
    const { onSave } = renderPopover({
      session: makeReceptionMasterSession({ session_id: 1, role: "phones", note: "old" }),
    });
    const user = await open();

    await user.clear(screen.getByLabelText("Note"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("phones", null);
  });

  it("renders a Remove entry, styled destructive", async () => {
    const onDelete = vi.fn();
    renderPopover({ onDelete });
    await open();

    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove.className).toContain("text-red-700");
  });

  it("clicking Remove calls onDelete directly and closes, with no onSave call", async () => {
    const onDelete = vi.fn();
    const { onSave } = renderPopover({ onDelete });
    const user = await open();

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
  });

  it("does not render Remove when onDelete is not supplied, even in edit mode", async () => {
    renderPopover();
    await open();

    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("resets to the session's current values on reopen, discarding an unsaved edit", async () => {
    renderPopover({
      session: makeReceptionMasterSession({ session_id: 1, role: "phones", note: "original" }),
    });
    const user = await open();
    await user.clear(screen.getByLabelText("Note"));
    await user.type(screen.getByLabelText("Note"), "unsaved edit");
    // Close without saving.
    await user.keyboard("{Escape}");

    await user.click(screen.getByText("Cell"));
    expect(await screen.findByLabelText("Note")).toHaveValue("original");
  });
});

describe("ReceptionCellPopover: range editing", () => {
  it("shows an 'Editing N slots' heading only when hourCount is greater than 1", async () => {
    renderPopover({ hourCount: 3 });
    await open();

    expect(screen.getByText("Editing 3 slots")).toBeInTheDocument();
  });

  it("does not show the heading for a single-cell edit", async () => {
    renderPopover({ hourCount: 1 });
    await open();

    expect(screen.queryByText(/Editing/)).not.toBeInTheDocument();
  });

  it("does not show the heading when hourCount is omitted", async () => {
    renderPopover();
    await open();

    expect(screen.queryByText(/Editing/)).not.toBeInTheDocument();
  });

  it("canDelete alone drives Remove: it renders even with session null, when canDelete is true", async () => {
    const onDelete = vi.fn();
    renderPopover({ session: null, onDelete, canDelete: true });
    await open();

    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("canDelete alone drives Remove: it is absent with an existing session, when canDelete is false", async () => {
    const onDelete = vi.fn();
    renderPopover({ onDelete, canDelete: false });
    await open();

    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});

describe("ReceptionCellPopover: create mode", () => {
  it("defaults role to Phones and note to empty, with no Remove entry", async () => {
    renderPopover({ session: null });
    await open();

    expect(screen.getByLabelText("Role")).toHaveValue("phones");
    expect(screen.getByLabelText("Note")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("Save calls onSave with the chosen role and note", async () => {
    const { onSave } = renderPopover({ session: null });
    const user = await open();

    await user.selectOptions(screen.getByLabelText("Role"), "other");
    await user.type(screen.getByLabelText("Note"), "Training");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("other", "Training");
  });

  it("does not render Remove even when onDelete is supplied, since there is nothing to remove yet", async () => {
    renderPopover({ session: null, onDelete: vi.fn() });
    await open();

    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});
