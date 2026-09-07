// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchContextSnippet = vi.fn();
const upsertContextSnippet = vi.fn();
const removeContextSnippet = vi.fn();

vi.mock("#/lib/api", () => ({
  fetchContextSnippet: (...args: unknown[]) => fetchContextSnippet(...args),
  upsertContextSnippet: (...args: unknown[]) => upsertContextSnippet(...args),
  removeContextSnippet: (...args: unknown[]) => removeContextSnippet(...args),
}));

import { useContextSnippet } from "./use-context-snippet";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Probe({ sessionId }: { sessionId: string }) {
  const { error, snippet } = useContextSnippet(sessionId);
  return (
    <div>
      <span data-testid="error">{error ?? ""}</span>
      <span data-testid="snippet">{snippet?.id ?? ""}</span>
    </div>
  );
}

describe("useContextSnippet", () => {
  it("does not surface GET failures as composer errors", async () => {
    fetchContextSnippet.mockRejectedValue(new Error("Unauthorized"));
    render(<Probe sessionId="session-1" />);
    await waitFor(() => {
      expect(fetchContextSnippet).toHaveBeenCalledWith("session-1");
    });
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(screen.getByTestId("snippet").textContent).toBe("");
  });

  it("still surfaces pin mutation errors", async () => {
    fetchContextSnippet.mockResolvedValue(null);
    upsertContextSnippet.mockRejectedValue(new Error("Could not add context snippet"));

    function MutatingProbe() {
      const { error, setSnippet } = useContextSnippet("session-1");
      return (
        <div>
          <button type="button" onClick={() => void setSnippet("pinned text", "user")}>
            pin
          </button>
          <span data-testid="error">{error ?? ""}</span>
        </div>
      );
    }

    render(<MutatingProbe />);
    await waitFor(() => expect(fetchContextSnippet).toHaveBeenCalled());
    screen.getByRole("button", { name: "pin" }).click();
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("Could not add context snippet");
    });
  });
});
