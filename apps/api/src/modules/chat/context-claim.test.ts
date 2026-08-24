import { describe, expect, it } from "vitest";
import { createPrismaSingleUseContextClaimStore } from "./build-run-input.js";

type ImageRow = {
  userId: string;
  sessionId: string;
  imageId: string;
  claimId: string | null;
  claimedAt: Date | null;
};
type SnippetRow = ImageRow & { id: string; text: string; sourceRole: string };

function fakeClaimPrisma(initial: {
  images: ImageRow[];
  snippet: SnippetRow | null;
}) {
  const state = {
    images: [...initial.images],
    snippet: initial.snippet ? { ...initial.snippet } : null,
  };
  let failNextTransaction = false;

  function matchesClaim(value: string | null, where: unknown): boolean {
    if (where === undefined) return true;
    if (where === null || typeof where === "string") return value === where;
    return (
      typeof where === "object" &&
      where !== null &&
      "not" in where &&
      (where as { not: unknown }).not === null &&
      value !== null
    );
  }

  function transactionClient(target: typeof state) {
    return {
      sessionImageContext: {
        findMany: async ({ where }: { where: { userId: string; sessionId: string; imageId: { in: string[] } } }) =>
          target.images
            .filter(
              (row) =>
                row.userId === where.userId &&
                row.sessionId === where.sessionId &&
                where.imageId.in.includes(row.imageId),
            )
            .map(({ imageId, claimId }) => ({ imageId, claimId })),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { claimId: string | null; claimedAt: Date | null } }) => {
          let count = 0;
          for (const row of target.images) {
            if (
              (where.userId === undefined || row.userId === where.userId) &&
              (where.sessionId === undefined || row.sessionId === where.sessionId) &&
              (where.imageId === undefined || (where.imageId as { in: string[] }).in.includes(row.imageId)) &&
              matchesClaim(row.claimId, where.claimId) &&
              (where.claimedAt === undefined || row.claimedAt! < (where.claimedAt as { lt: Date }).lt)
            ) {
              row.claimId = data.claimId;
              row.claimedAt = data.claimedAt;
              count += 1;
            }
          }
          return { count };
        },
        deleteMany: async ({ where }: { where: { claimId: string } }) => {
          const before = target.images.length;
          target.images = target.images.filter((row) => row.claimId !== where.claimId);
          return { count: before - target.images.length };
        },
      },
      sessionContextSnippet: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const row = target.snippet;
          if (
            !row ||
            (where.id !== undefined && row.id !== where.id) ||
            (where.sessionId !== undefined && row.sessionId !== where.sessionId) ||
            (where.userId !== undefined && row.userId !== where.userId) ||
            !matchesClaim(row.claimId, where.claimId)
          ) {
            return null;
          }
          return { ...row };
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { claimId: string | null; claimedAt: Date | null } }) => {
          const row = target.snippet;
          if (
            !row ||
            (where.id !== undefined && row.id !== where.id) ||
            (where.sessionId !== undefined && row.sessionId !== where.sessionId) ||
            (where.userId !== undefined && row.userId !== where.userId) ||
            !matchesClaim(row.claimId, where.claimId) ||
            (where.claimedAt !== undefined && row.claimedAt! >= (where.claimedAt as { lt: Date }).lt)
          ) {
            return { count: 0 };
          }
          row.claimId = data.claimId;
          row.claimedAt = data.claimedAt;
          return { count: 1 };
        },
        deleteMany: async ({ where }: { where: { claimId: string } }) => {
          if (target.snippet?.claimId !== where.claimId) return { count: 0 };
          target.snippet = null;
          return { count: 1 };
        },
      },
    };
  }

  const db = {
    $transaction: async <T>(callback: (tx: ReturnType<typeof transactionClient>) => Promise<T>) => {
      if (failNextTransaction) {
        failNextTransaction = false;
        throw new Error("transaction unavailable");
      }
      const target = {
        images: state.images.map((row) => ({ ...row })),
        snippet: state.snippet ? { ...state.snippet } : null,
      };
      const result = await callback(transactionClient(target));
      state.images = target.images;
      state.snippet = target.snippet;
      return result;
    },
    failNextTransaction() {
      failNextTransaction = true;
    },
    state,
  };

  return db;
}

