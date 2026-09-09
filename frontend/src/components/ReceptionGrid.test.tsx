import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ValidationIssue } from "@/api/types";
import { formatHour } from "@/lib/receptionHours";
import { makeReceptionMasterSession, makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";

import { ReceptionGrid, selectedRangeHours } from "./ReceptionGrid";

/** Resolves true, matching the "save succeeded" contract used to clear the selection. */
function resolvedOnSave() {
  return vi.fn().mockResolvedValue(true);
}

function resolvedOnDelete() {
  return vi.fn().mockResolvedValue(true);
}

describe("ReceptionGrid: rows", () => {
  it("gives an active staff member a row with zero sessions", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.getByText("AB")).toBeInTheDocument();
    expect(screen.queryByText("(inactive)")).not.toBeInTheDocument();
  });

  it("flags an inactive staff member who still has sessions rather than dropping the row", () => {
    const session = makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.getByText("AB")).toBeInTheDocument();
    expect(screen.getByText("(inactive)")).toBeInTheDocument();
  });

  it("drops an inactive staff member with no sessions", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.queryByText("AB")).not.toBeInTheDocument();
  });

  it("renders an absent cell on an inactive staff row with no add affordance", () => {
    const session = makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const absentCell = screen.getByTestId("reception-cell-1-10");
    expect(absentCell).toBeEmptyDOMElement();
  });
});

describe("ReceptionGrid: cell content", () => {
  it("renders the role badge and note for an existing session", () => {
    const session = makeReceptionMasterSession({
      session_id: 1, staff_id: 1, hour: 9, role: "other", note: "Filing",
    });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    expect(within(cell).getByText("Other")).toBeInTheDocument();
    expect(within(cell).getByText("Filing")).toBeInTheDocument();
  });

  it("renders an add affordance on an absent cell for an active staff member", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-8");
    expect(within(cell).getByLabelText("Add session for AB 08:00-08:30")).toHaveTextContent("+");
  });
});

describe("ReceptionGrid: create", () => {
  it("clicking the add affordance and saving calls onSave with one payload: staffId, hour, and no session", async () => {
    const onSave = resolvedOnSave();
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-8");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB 08:00-08:30"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([{ staffId: 1, hour: 8, session: null, role: "phones", note: null }]);
  });
});

