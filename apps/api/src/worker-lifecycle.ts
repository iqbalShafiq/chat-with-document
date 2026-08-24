import type { ActiveRunRegistry } from "./modules/chat/run-worker.js";

type Closable = {
  close(): Promise<void>;
};

export type WorkerShutdownDependencies = {
  activeRuns: Pick<ActiveRunRegistry, "stopAccepting" | "cancelAll">;
  chatWorker: Closable;
  documentWorker: Closable;
  profileWorker?: Closable | null;
  closeQdrant: () => Promise<void>;
  closeContext7: () => Promise<void>;
  closeTracing: () => Promise<void>;
  disconnectPrisma: () => Promise<void>;
  closeRedis: () => Promise<void>;
  onFailure?: (name: string, error: unknown) => void;
};

export type WorkerShutdownCoordinator = {
  request(signal: string): Promise<void>;
};

/**
 * Coordinates process-owned cleanup without importing the worker bootstrap.
 * Acceptance is closed before active streams are cancelled, and shared
 * clients remain available until queue workers and provider runs have stopped.
 */
export function createWorkerShutdownCoordinator(
  dependencies: WorkerShutdownDependencies,
): WorkerShutdownCoordinator {
  let shutdownPromise: Promise<void> | null = null;

  const request = (signal: string): Promise<void> => {
    shutdownPromise ??= shutdown(signal);
    return shutdownPromise;
  };

  async function shutdown(signal: string): Promise<void> {
    const failures: unknown[] = [];
    const closeStage = async (name: string, close: () => Promise<void>): Promise<void> => {
      try {
        await close();
      } catch (error) {
        dependencies.onFailure?.(name, error);
        failures.push(error);
      }
    };

    dependencies.activeRuns.stopAccepting();
    await closeStage("active chat runs", () => dependencies.activeRuns.cancelAll("worker shutdown"));
    await closeStage("chat run", () => dependencies.chatWorker.close());
    await closeStage("document ingest", () => dependencies.documentWorker.close());
    if (dependencies.profileWorker) {
      await closeStage("profile", () => dependencies.profileWorker!.close());
    }
    await closeStage("Qdrant", dependencies.closeQdrant);
    await closeStage("Context7 MCP", dependencies.closeContext7);
    await closeStage("tracing", dependencies.closeTracing);
    await closeStage("Prisma", dependencies.disconnectPrisma);
    await closeStage("Redis", dependencies.closeRedis);

    if (failures.length > 0) {
      throw new AggregateError(failures, `Worker shutdown failed after ${signal}`);
    }
  }

  return { request };
}
