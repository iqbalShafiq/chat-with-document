import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const STUB_PORT = 18765;
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

const TRANSPARENT_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type RecordedRequest = {
  kind: "responses" | "images" | "models" | "other";
  url: string;
  body: unknown;
  receivedAt: string;
};

type StubState = {
  requests: RecordedRequest[];
  turns: Map<string, number>;
};

const state: StubState = { requests: [], turns: new Map() };

function hashConversation(body: { input?: unknown }): string {
  const anchor = lastUserText(body).slice(0, 600);
  return createHash("sha1").update(anchor).digest("hex").slice(0, 12);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function lastUserText(body: { input?: unknown }): string {
  const input = Array.isArray(body.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.role !== "user") continue;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) {
      return record.content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const p = part as Record<string, unknown>;
          return typeof p.text === "string" ? p.text : "";
        })
        .join(" ");
    }
    return "";
  }
  return "";
}

type Scenario = "generate" | "clarify" | "websearch" | "edit" | "fallback";

function scenarioFor(text: string): Scenario {
  if (text.includes("cari referensi")) return "websearch";
  if (text.includes("kurang jelas")) return "clarify";
  if (text.includes("edit")) return "edit";
  if (text.includes("gambar")) return "generate";
  return "fallback";
}

function generateImageArgs(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    prompt: text,
    modelId: "openai/gpt-5-image-mini",
    aspectRatio: "1:1",
  };
  if (text.includes("3 gambar")) args.n = 3;
  if (text.includes("background removed")) {
    args.background = "transparent";
  }
  return args;
}

function toolCallStream(
  args: Record<string, unknown>,
  toolName: string,
): string[] {
  const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
  const itemId = `fc_${Math.random().toString(36).slice(2, 10)}`;
  const responseId = `resp_${Math.random().toString(36).slice(2, 10)}`;
  const argumentsJson = JSON.stringify(args);
  const item = {
    id: itemId,
    type: "function_call",
    call_id: callId,
    name: toolName,
    arguments: argumentsJson,
    status: "completed",
  };
  return [
    sse("response.created", {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        model: "stub-model",
        sequence_number: 0,
      },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 1,
      item_id: itemId,
      output_index: 0,
      item: { ...item, status: "in_progress" },
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item,
    }),
    sse("response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        model: "stub-model",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        sequence_number: 3,
      },
    }),
  ];
}

function textStream(text: string): string[] {
  const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
  const responseId = `resp_${Math.random().toString(36).slice(2, 10)}`;
  const part = { type: "output_text", text, annotations: [] };
  const messageItem = {
    id: messageId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [part],
  };
  return [
    sse("response.created", {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        model: "stub-model",
        sequence_number: 0,
      },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 1,
      item_id: messageId,
      output_index: 0,
      item: { ...messageItem, status: "in_progress", content: [] },
    }),
    sse("response.content_part.added", {
      type: "response.content_part.added",
      sequence_number: 2,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: "" },
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    sse("response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    }),
    sse("response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: 5,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part,
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: messageItem,
    }),
    sse("response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        model: "stub-model",
        output: [messageItem],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        sequence_number: 7,
      },
    }),
  ];
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function clarifyQuestions(): Record<string, unknown> {
  return {
    title: "Klarifikasi gambar",
    questions: [
      {
        id: "q1",
        question: "Gaya visual apa yang kamu inginkan?",
        type: "single_choice",
        options: [
          { id: "minimalis", label: "A minimalis", recommended: true },
          { id: "neon", label: "B neon" },
        ],
      },
      {
        id: "q2",
        question: "Mau tambah detail lain?",
        type: "free_text",
        optional: true,
        placeholder: "Ceritakan detailnya…",
      },
    ],
  };
}

function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function handleResponses(
  res: ServerResponse,
  body: { input?: unknown },
) {
  const text = lastUserText(body);
  const conversationId = hashConversation(body);
  const turn = (state.turns.get(conversationId) ?? 0) + 1;
  state.turns.set(conversationId, turn);
  const scenario = scenarioFor(text);

  let events: string[];
  if (turn === 1 && scenario === "generate") {
    events = toolCallStream(generateImageArgs(text), "generate_image");
  } else if (turn === 1 && scenario === "clarify") {
    events = toolCallStream(clarifyQuestions(), "request_clarification");
  } else if (turn === 1 && scenario === "websearch") {
    events = toolCallStream(
      { query: "kucing main di taman", reason: "riset referensi visual" },
      "web_search",
    );
  } else if (turn === 1 && scenario === "edit") {
    events = toolCallStream(
      { prompt: "jadikan watercolor", referenceImageId: "ref-img-1" },
      "edit_image",
    );
  } else if (turn === 2 && scenario === "clarify") {
    events = toolCallStream(
      { prompt: text, modelId: "openai/gpt-5-image-mini", aspectRatio: "16:9" },
      "generate_image",
    );
  } else if (turn === 2 && scenario === "websearch") {
    events = toolCallStream(
      { prompt: text, modelId: "openai/gpt-5-image-mini", aspectRatio: "1:1" },
      "generate_image",
    );
  } else {
    events = textStream(`Selesai: ${scenario} (turn ${turn})`);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) {
    res.write(event);
  }
  res.end();
}

function handleImages(res: ServerResponse, body: Record<string, unknown>) {
  const count =
    typeof body.n === "number" && body.n >= 1 ? Math.min(body.n, 10) : 1;
  const data = Array.from({ length: count }, () => ({
    b64_json: TRANSPARENT_1X1_PNG_BASE64,
    media_type: "image/png",
  }));
  respondJson(res, 200, { data });
}

export function startStubServer(port = STUB_PORT): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        res.end();
        return;
      }

      if (req.method === "POST" && pathname === "/__reset") {
        state.requests = [];
        state.turns.clear();
        respondJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/__requests") {
        respondJson(res, 200, { requests: state.requests });
        return;
      }

      if (req.method === "POST" && pathname === "/api/v1/images") {
        const body = await readJsonBody(req);
        state.requests.push({
          kind: "images",
          url,
          body: body ?? null,
          receivedAt: new Date().toISOString(),
        });
        handleImages(res, (body ?? {}) as Record<string, unknown>);
        return;
      }

      if (req.method === "POST" && pathname === "/api/v1/responses") {
        const body = await readJsonBody(req);
        state.requests.push({
          kind: "responses",
          url,
          body: body ?? null,
          receivedAt: new Date().toISOString(),
        });
        handleResponses(res, (body ?? {}) as { input?: unknown });
        return;
      }

      if (pathname === "/api/v1/models") {
        state.requests.push({
          kind: "models",
          url,
          body: null,
          receivedAt: new Date().toISOString(),
        });
        respondJson(res, 200, { data: [] });
        return;
      }

      state.requests.push({
        kind: "other",
        url,
        body: null,
        receivedAt: new Date().toISOString(),
      });
      respondJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error("[stub] request failed", error);
      respondJson(res, 500, { error: "stub error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[stub] listening on http://127.0.0.1:${port}`);
      resolve({
        port,
        close: () =>
          new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

export async function fetchStubState(
  port = STUB_PORT,
): Promise<{ requests: RecordedRequest[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/__requests`);
  return (await response.json()) as { requests: RecordedRequest[] };
}

const isStandalone = process.argv[1]?.endsWith("stub-openrouter.ts");
if (isStandalone) {
  startStubServer().catch((error) => {
    console.error("[stub] failed to start", error);
    process.exit(1);
  });
}
