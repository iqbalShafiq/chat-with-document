import { ocrModel } from "../providers/mistral.js";

export interface OcrPageImage {
  id: string;
  mediaType: string;
  /** Raw base64 without the `data:<type>;base64,` prefix. */
  base64: string;
  topLeftX: number | null;
  topLeftY: number | null;
  bottomRightX: number | null;
  bottomRightY: number | null;
  annotation?: string | null;
}

export interface OcrPage {
  index: number;
  markdown: string;
  images: OcrPageImage[];
}

/** `data:image/png;base64,AAAA...` → `{ mediaType: "image/png", base64: "AAAA..." }` */
function splitImageDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const mediaType = match[1] ?? "";
  const base64 = match[2] ?? "";
  if (mediaType.length === 0 || base64.length === 0) return null;
  return { mediaType, base64 };
}

function pickNumber(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): number | null {
  const raw = record[camel] ?? record[snake];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Mistral's raw `images` array: tolerate both snake_case and camelCase keys. */
function toOcrPageImages(raw: unknown): OcrPageImage[] {
  if (!Array.isArray(raw)) return [];
  const images: OcrPageImage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const imageBase64 = record.imageBase64 ?? record.image_base64;
    if (id === null || typeof imageBase64 !== "string") continue;
    const split = splitImageDataUrl(imageBase64);
    if (!split) continue;
    const annotation =
      typeof record.imageAnnotation === "string"
        ? record.imageAnnotation
        : typeof record.image_annotation === "string"
          ? record.image_annotation
          : null;
    images.push({
      id,
      mediaType: split.mediaType,
      base64: split.base64,
      topLeftX: pickNumber(record, "topLeftX", "top_left_x"),
      topLeftY: pickNumber(record, "topLeftY", "top_left_y"),
      bottomRightX: pickNumber(record, "bottomRightX", "bottom_right_x"),
      bottomRightY: pickNumber(record, "bottomRightY", "bottom_right_y"),
      ...(annotation === null ? {} : { annotation }),
    });
  }
  return images;
}

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
    includeImageBase64: true,
  });

  return {
    text: result.text,
    markdown: result.markdown,
    pages: result.pages.map((page) => ({
      index: page.index,
      markdown: page.markdown,
      images: toOcrPageImages(page.images),
    })),
    pageCount: result.pages.length,
  };
}
