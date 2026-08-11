type HastNode = {
  type: string;
  tagName?: string;
  children?: HastNode[];
};

/**
 * Move a lone <img> out of its wrapping <p> (markdown renders `![alt](src)`
 * as a paragraph). react-markdown replaces <img> with DocumentImage, which
 * renders a block-level <div>/<button> — a <div> inside a <p> is invalid
 * HTML and triggers React's DOM-nesting/hydration warnings. Only unwraps
 * when the image is the paragraph's sole child, so inline images inside
 * prose stay put.
 */
export function rehypeUnwrapImages() {
  return (tree: HastNode) => {
    unwrapImagesIn(tree);
  };
}

function unwrapImagesIn(node: HastNode): void {
  if (!node.children) return;
  const children = node.children;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.type !== "element") continue;
    if (child.tagName === "p" && isLoneImageParagraph(child)) {
      const imageChildren = child.children ?? [];
      children.splice(i, 1, ...imageChildren);
      i += imageChildren.length - 1;
      continue;
    }
    unwrapImagesIn(child);
  }
}

function isLoneImageParagraph(node: HastNode): boolean {
  if (node.children?.length !== 1) return false;
  const only = node.children[0];
  return only.type === "element" && only.tagName === "img";
}
