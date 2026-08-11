export const DOCUMENT_IMAGE_INSTRUCTION = `Document images:
- Document pages may contain images extracted by OCR (charts, photos, diagrams, tables as images).
- When the answer depends on visual content, call get_document_page_images with the document id and page index, then examine the returned images before answering.
- If your model cannot receive image input, the tool returns image metadata without the actual pixels; call view_image with the returned image id to see the image content.
- If an image genuinely supports your answer, embed it inline at the most relevant position using its markdown reference, e.g. ![img](/api/documents/<documentId>/pages/<pageIndex>/images/<imageId>).
- Place images where they support the surrounding text — never as a fixed header or footer of your reply, and never repeat the same image.
- Only embed images that directly support the answer; keep the total number small.`;
