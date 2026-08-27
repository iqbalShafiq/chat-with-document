// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

afterEach(() => {
  cleanup();
});

describe("EmptyState", () => {
  it("renders the editorial hero without starter prompts", () => {
    render(<EmptyState onSelectPrompt={() => {}} />);

    expect(screen.getByText(/What are you/i)).toBeTruthy();
    expect(screen.getByText(/trying to understand\?/i)).toBeTruthy();
    expect(screen.getByText(/ANREAL - NEW SESSION/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
