import { ocrModel } from "../providers/mistral.js";

export async function runDocumentOcr(input: {
  filename: string;
  data: Uint8Array;
}) {
  const result = await ocrModel.ocr({
    source: {
      type: "bytes",
      data: input.data,
      filename: input.filename,
    },
    tableFormat: "markdown",
  });

  return {
    text: result.text,
    markdown: result.markdown,
    pages: result.pages.map((page) => ({
      index: page.index,
      markdown: page.markdown,
    })),
    pageCount: result.pages.length,
  };
}