describe("ReceptionGrid: edit and delete", () => {
  it("editing an existing cell calls onSave with one payload carrying the session and the new values", async () => {
    const onSave = resolvedOnSave();
    const session = makeReceptionMasterSession({
      session_id: 5, staff_id: 1, hour: 9, role: "phones", note: null,
    });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.selectOptions(await screen.findByLabelText("Role"), "other");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([{ staffId: 1, hour: 9, session, role: "other", note: null }]);
  });

  it("Remove calls onDelete with an array containing the session", async () => {
    const onDelete = resolvedOnDelete();
    const session = makeReceptionMasterSession({ session_id: 5, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={onDelete}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onDelete).toHaveBeenCalledWith([session]);
  });
});

describe("ReceptionGrid: run merging", () => {
  it("hides the chip on continuation slots of a uniform run and flags them, leaving the run's first slot visible and unflagged", () => {
    const sessions = [9, 9.5, 10].map((hour) =>
      makeReceptionMasterSession({ staff_id: 1, hour, role: "phones", note: null }),
    );
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const first = screen.getByTestId("reception-cell-1-9");
    const second = screen.getByTestId("reception-cell-1-9.5");
    const third = screen.getByTestId("reception-cell-1-10");

    // The run's first cell now carries two "Phones" nodes: an invisible
    // in-flow spacer (keeps the popover trigger's hit box sized) and the
    // visible chip, centred across the run.
    const firstCellChips = within(first).getAllByText("Phones");
    expect(firstCellChips).toHaveLength(2);
    expect(firstCellChips.filter(isVisible)).toHaveLength(1);
    expect(within(second).getByText("Phones")).not.toBeVisible();
    expect(within(third).getByText("Phones")).not.toBeVisible();
    expect(first).not.toHaveAttribute("data-run-continuation", "true");
    expect(second).toHaveAttribute("data-run-continuation", "true");
    expect(third).toHaveAttribute("data-run-continuation", "true");
  });

  it("renders a shared note once, hidden in the continuation slots", () => {
    const sessions = [9, 9.5, 10].map((hour) =>
      makeReceptionMasterSession({ staff_id: 1, hour, role: "phones", note: "cover" }),
    );
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell9CoverNotes = within(screen.getByTestId("reception-cell-1-9")).getAllByText("cover");
    expect(cell9CoverNotes).toHaveLength(2);
    expect(cell9CoverNotes.filter(isVisible)).toHaveLength(1);
    expect(within(screen.getByTestId("reception-cell-1-9.5")).getByText("cover")).not.toBeVisible();
    expect(within(screen.getByTestId("reception-cell-1-10")).getByText("cover")).not.toBeVisible();
  });

  it("breaks the run when the note differs, showing the chip again", () => {
    const sessions = [
      makeReceptionMasterSession({ staff_id: 1, hour: 9, role: "phones", note: "cover" }),
      makeReceptionMasterSession({ staff_id: 1, hour: 9.5, role: "phones", note: "cover" }),
      makeReceptionMasterSession({ staff_id: 1, hour: 10, role: "phones", note: "different" }),
    ];
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(within(screen.getByTestId("reception-cell-1-10")).getByText("Phones")).toBeVisible();
  });

  it("breaks the run when the role differs, showing the chip again", () => {
    const sessions = [
      makeReceptionMasterSession({ staff_id: 1, hour: 9, role: "phones", note: null }),
      makeReceptionMasterSession({ staff_id: 1, hour: 9.5, role: "phones", note: null }),
      makeReceptionMasterSession({ staff_id: 1, hour: 10, role: "other", note: null }),
    ];
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(within(screen.getByTestId("reception-cell-1-10")).getByText("Other")).toBeVisible();
  });

  it("breaks the run at an absent slot, showing the chip again after the gap", () => {
    const sessions = [
      makeReceptionMasterSession({ staff_id: 1, hour: 9, role: "phones", note: null }),
      makeReceptionMasterSession({ staff_id: 1, hour: 10, role: "phones", note: null }),
    ];
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(within(screen.getByTestId("reception-cell-1-10")).getByText("Phones")).toBeVisible();
  });

  it("a continuation slot still opens its own popover and saves only its own half hour", async () => {
    const onSave = resolvedOnSave();
    const sessions = [9, 9.5, 10].map((hour) =>
      makeReceptionMasterSession({ session_id: hour * 10, staff_id: 1, hour, role: "phones", note: null }),
    );
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    const continuationCell = screen.getByTestId("reception-cell-1-9.5");
    await user.click(within(continuationCell).getByText("Phones"));
    await user.selectOptions(await screen.findByLabelText("Role"), "other");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith([
      { staffId: 1, hour: 9.5, session: sessions[1], role: "other", note: null },
    ]);
  });

  it("a shift-click range starting mid-run still highlights per slot", async () => {
    const sessions = [9, 9.5, 10, 10.5].map((hour) =>
      makeReceptionMasterSession({ staff_id: 1, hour, role: "phones", note: null }),
    );
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9.5")).getByText("Phones"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-10.5")).getByText("Phones"));

    expect(screen.getByTestId("reception-cell-1-9.5")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
  });
});

describe("ReceptionGrid: coverage warnings", () => {
  function shortfall(hour: number): ValidationIssue {
    return {
      severity: "warning",
      phase: "coverage",
      check: "phones_shortfall",
      message: `${formatHour(hour)}: 1 staff on phones, 2 required`,
      week: null,
      day: "Monday",
      period: null,
    };
  }

  it("renders a marker on the hour column with a matching shortfall, and none elsewhere", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[]}
        sessions={[]}
        issues={[shortfall(9)]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.getByLabelText("Coverage shortfall at 09:00-09:30")).toBeInTheDocument();
    expect(screen.queryByLabelText("Coverage shortfall at 08:00-08:30")).not.toBeInTheDocument();
  });

  it("renders no markers when issues is absent (master template page)", () => {
    renderWithProviders(
      <ReceptionGrid staff={[]} sessions={[]} onSave={resolvedOnSave()} onDelete={resolvedOnDelete()} saving={false} />,
    );
    expect(screen.queryByLabelText(/Coverage shortfall/)).not.toBeInTheDocument();
  });
});

describe("selectedRangeHours", () => {
  it("returns the forward range between anchor and focus, inclusive", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 9, focusHour: 11 }, 1)).toEqual([9, 9.5, 10, 10.5, 11]);
  });

  it("returns the same range when focus precedes anchor", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 11, focusHour: 9 }, 1)).toEqual([9, 9.5, 10, 10.5, 11]);
  });

  it("returns a single hour when anchor and focus match", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 9, focusHour: 9 }, 1)).toEqual([9]);
  });

  it("returns an empty range when the selection belongs to a different staff row", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 9, focusHour: 11 }, 2)).toEqual([]);
  });

  it("returns an empty range when there is no selection", () => {
    expect(selectedRangeHours(null, 1)).toEqual([]);
  });
});

