import { describe, expect, it } from "vitest";
import type { UIMessage } from "@anvia/react";
import { computeGenerationActionInfo } from "./message-text";

function textMessage(
  id: string,
  role: UIMessage["role"],
  text: string,
): UIMessage {
  return {
    id,
    role,
    parts:
      role === "assistant" || role === "user"
        ? [{ id: `p-${id}`, type: "text", text }]
        : [],
  };
}

function toolMessage(id: string): UIMessage {
  return { id, role: "tool", parts: [] };
}

describe("computeGenerationActionInfo", () => {
  it("marks only the final assistant message of a generation as the end", () => {
    const messages = [
      textMessage("u1", "user", "buatkan gambar"),
      textMessage("a1", "assistant", "Saya akan menggambar."),
      toolMessage("t1"),
      textMessage("a2", "assistant", "Ini hasilnya:"),
      textMessage("u2", "user", "bagus, satu lagi"),
      textMessage("a3", "assistant", "Done."),
    ];

    const info = computeGenerationActionInfo(messages);

    expect(info.get("a1")).toEqual({
      isGenerationEnd: false,
      generationText: "Saya akan menggambar.\n\nIni hasilnya:",
    });
    expect(info.get("a2")).toEqual({
      isGenerationEnd: true,
      generationText: "Saya akan menggambar.\n\nIni hasilnya:",
    });
    expect(info.get("a3")).toEqual({
      isGenerationEnd: true,
      generationText: "Done.",
    });
  });

  it("combines text only from assistant messages, skipping empty ones", () => {
    const messages = [
      textMessage("u1", "user", "halo"),
      textMessage("a1", "assistant", ""),
      toolMessage("t1"),
      textMessage("a2", "assistant", "Balasan akhir"),
    ];

    const info = computeGenerationActionInfo(messages);

    expect(info.get("a2")).toEqual({
      isGenerationEnd: true,
      generationText: "Balasan akhir",
    });
  });

  it("handles a single assistant generation at the end of the list", () => {
    const messages = [
      textMessage("u1", "user", "halo"),
      textMessage("a1", "assistant", "satu"),
      toolMessage("t1"),
      textMessage("a2", "assistant", "dua"),
    ];

    const info = computeGenerationActionInfo(messages);

    expect(info.get("a1")).toEqual({
      isGenerationEnd: false,
      generationText: "satu\n\ndua",
    });
    expect(info.get("a2")).toEqual({
      isGenerationEnd: true,
      generationText: "satu\n\ndua",
    });
  });

  it("returns an empty map when there are no assistant messages", () => {
    const messages = [textMessage("u1", "user", "halo")];
    expect(computeGenerationActionInfo(messages).size).toBe(0);
  });
});
