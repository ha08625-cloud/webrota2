import { describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { apiClient } from "@/api/client";
import { server } from "@/test/msw/server";

import { getToken } from "./tokenStore";
import { TokenGate } from "./TokenGate";

function renderGate() {
  const queryClient = new QueryClient();
  const resetSpy = vi.spyOn(queryClient, "resetQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <div>protected content</div>
      </TokenGate>
    </QueryClientProvider>,
  );
  return { resetSpy };
}

describe("TokenGate", () => {
  it("renders children by default", () => {
    renderGate();
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("shows the token prompt after a 401 and resets queries on submit", async () => {
    const { resetSpy } = renderGate();

    server.use(
      http.get("/api/v1/health-check", () => HttpResponse.json({}, { status: 401 })),
    );

    await expect(apiClient.get("/health-check")).rejects.toMatchObject({ status: 401 });

    expect(await screen.findByText("Enter access token")).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("API token"), "new-token");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(getToken()).toBe("new-token");
    expect(resetSpy).toHaveBeenCalledOnce();
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });
});