/**
 * A run's first cell renders two nodes with the same text (an invisible
 * spacer plus the visible, centred chip) - this picks out the visible one
 * via jest-dom's own visibility check, since jsdom has no `checkVisibility`.
 */
function isVisible(element: HTMLElement): boolean {
  try {
    expect(element).toBeVisible();
    return true;
  } catch {
    return false;
  }
}

async function shiftClick(user: ReturnType<typeof userEvent.setup>, element: HTMLElement) {
  await user.keyboard("{Shift>}");
  await user.click(element);
  await user.keyboard("{/Shift}");
}

describe("ReceptionGrid: shift-click range select", () => {
  it("highlights every cell between anchor and focus, endpoints included", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-11:30"));

    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-10")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-11")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-8")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-12")).not.toHaveAttribute("data-selected", "true");
  });

  it("shift-click on a different row starts a fresh single-cell selection there", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[
          makeReceptionStaff({ id: 1, code: "AB", active: true }),
          makeReceptionStaff({ id: 2, code: "CD", active: true }),
        ]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-2-10")).getByLabelText("Add session for CD 10:00-10:30"));

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-2-10")).toHaveAttribute("data-selected", "true");
  });

  it("a plain click after a range collapses the selection back to one cell", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-11:30"));
    await user.click(within(screen.getByTestId("reception-cell-1-10")).getByLabelText("Add session for AB 10:00-10:30"));

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-11")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-10")).toHaveAttribute("data-selected", "true");
  });

  it("Escape clears the selection", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");

    await user.keyboard("{Escape}");

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
  });

  it("saving a range calls onSave once with one payload per half-hour, ascending by hour, mixing filled and empty hours", async () => {
    const onSave = resolvedOnSave();
    const session = makeReceptionMasterSession({ session_id: 5, staff_id: 1, hour: 10, role: "phones", note: null });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-11:30"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith([
      { staffId: 1, hour: 9, session: null, role: "phones", note: null },
      { staffId: 1, hour: 9.5, session: null, role: "phones", note: null },
      { staffId: 1, hour: 10, session, role: "phones", note: null },
      { staffId: 1, hour: 10.5, session: null, role: "phones", note: null },
      { staffId: 1, hour: 11, session: null, role: "phones", note: null },
    ]);
  });

  it("on an inactive staff row, a range spanning an empty hour omits it from both the highlight and the payload", async () => {
    const onSave = resolvedOnSave();
    const session9 = makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9, role: "phones", note: null });
    const session11 = makeReceptionMasterSession({ session_id: 2, staff_id: 1, hour: 11, role: "phones", note: null });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[session9, session11]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByText("Phones"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByText("Phones"));

    expect(screen.getByTestId("reception-cell-1-10")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-10")).toBeEmptyDOMElement();

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([
      { staffId: 1, hour: 9, session: session9, role: "phones", note: null },
      { staffId: 1, hour: 11, session: session11, role: "phones", note: null },
    ]);
  });

  it("typing in the popover's note field does not collapse the selection back to one cell", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-11:30"));

    // The popover portals out to document.body but stays inside the cell's
    // React tree, so without the containment guard in handleCellClick every
    // click in here reads as a plain click on the focus cell.
    await user.click(await screen.findByLabelText("Note"));
    await user.type(screen.getByLabelText("Note"), "cover");

    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-10")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-11")).toHaveAttribute("data-selected", "true");
    expect(await screen.findByText("Editing 5 slots")).toBeInTheDocument();
  });

  it("changing the role dropdown mid-range does not collapse the selection back to one cell", async () => {
    const onSave = resolvedOnSave();
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-11:30"));

    await user.selectOptions(await screen.findByLabelText("Role"), "prescriptions");
    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-11")).toHaveAttribute("data-selected", "true");

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([
      { staffId: 1, hour: 9, session: null, role: "prescriptions", note: null },
      { staffId: 1, hour: 9.5, session: null, role: "prescriptions", note: null },
      { staffId: 1, hour: 10, session: null, role: "prescriptions", note: null },
      { staffId: 1, hour: 10.5, session: null, role: "prescriptions", note: null },
      { staffId: 1, hour: 11, session: null, role: "prescriptions", note: null },
    ]);
  });

  it("keeps the highlight when onSave resolves false, and clears it when onSave resolves true", async () => {
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");

    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
  });
});

