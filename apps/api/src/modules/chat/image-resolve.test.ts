import { describe, expect, it, vi } from "vitest";
import {
  resolveImageReference,
  type ImageResolveDeps,
} from "./image-resolve.js";

const OWNER = "user-1";
const OTHER = "user-2";
const SESSION = "session-1";

function makeDeps(overrides: Partial<ImageResolveDeps> = {}): ImageResolveDeps {
  return {
    getGeneratedImage: vi.fn(async () => null),
    getObjectBuffer: vi.fn(async () => new Uint8Array([1, 2, 3])),
    findDocumentImage: vi.fn(async () => null),
    ...overrides,
  };
}

describe("resolveImageReference", () => {
  it("returns the generated image when it exists and belongs to the user", async () => {
    const deps = makeDeps({
      getGeneratedImage: vi.fn(async () => ({
        id: "img-1",
        userId: OWNER,
        r2Key: "images/user-1/key",
        mediaType: "image/png",
      })),
    });
    const result = await resolveImageReference(
      { imageId: "img-1", userId: OWNER, sessionId: SESSION },
      deps,
    );
    expect(result).toEqual({
      mediaType: "image/png",
      buffer: new Uint8Array([1, 2, 3]),
    });
    expect(deps.getObjectBuffer).toHaveBeenCalledWith("images/user-1/key");
    expect(deps.findDocumentImage).not.toHaveBeenCalled();
  });

  it("falls through to the document lookup when the image belongs to another user", async () => {
    const deps = makeDeps({
      getGeneratedImage: vi.fn(async () => ({
        id: "img-1",
        userId: OTHER,
        r2Key: "images/other/key",
        mediaType: "image/png",
      })),
      findDocumentImage: vi.fn(async () => ({
        mediaType: "image/jpeg",
        buffer: new Uint8Array([9]),
      })),
    });
    const result = await resolveImageReference(
      { imageId: "img-1", userId: OWNER, sessionId: SESSION },
      deps,
    );
    expect(result).toEqual({ mediaType: "image/jpeg", buffer: new Uint8Array([9]) });
    expect(deps.getObjectBuffer).not.toHaveBeenCalled();
    expect(deps.findDocumentImage).toHaveBeenCalledWith("img-1", OWNER, SESSION);
  });

  it("returns null when neither lookup finds the image", async () => {
    const result = await resolveImageReference(
      { imageId: "missing", userId: OWNER, sessionId: SESSION },
      makeDeps(),
    );
    expect(result).toBeNull();
  });

  it("returns null when fetching the owned image bytes fails", async () => {
    const deps = makeDeps({
      getGeneratedImage: vi.fn(async () => ({
        id: "img-1",
        userId: OWNER,
        r2Key: "images/user-1/key",
        mediaType: "image/png",
      })),
      getObjectBuffer: vi.fn(async () => {
        throw new Error("r2 down");
      }),
      findDocumentImage: vi.fn(async () => ({
        mediaType: "image/jpeg",
        buffer: new Uint8Array([9]),
      })),
    });
    const result = await resolveImageReference(
      { imageId: "img-1", userId: OWNER, sessionId: SESSION },
      deps,
    );
    expect(result).toBeNull();
  });

  it("returns the document image via the document lookup when no generated image exists", async () => {
    const deps = makeDeps({
      findDocumentImage: vi.fn(async () => ({
        mediaType: "image/webp",
        buffer: new Uint8Array([4, 5]),
      })),
    });
    const result = await resolveImageReference(
      { imageId: "doc-img-1", userId: OWNER, sessionId: SESSION },
      deps,
    );
    expect(result).toEqual({
      mediaType: "image/webp",
      buffer: new Uint8Array([4, 5]),
    });
    expect(deps.getGeneratedImage).toHaveBeenCalledWith("doc-img-1");
  });
});
