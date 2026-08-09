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
  /** Backoff delays (ms) between retries of transient failures. Default [1000, 2000]. */
  retryDelaysMs?: number[];
};

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000];

/** HTTP statuses that are safe to retry (rate limit + server-side errors). */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

/** OpenRouter 400s can be transient ("provider temporarily overloaded"). */
function isTransientMessage(message: string): boolean {
  return /temporarily|overload|busy|unavailable|try again|rate limit/i.test(
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the upstream `error.message` from an OpenRouter error body, bounded
 * to a short, non-sensitive string (the API may echo the prompt in errors).
 */
function upstreamMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { error?: unknown };
  if (!record.error || typeof record.error !== "object") return null;
  const message = (record.error as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim().length === 0) return null;
  const cleaned = message.trim().replace(/\s+/g, " ");
  return cleaned.length > 160 ? `${cleaned.slice(0, 160)}…` : cleaned;
}

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
  private readonly retryDelaysMs: number[];

  constructor(options: OpenRouterImageGenerationModelOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultModel = options.defaultModel ?? "openai/gpt-5-image-mini";
    this.fetchFn = options.fetchFn ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
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
    let lastError: Error | null = null;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}/images`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch {
        // Network failure — bounded message, retried like a transient error.
        lastError = new Error("Image generation temporarily unavailable");
        if (attempt >= this.retryDelaysMs.length) throw lastError;
        await sleep(this.retryDelaysMs[attempt] ?? 0);
        continue;
      }

      if (!response.ok) {
        const upstream = upstreamMessage(
          await response.json().catch(() => null),
        );
        const transient =
          isTransientStatus(response.status) ||
          (upstream !== null && isTransientMessage(upstream));
        lastError = new Error(
          upstream ?? mapOpenRouterImageError({ status: response.status }),
        );
        if (!transient || attempt >= this.retryDelaysMs.length) {
          throw lastError;
        }
        await sleep(this.retryDelaysMs[attempt] ?? 0);
        continue;
      }

      raw = await response.json();
      break;
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
