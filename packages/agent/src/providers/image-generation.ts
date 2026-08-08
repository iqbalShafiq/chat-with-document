import type {
  GeneratedImage,
  ImageGenerationModel,
  ImageGenerationRequest,
  ImageGenerationResponse,
} from "@anvia/core/image-generation";

export type OpenRouterImageGenerationModelOptions = {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  fetchFn?: typeof fetch;
};

/** Map OpenRouter image API failures to bounded, non-sensitive messages. */
export function mapOpenRouterImageError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Image generation temporarily unavailable";
  }
  const record = error as { status?: unknown; message?: unknown };
  const status =
    typeof record.status === "number" ? record.status : null;
  if (status === 401 || status === 403) {
    return "Image generation is not configured (invalid API key)";
  }
  if (status === 429) {
    return "Image generation rate limit exceeded; try again later";
  }
  if (status === 400) {
    return "Image generation rejected the request; adjust the parameters";
  }
  if (status === 502) {
    return "Image generation failed before billing; try again";
  }
  return "Image generation temporarily unavailable";
}

type OpenRouterImageItem = {
  b64_json?: unknown;
  media_type?: unknown;
};

type OpenRouterImageResponse = {
  data?: OpenRouterImageItem[] | undefined;
};

/** OpenRouter image generation via its dedicated `POST /images` API. */
export class OpenRouterImageGenerationModel
  implements ImageGenerationModel<unknown, string>
{
  readonly provider = "openrouter";
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenRouterImageGenerationModelOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultModel = options.defaultModel ?? "openai/gpt-5-image-mini";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async imageGeneration(
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResponse<unknown>> {
    const body: Record<string, unknown> = {
      model: this.defaultModel,
      prompt: request.prompt,
      size: `${request.width}x${request.height}`,
    };
    if (
      typeof request.additionalParams === "object" &&
      request.additionalParams !== null &&
      !Array.isArray(request.additionalParams)
    ) {
      Object.assign(body, request.additionalParams);
    }

    let raw: unknown;
    let httpError: Error | null = null;
    try {
      const response = await this.fetchFn(`${this.baseUrl}/images`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        httpError = new Error(
          mapOpenRouterImageError({ status: response.status }),
        );
        throw httpError;
      }
      raw = await response.json();
    } catch (error) {
      throw httpError ?? new Error("Image generation temporarily unavailable");
    }

    const data = (raw as OpenRouterImageResponse).data ?? [];
    const images: GeneratedImage[] = data.flatMap((item) => {
      if (typeof item.b64_json !== "string") {
        return [];
      }
      return [
        {
          data: Uint8Array.from(Buffer.from(item.b64_json, "base64")),
          ...(typeof item.media_type === "string"
            ? { mediaType: item.media_type }
            : {}),
        },
      ];
    });
    if (images.length === 0) {
      throw new Error("Image generation returned no usable images");
    }

    const first = images[0]!;
    return {
      image: first.data,
      images,
      ...(first.mediaType ? { mediaType: first.mediaType } : {}),
      rawResponse: raw,
    };
  }
}
