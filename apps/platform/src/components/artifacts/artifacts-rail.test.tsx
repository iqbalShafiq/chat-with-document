// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listArtifacts: vi.fn(async (_input?: { type?: string }) => [] as unknown[]),
}));

vi.mock("#/lib/api-artifacts", () => ({
  listArtifacts: mocks.listArtifacts,
}));

import { ArtifactsRail } from "./artifacts-rail";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listArtifacts.mockImplementation(async (input?: { type?: string }) => {
    if (input?.type === "document") return [{ type: "document", id: "d1", filename: "Laporan.pdf" }];
    if (input?.type === "schedule") return [{ type: "schedule", id: "s1", title: "Brief harian" }];
    if (input?.type === "session") return [{ type: "session", sessionId: "c1", title: "Chat lama" }];
    return [];
  });
});

afterEach(cleanup);

describe("ArtifactsRail", () => {
  it("shows counts for every artifact type tab", async () => {
    render(<ArtifactsRail sessionId="s1" />);
    await screen.findByText("Laporan.pdf");
    for (const label of ["Docs", "Images", "Sites", "Tasks", "Sched", "Web", "Chats"]) {
      expect(screen.getByRole("tab", { name: new RegExp(label, "i") })).toBeTruthy();
    }
    expect(screen.getByRole("tab", { name: /docs.*1/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /sched.*1/i })).toBeTruthy();
  });

  it("switches tabs from cached pages without refetching", async () => {
    render(<ArtifactsRail sessionId="s1" />);
    await screen.findByText("Laporan.pdf");
    expect(mocks.listArtifacts).toHaveBeenCalledTimes(7);
    await userEvent.click(screen.getByRole("tab", { name: /sched/i }));
    expect(await screen.findByText("Brief harian")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: /chats/i }));
    expect(await screen.findByText("Chat lama")).toBeTruthy();
    await waitFor(() => expect(mocks.listArtifacts).toHaveBeenCalledTimes(7));
  });
});
