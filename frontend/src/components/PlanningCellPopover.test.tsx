import * as Popover from "@radix-ui/react-popover";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ExtraSessionCompensation } from "@/api/types";
import type { PlanningCellState } from "@/lib/planningMonth";

import { PlanningCellPopover } from "./PlanningCellPopover";

/**
 * The popover renders no Root of its own (the grid owns it - see the
 * component's docstring), so every test mounts it inside one. Most of the
 * selection behaviour is covered through the grid in
 * LeavePlanningGrid.test.tsx; these are the compensation field's own rules,
 * which are easier to state here than through a drag.
 */
function renderPopover(
  overrides: Partial<Parameters<typeof PlanningCellPopover>[0]> = {},
) {
  const onApply = vi.fn();
  render(
    <Popover.Root open>
      <Popover.Anchor />
      <PlanningCellPopover
        open
        onOpenChange={() => {}}
        state={"extra_session" as PlanningCellState}
        notes=""
        compensation={null}
        toilAllowed
        doctorTypeLabel="Partner"
        cellCount={1}
        onApply={onApply}
        {...overrides}
      />
    </Popover.Root>,
  );
  return { onApply };
}

const compensationSelect = () => screen.getByTestId("planning-cell-compensation-select");

describe("PlanningCellPopover compensation", () => {
  it("shows the field only while the draft state is an extra session", async () => {
    const user = userEvent.setup();
    renderPopover({ state: "leave" });

    expect(screen.queryByTestId("planning-cell-compensation-select")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("planning-cell-state-select"), "extra_session");
    expect(compensationSelect()).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("planning-cell-state-select"), "blocked");
    expect(screen.queryByTestId("planning-cell-compensation-select")).not.toBeInTheDocument();
  });

  it("defaults a cell that is not already an extra session to Payment", () => {
    renderPopover({ compensation: null });
    expect(compensationSelect()).toHaveValue("Payment");
  });

  it("prefills the selection's own compensation", () => {
    renderPopover({ compensation: "TOIL" as ExtraSessionCompensation });
    expect(compensationSelect()).toHaveValue("TOIL");
  });

  it("applies the picked compensation, and null for any other state", async () => {
    const user = userEvent.setup();
    const { onApply } = renderPopover();

    await user.selectOptions(compensationSelect(), "TOIL");
    await user.click(screen.getByTestId("planning-cell-apply"));
    expect(onApply).toHaveBeenLastCalledWith("extra_session", "", "TOIL");

    await user.selectOptions(screen.getByTestId("planning-cell-state-select"), "leave");
    await user.click(screen.getByTestId("planning-cell-apply"));
    expect(onApply).toHaveBeenLastCalledWith("leave", "", null);
  });

  it("disables TOIL and names the doctor type when there is no entitlement", () => {
    renderPopover({ toilAllowed: false, doctorTypeLabel: "Locum" });

    expect(screen.getByRole("option", { name: "TOIL" })).toBeDisabled();
    expect(screen.getByText(/Locum doctors have no leave entitlement/)).toBeInTheDocument();
  });

  it("blocks Apply on a TOIL row whose doctor type lost its entitlement", () => {
    // The option is disabled rather than removed, so the select still shows
    // what the row actually says - Apply is what is withheld.
    renderPopover({ toilAllowed: false, compensation: "TOIL" as ExtraSessionCompensation });

    expect(compensationSelect()).toHaveValue("TOIL");
    expect(screen.getByTestId("planning-cell-apply")).toBeDisabled();
  });
});
