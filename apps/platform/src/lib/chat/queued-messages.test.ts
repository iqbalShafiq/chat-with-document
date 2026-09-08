import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addQueuedItem,
  applyQueuedAck,
  cancelQueuedEdit,
  chunkIds,
  consumeShareForkDraft,
  finishQueuedEdit,
  markQueuedItemsInflight,
  nextFlushableItem,
  pendingBeforeEditing,
  queueShareForkDraft,
  queueStorageKey,
  readQueue,
  removeQueuedItem,
  reorderQueuedItem,
  revertInflightItems,
  shareForkDraftKey,
  startQueuedEdit,
  writeQueue,
  type QueuedDraft,
  type QueuedItem,
} from "./queued-messages.js";

function createStorage(initial: Record<string, string> = {}) {
  const local = new Map(Object.entries(initial));
  const session = new Map<string, string>();
  const storage = {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => {
      local.set(key, value);
    },
    removeItem: (key: string) => {
      local.delete(key);
    },
    clear: () => local.clear(),
    key: (index: number) => [...local.keys()][index] ?? null,
    get length() {
      return local.size;
    },
  };
  const sessionStorage = {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => {
      session.set(key, value);
    },
    removeItem: (key: string) => {
      session.delete(key);
    },
    clear: () => session.clear(),
    key: (index: number) => [...session.keys()][index] ?? null,
    get length() {
      return session.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", sessionStorage);
  return { store: local, storage, sessionStore: session };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const draft: QueuedDraft = {
  text: "hello",
  attachments: [],
  documentIds: [],
  contextSnippet: null,
  pinnedImageIds: [],
};

const item = (id: string, patch: Partial<QueuedItem> = {}): QueuedItem => ({
  id,
  text: "hello",
  attachments: [],
  documentIds: [],
  contextSnippet: null,
  pinnedImageIds: [],
  status: "pending",
  ...patch,
});

describe("storage", () => {
  it("round-trips items with order preserved", () => {
    const { store } = createStorage();
    const items = [
      item("a", { text: "first" }),
      item("b", { text: "second" }),
    ];
    writeQueue("s1", items);
    expect(readQueue("s1")).toEqual(items);
    expect(store.has(queueStorageKey("s1"))).toBe(true);
  });

  it("drops invalid entries and normalizes statuses to pending", () => {
    const { store } = createStorage();
    store.set(
      queueStorageKey("s1"),
      JSON.stringify([
        item("a", { status: "editing" }),
        item("b", { status: "inflight" }),
        { id: "broken", text: 5 },
        "not-an-object",
      ]),
    );
    const restored = readQueue("s1");
    expect(restored).toHaveLength(2);
    expect(restored.every((entry) => entry.status === "pending")).toBe(true);
  });

  it("degrades to text-only items when the quota is exceeded", () => {
    const { storage } = createStorage();
    const withImage = item("a", {
      attachments: [
        { id: "att-1", type: "image", name: "x.png", data: "AAAA" },
      ],
    });
    vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    writeQueue("s1", [withImage]);
    const restored = readQueue("s1");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.attachments[0]?.data).toBeUndefined();
    expect(restored[0]?.attachments[0]?.name).toBe("x.png");
  });

  it("does not degrade on non-quota write errors", () => {
    const { store, storage } = createStorage();
    const withImage = item("a", {
      attachments: [
        { id: "att-1", type: "image", name: "x.png", data: "AAAA" },
      ],
    });
    store.set(queueStorageKey("s1"), JSON.stringify([withImage]));
    vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("denied", "SecurityError");
    });
    writeQueue("s1", [withImage]);
    const restored = readQueue("s1");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.attachments[0]?.data).toBe("AAAA");
  });

  it("returns an empty list for missing or corrupt storage", () => {
    const { store } = createStorage();
    expect(readQueue("s1")).toEqual([]);
    store.set(queueStorageKey("s1"), "{corrupt");
    expect(readQueue("s1")).toEqual([]);
  });
});

