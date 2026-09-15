import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecruitmentOpenStage } from "./RecruitmentOpenStage";

describe("RecruitmentOpenStage", () => {
  it("says there is more to come rather than guessing at fields", () => {
    render(<RecruitmentOpenStage stage="recruitment_open" />);

    expect(screen.getByText("More to come here.")).toBeInTheDocument();
    expect(screen.getByText(/not recorded here yet/)).toBeInTheDocument();
  });

  // The two later stages share this body until their own plan lands, so
  // the copy has to read sensibly for them too.
  it("drops the recruitment wording for the later stages", () => {
    render(<RecruitmentOpenStage stage="closed" />);

    expect(screen.getByText("More to come here.")).toBeInTheDocument();
    expect(screen.getByText(/no page of its own yet/)).toBeInTheDocument();
  });
});
