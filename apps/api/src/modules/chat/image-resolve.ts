export type ResolvedImageReference = {
  mediaType: string;
  buffer: Uint8Array;
};

export type ImageResolveDeps = {
  getGeneratedImage(id: string): Promise<{
    id: string;
    userId: string;
    r2Key: string;
    mediaType: string;
  } | null>;
  getObjectBuffer(r2Key: string): Promise<Uint8Array>;
  findDocumentImage(
    imageId: string,
    userId: string,
    sessionId: string,
  ): Promise<ResolvedImageReference | null>;
};

/**
 * Resolve an image reference id the model passed to edit_image. The id may be
 * a GeneratedImage id (checked first, gated on user ownership) or a document
 * page image id (looked up via the injected document finder). Null when the
 * id is unknown or the bytes cannot be fetched.
 */
export async function resolveImageReference(
  input: { imageId: string; userId: string; sessionId: string },
  deps: ImageResolveDeps,
): Promise<ResolvedImageReference | null> {
  const image = await deps.getGeneratedImage(input.imageId);
  if (image && image.userId === input.userId) {
    try {
      const buffer = await deps.getObjectBuffer(image.r2Key);
      return { mediaType: image.mediaType, buffer };
    } catch {
      return null;
    }
  }
  return deps.findDocumentImage(input.imageId, input.userId, input.sessionId);
}