const IMAGE = {
  userId: "u-1",
  sessionId: "s-1",
  imageId: "image-1",
  claimId: null,
  claimedAt: null,
};
const SNIPPET = {
  id: "snippet-1",
  userId: "u-1",
  sessionId: "s-1",
  imageId: "",
  claimId: null,
  claimedAt: null,
  text: "Pinned",
  sourceRole: "user",
};

describe("single-use context claims", () => {
  it("persists ownership, rejects concurrent claims, and recovers after restart", async () => {
    const db = fakeClaimPrisma({ images: [IMAGE], snippet: SNIPPET });
    const store = createPrismaSingleUseContextClaimStore(db as never);

    const claim = await store.claim({
      claimId: "stream-1",
      userId: "u-1",
      sessionId: "s-1",
      imageIds: ["image-1"],
      snippetId: "snippet-1",
    });
    expect(db.state.images[0]?.claimId).toBe("stream-1");
    expect(db.state.snippet?.claimId).toBe("stream-1");

    await expect(
      store.claim({
        claimId: "stream-2",
        userId: "u-1",
        sessionId: "s-1",
        imageIds: ["image-1"],
        snippetId: "snippet-1",
      }),
    ).rejects.toThrow("no longer available");

    // A new process can recover with only the durable claim id.
    const restartedStore = createPrismaSingleUseContextClaimStore(db as never);
    await restartedStore.releaseClaim("stream-1");
    expect(db.state.images[0]?.claimId).toBeNull();
    expect(db.state.snippet?.claimId).toBeNull();

    // New context is not touched by release of the old claim.
    db.state.images.push({ ...IMAGE, imageId: "image-new" });
    await claim.release();
    expect(db.state.images.map((row) => row.imageId)).toEqual([
      "image-1",
      "image-new",
    ]);
  });

  it("commits idempotently and retries release after a transient failure", async () => {
    const db = fakeClaimPrisma({ images: [IMAGE], snippet: SNIPPET });
    const store = createPrismaSingleUseContextClaimStore(db as never);
    const claim = await store.claim({
      claimId: "stream-commit",
      userId: "u-1",
      sessionId: "s-1",
      imageIds: ["image-1"],
      snippetId: "snippet-1",
    });

    // Model the stores' upsert behavior while enqueue is pending: a newer
    // write detaches the old claim before replacing the row. The old
    // claimId-scoped commit must not consume that newer context.
    db.state.images[0] = {
      ...db.state.images[0]!,
      claimId: null,
      claimedAt: null,
    };
    db.state.snippet = {
      ...db.state.snippet!,
      text: "New pinned text",
      claimId: null,
      claimedAt: null,
    };
    await claim.commit();
    await claim.commit();
    expect(db.state.images[0]).toMatchObject({ imageId: "image-1", claimId: null });
    expect(db.state.snippet).toMatchObject({
      id: "snippet-1",
      text: "New pinned text",
      claimId: null,
    });

    const db2 = fakeClaimPrisma({ images: [IMAGE], snippet: SNIPPET });
    const store2 = createPrismaSingleUseContextClaimStore(db2 as never);
    const claim2 = await store2.claim({
      claimId: "stream-release",
      userId: "u-1",
      sessionId: "s-1",
      imageIds: ["image-1"],
      snippetId: "snippet-1",
    });
    db2.failNextTransaction();
    await expect(claim2.release()).rejects.toThrow("transaction unavailable");
    await claim2.release();
    await claim2.release();
    expect(db2.state.images[0]?.claimId).toBeNull();
    expect(db2.state.snippet?.claimId).toBeNull();

    const db3 = fakeClaimPrisma({ images: [IMAGE], snippet: SNIPPET });
    const store3 = createPrismaSingleUseContextClaimStore(db3 as never);
    await store3.claim({
      claimId: "stream-expired",
      userId: "u-1",
      sessionId: "s-1",
      imageIds: ["image-1"],
      snippetId: "snippet-1",
    });
    const reaped = await store3.reapExpiredClaims(new Date(Date.now() + 60_000));
    expect(reaped).toBe(2);
    expect(db3.state.images[0]?.claimId).toBeNull();
  });
});
