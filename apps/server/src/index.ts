import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

export { isOriginAllowed, loadConfig } from "./config.js";
export type { ServerConfig } from "./config.js";
export { buildServer } from "./server.js";
export type { BuildServerOptions, BuiltServer } from "./server.js";
export { RoomService } from "./service.js";
export type { Clock, ConnectionHandle, RoomServiceOptions, SocketPeer } from "./service.js";
export { InMemoryRoomStore } from "./store.js";
export type { ParticipantRecord, RoomRecord, RoomStore } from "./store.js";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Graceful shutdown exceeded ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, service } = await buildServer({ config });
  let stopping = false;

  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    app.log.info({ event: "shutdown", signal }, "Graceful shutdown started");
    try {
      await withTimeout(
        (async () => {
          await service.shutdown();
          await app.close();
        })(),
        config.shutdownTimeoutMs,
      );
    } catch (error) {
      app.log.error({ event: "shutdown-failed", error }, "Graceful shutdown failed");
      process.exitCode = 1;
      app.server.closeAllConnections();
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop(signal);
    });
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      event: "server-ready",
      host: config.host,
      port: config.port,
      environment: config.environment,
    },
    "Watch Sync server is ready",
  );
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    process.stderr.write(
      `${JSON.stringify({ level: "fatal", event: "startup-failed", message })}\n`,
    );
    process.exitCode = 1;
  });
}