describe("mutations", () => {
  it("adds, removes, and reorders items", () => {
    const base: QueuedItem[] = [];
    const withA = addQueuedItem(base, item("a"));
    const withB = addQueuedItem(withA, item("b"));
    expect(withB.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(removeQueuedItem(withB, "a").map((entry) => entry.id)).toEqual(["b"]);
    expect(reorderQueuedItem(withB, 0, 1).map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
    expect(reorderQueuedItem(withB, 0, 0)).toEqual(withB);
    expect(reorderQueuedItem(withB, 5, 1)).toEqual(withB);
  });

  it("marks inflight, reverts, and acks", () => {
    const items = [item("a"), item("b")];
    const inflight = markQueuedItemsInflight(items, new Set(["a"]));
    expect(inflight[0]?.status).toBe("inflight");
    expect(inflight[1]?.status).toBe("pending");
    expect(revertInflightItems(inflight).every((entry) => entry.status === "pending")).toBe(true);
    expect(applyQueuedAck(inflight, "a").map((entry) => entry.id)).toEqual(["b"]);
  });

  it("supports the edit lifecycle without changing the slot", () => {
    const items = [item("a"), item("b")];
    const editing = startQueuedEdit(items, "a");
    expect(editing[0]?.status).toBe("editing");
    const done = finishQueuedEdit(editing, "a", { ...draft, text: "edited" });
    expect(done[0]?.text).toBe("edited");
    expect(done[0]?.status).toBe("pending");
    expect(done.map((entry) => entry.id)).toEqual(["a", "b"]);
    const cancelled = cancelQueuedEdit(editing, "a");
    expect(cancelled[0]?.text).toBe("hello");
    expect(cancelled[0]?.status).toBe("pending");
  });

  it("nextFlushableItem stops at an editing item", () => {
    expect(nextFlushableItem([item("a")])?.item.id).toBe("a");
    expect(nextFlushableItem([])).toBeNull();
    const inflight = item("a", { status: "inflight" });
    const pending = item("b");
    expect(nextFlushableItem([inflight, pending])?.item.id).toBe("b");
    const editing = item("a", { status: "editing" });
    expect(nextFlushableItem([editing, pending])).toBeNull();
  });

  it("pendingBeforeEditing collects pendings until the first editing item", () => {
    const pendingA = item("a");
    const pendingB = item("b");
    const editing = item("c", { status: "editing" });
    const pendingD = item("d");
    expect(
      pendingBeforeEditing([pendingA, pendingB, editing, pendingD]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("chunkIds splits ids into capped chunks", () => {
    expect(chunkIds(["a", "b", "c", "d"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(chunkIds([], 2)).toEqual([]);
  });

  it("chunkIds splits arbitrary item arrays into capped chunks", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(chunkIds(items, 2)).toEqual([[{ id: "a" }, { id: "b" }], [{ id: "c" }]]);
    expect(chunkIds(items, 1)).toEqual([[{ id: "a" }], [{ id: "b" }], [{ id: "c" }]]);
  });

  it("chunkIds with a non-positive size returns empty", () => {
    expect(chunkIds(["a", "b"], 0)).toEqual([]);
    expect(chunkIds(["a", "b"], -1)).toEqual([]);
  });
});

describe("share fork handoff draft", () => {
  it("round-trips a one-shot draft and consumes it exactly once", () => {
    createStorage();
    queueShareForkDraft("fork-1", {
      text: "what about the second part?",
      attachments: [],
      webSearchEnabled: true,
      deepResearchEnabled: false,
      imageGenerationEnabled: false,
      imageGenSettings: { modelId: "img-model" },
    });
    const first = consumeShareForkDraft("fork-1");
    expect(first?.text).toBe("what about the second part?");
    expect(first?.webSearchEnabled).toBe(true);
    expect(first?.imageGenSettings).toEqual({ modelId: "img-model" });
    expect(consumeShareForkDraft("fork-1")).toBeNull();
  });

  it("drops empty, corrupt, and cross-session drafts without re-sending", () => {
    const { sessionStore } = createStorage();
    queueShareForkDraft("fork-1", {
      text: "   ",
      attachments: [],
      webSearchEnabled: false,
      deepResearchEnabled: false,
      imageGenerationEnabled: false,
      imageGenSettings: {},
    });
    expect(consumeShareForkDraft("fork-1")).toBeNull();
    sessionStore.set(shareForkDraftKey("fork-2"), "{corrupt");
    expect(consumeShareForkDraft("fork-2")).toBeNull();
    expect(consumeShareForkDraft("other-session")).toBeNull();
  });
});