describe("ReceptionGrid: staff on leave", () => {
  it("dims and labels a staff member on leave without removing their sessions", () => {
    const session = makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        staffOnLeave={[1]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );

    expect(screen.getByText("On leave")).toBeInTheDocument();
    // The row is still rendered in full - leave only changes the coverage
    // headcount, never the rows themselves.
    expect(screen.getByTestId("reception-cell-1-9")).toHaveTextContent("Phones");
    expect(screen.getByTestId("reception-cell-1-9").className).toContain("opacity-50");
  });

  it("leaves other staff undimmed, and dims nobody when the prop is absent", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[
          makeReceptionStaff({ id: 1, code: "AB", active: true }),
          makeReceptionStaff({ id: 2, code: "CD", active: true }),
        ]}
        sessions={[]}
        staffOnLeave={[1]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );

    expect(screen.getAllByText("On leave")).toHaveLength(1);
    expect(screen.getByTestId("reception-cell-2-9").className).not.toContain("opacity-50");
  });

  it("keeps an on-leave staff member's cells clickable", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9 })]}
        staffOnLeave={[1]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );

    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByText("Phones"));

    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("ReceptionGrid: in-flight range writes", () => {
  /**
   * A save/delete callback that stays pending until the test resolves it -
   * standing in for the page's sequential per-hour writes, which is the
   * window the grid draws the finished range in.
   */
  function deferred() {
    let settle: (ok: boolean) => void = () => {};
    const fn = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => (settle = resolve)));
    return { fn, finish: (ok: boolean) => act(async () => settle(ok)) };
  }

  async function selectAndSaveRange(onSave: ReturnType<typeof deferred>["fn"]) {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-10")).getByLabelText("Add session for AB 10:00-10:30"));
    await user.selectOptions(await screen.findByLabelText("Role"), "prescriptions");
    await user.click(screen.getByRole("button", { name: "Save" }));
  }

  it("draws the whole range merged as soon as Save is clicked, before any write has landed", async () => {
    const { fn, finish } = deferred();
    await selectAndSaveRange(fn);

    // One transition, not one per hour: every cell in the range already
    // shows the new role, and only the first is a run head.
    const head = screen.getByTestId("reception-cell-1-9");
    expect(within(head).getAllByText("Prescriptions")).toHaveLength(2);
    expect(head).not.toHaveAttribute("data-run-continuation", "true");
    for (const hour of [9.5, 10]) {
      const cell = screen.getByTestId(`reception-cell-1-${hour}`);
      expect(within(cell).getByText("Prescriptions")).toBeInTheDocument();
      expect(cell).toHaveAttribute("data-run-continuation", "true");
    }

    await finish(true);
  });

  it("drops the drawn range when the writes fail, putting the cells back as they were", async () => {
    const { fn, finish } = deferred();
    await selectAndSaveRange(fn);
    expect(screen.getByTestId("reception-cell-1-9.5")).toHaveAttribute("data-run-continuation", "true");

    await finish(false);

    expect(screen.queryByText("Prescriptions")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"),
    ).toBeInTheDocument();
  });

  it("empties the whole range as soon as Remove is clicked", async () => {
    const { fn, finish } = deferred();
    const sessions = [9, 9.5, 10].map((hour) =>
      makeReceptionMasterSession({ session_id: hour * 10, staff_id: 1, hour, role: "phones", note: null }),
    );
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={sessions}
        onSave={resolvedOnSave()}
        onDelete={fn}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    // the run head carries two copies of the chip (spacer + centred), so index the first
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getAllByText("Phones")[0]);
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-10")).getByText("Phones"));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(screen.queryByText("Phones")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("reception-cell-1-10")).getByLabelText("Add session for AB 10:00-10:30"),
    ).toBeInTheDocument();

    await finish(true);
  });
});

describe("ReceptionGrid: run sizing", () => {
  /**
   * jsdom does no layout, so the width contribution is asserted through the
   * class that removes it: inside a run the in-flow (invisible) copy of the
   * chip is zero-width and clipped, so a merged run's columns are not
   * stretched to fit a label the run only draws once. A lone slot keeps its
   * full-width copy - that column does have to hold the label by itself.
   */
  function inFlowChip(hour: number): HTMLElement {
    return within(screen.getByTestId(`reception-cell-1-${hour}`)).getAllByText("Prescriptions")[0]
      .parentElement as HTMLElement;
  }

  it("contributes no width from the invisible copy in a run's cells, and full width in a lone slot", () => {
    const run = [9, 9.5, 10].map((hour) =>
      makeReceptionMasterSession({ session_id: hour * 10, staff_id: 1, hour, role: "prescriptions", note: null }),
    );
    const lone = makeReceptionMasterSession({
      session_id: 999,
      staff_id: 1,
      hour: 11,
      role: "prescriptions",
      note: null,
    });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[...run, lone]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );

    for (const hour of [9, 9.5, 10]) {
      expect(inFlowChip(hour).className).toContain("w-0");
    }
    expect(inFlowChip(11).className).not.toContain("w-0");
  });
});
