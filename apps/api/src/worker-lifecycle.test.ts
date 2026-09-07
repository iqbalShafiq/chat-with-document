import { describe, expect, it, vi } from "vitest";
import { createWorkerShutdownCoordinator } from "./worker-lifecycle.js";

function createDependencies(order: string[], failures: Set<string> = new Set()) {
  const close = (name: string) => vi.fn(async () => {
    order.push(name);
    if (failures.has(name)) throw new Error(`${name} failed`);
  });
  const activeRuns = {
    stopAccepting: vi.fn(() => { order.push("acceptance"); }),
    cancelAll: vi.fn(async () => { order.push("active"); }),
  };
  return {
    activeRuns,
    chatWorker: { close: close("chat") },
    documentWorker: { close: close("documents") },
    profileWorker: { close: close("profile") },
    closeQdrant: close("qdrant"),
    closeContext7: close("context7"),
    closeTracing: close("tracing"),
    disconnectPrisma: close("prisma"),
    closeRedis: close("redis"),
  };
}

describe("worker shutdown coordinator", () => {
  it("closes acceptance, active streams, queues, and clients in order", async () => {
    const order: string[] = [];
    const dependencies = createDependencies(order);
    const coordinator = createWorkerShutdownCoordinator(dependencies);

    await coordinator.request("SIGTERM");

    expect(order).toEqual([
      "acceptance",
      "active",
      "chat",
      "documents",
      "profile",
      "qdrant",
      "context7",
      "tracing",
      "prisma",
      "redis",
    ]);
    expect(dependencies.activeRuns.stopAccepting).toHaveBeenCalledTimes(1);
    expect(dependencies.activeRuns.cancelAll).toHaveBeenCalledWith("worker shutdown");
  });

  it("returns one promise and performs each close once for repeated signals", async () => {
    const order: string[] = [];
    const dependencies = createDependencies(order);
    const coordinator = createWorkerShutdownCoordinator(dependencies);

    const first = coordinator.request("SIGTERM");
    const second = coordinator.request("SIGINT");
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(order).toHaveLength(10);
    expect(dependencies.chatWorker.close).toHaveBeenCalledTimes(1);
  });

  it("continues later cleanup and reports aggregate failures", async () => {
    const order: string[] = [];
    const failures: string[] = [];
    const dependencies = createDependencies(order, new Set(["chat", "redis"]));
    const coordinator = createWorkerShutdownCoordinator({
      ...dependencies,
      onFailure: (name) => failures.push(name),
    });

    await expect(coordinator.request("SIGTERM")).rejects.toMatchObject({ name: "AggregateError" });
    expect(order).toEqual([
      "acceptance",
      "active",
      "chat",
      "documents",
      "profile",
      "qdrant",
      "context7",
      "tracing",
      "prisma",
      "redis",
    ]);
    expect(failures).toEqual(["chat run", "Redis"]);
  });
});
