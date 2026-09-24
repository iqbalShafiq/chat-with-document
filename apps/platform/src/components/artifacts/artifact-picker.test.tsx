import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPicker, decodeArtifactChoice } from "./artifact-picker";

describe("ArtifactPicker", () => {
  it("shows an empty state scoped to the artifact type", () => {
    const html = renderToStaticMarkup(
      <ArtifactPicker sessionId="s1" artifactType="image" value={null} onSelect={() => {}} autoLoad={false} />,
    );
    expect(html).toContain("No image artifacts in this scope yet.");
  });

  it("exposes a radiogroup label for screen readers", () => {
    const html = renderToStaticMarkup(
      <ArtifactPicker sessionId="s1" artifactType="site" value={null} onSelect={() => {}} autoLoad={false} />,
    );
    expect(html).toContain("No site artifacts in this scope yet.");
  });

  it("decodes agent artifact choices and rejects plain text", () => {
    expect(decodeArtifactChoice("artifact:image:img-1")).toEqual({ type: "image", id: "img-1" });
    expect(decodeArtifactChoice("artifact:site:abc")).toEqual({ type: "site", id: "abc" });
    expect(decodeArtifactChoice("just text")).toBeNull();
    expect(decodeArtifactChoice("artifact:nocolon")).toBeNull();
  });
});
