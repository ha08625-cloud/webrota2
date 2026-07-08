import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToastDisplay, mutationAppliedMessage } from "./Toast";

describe("mutationAppliedMessage", () => {
  it("returns plain 'Applied' when the issue count did not increase", () => {
    expect(mutationAppliedMessage(3, 3)).toBe("Applied");
  });

  it("returns plain 'Applied' when the issue count decreased", () => {
    expect(mutationAppliedMessage(3, 1)).toBe("Applied");
  });

  it("reports a single new warning with singular wording", () => {
    expect(mutationAppliedMessage(2, 3)).toBe("Applied - 1 new warning");
  });

  it("reports multiple new warnings with plural wording", () => {
    expect(mutationAppliedMessage(1, 4)).toBe("Applied - 3 new warnings");
  });

  it("handles a rise from zero issues", () => {
    expect(mutationAppliedMessage(0, 2)).toBe("Applied - 2 new warnings");
  });
});

describe("ToastDisplay", () => {
  it("renders nothing when there is no message", () => {
    const { container } = render(<ToastDisplay message={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the message as a status region", () => {
    render(<ToastDisplay message="Applied - 2 new warnings" />);
    expect(screen.getByRole("status")).toHaveTextContent("Applied - 2 new warnings");
  });
});