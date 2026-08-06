import websocket from "@fastify/websocket";
import { PROTOCOL_VERSION } from "@vyzync/protocol";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Server as HttpServer } from "node:http";
import type { RawData } from "ws";

import { isOriginAllowed, loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { RoomService, systemClock } from "./service.js";
import type { Clock } from "./service.js";
import type { RoomStore } from "./store.js";

export interface BuildServerOptions {
  readonly config?: ServerConfig;
  readonly store?: RoomStore;
  readonly clock?: Clock;
  readonly logger?: boolean;
}

export interface BuiltServer {
  readonly app: FastifyInstance;
  readonly service: RoomService;
  readonly config: ServerConfig;
}

function safeRequestLog(request: FastifyRequest): Record<string, unknown> {
  const rawUrl = request.raw.url ?? "/";
  return {
    method: request.method,
    path: rawUrl.split("?", 1)[0],
    remoteAddress: request.ip,
    requestId: request.id,
  };
}

function createFastify(config: ServerConfig, loggerEnabled: boolean): FastifyInstance {
  const common = {
    trustProxy: config.trustProxy,
    bodyLimit: config.maxPayloadBytes,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    maxRequestsPerSocket: 10_000,
  } as const;
  if (!loggerEnabled) {
    return Fastify<HttpServer>({ ...common, logger: false });
  }
  return Fastify<HttpServer>({
    ...common,
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.sec-websocket-protocol",
          "request.headers.authorization",
          "request.headers.cookie",
          "roomCode",
          "reconnectToken",
          "sessionId",
          "*.roomCode",
          "*.reconnectToken",
          "*.sessionId",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        req: safeRequestLog,
      },
    },
  });
}

function normalizePayload(data: RawData, maximumBytes: number): Uint8Array | undefined {
  if (typeof data === "string") {
    const encoded = new TextEncoder().encode(data);
    return encoded.byteLength <= maximumBytes ? encoded : undefined;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength <= maximumBytes ? new Uint8Array(data) : undefined;
  }
  if (Array.isArray(data)) {
    const total = data.reduce((sum, part) => sum + part.byteLength, 0);
    if (total > maximumBytes) {
      return undefined;
    }
    return Buffer.concat(data, total);
  }
  return data.byteLength <= maximumBytes ? data : undefined;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<BuiltServer> {
  const config = options.config ?? loadConfig();
  const app = createFastify(config, options.logger !== false);
  const service = new RoomService({
    config,
    logger: app.log,
    ...(options.store === undefined ? {} : { store: options.store }),
    clock: options.clock ?? systemClock,
  });

  await app.register(websocket, {
    options: {
      maxPayload: config.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
    },
  });

  app.get("/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      rooms: await service.roomCount(),
      connections: service.connectionCount(),
      uptimeSec: Math.floor(process.uptime()),
    };
  });

  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if ((request.raw.url ?? "/ws") !== "/ws") {
          await reply.code(400).send({ error: "WebSocket query parameters are not accepted" });
          return;
        }
        if (config.requireSecureWebSocket && request.protocol !== "https") {
          await reply
            .code(426)
            .header("upgrade", "websocket")
            .send({ error: "Secure WebSocket transport is required" });
          return;
        }
        if (!isOriginAllowed(request.headers.origin, config)) {
          await reply.code(403).send({ error: "Origin is not allowed" });
          return;
        }
        if (!service.canAcceptConnection(request.ip)) {
          await reply.code(503).send({ error: "WebSocket capacity reached" });
          return;
        }
        const decision = service.consumeConnectionAttempt(request.ip);
        if (!decision.allowed) {
          return reply
            .code(429)
            .header("retry-after", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))))
            .send({ error: "Connection rate limit exceeded" });
        }
      },
    },
    (socket, request) => {
      const handle = service.openConnection(socket, request.ip);
      if (handle === undefined) {
        return;
      }
      socket.on("message", (data, isBinary) => {
        const payload = normalizePayload(data, config.maxPayloadBytes);
        if (payload === undefined) {
          socket.close(1009, "Payload too large");
          return;
        }
        service.handleMessage(handle, payload, isBinary);
      });
      socket.once("close", () => {
        service.closeConnection(handle);
      });
      socket.on("error", () => {
        app.log.warn(
          { event: "websocket-error", remoteAddress: request.ip },
          "WebSocket transport error",
        );
        socket.terminate();
      });
    },
  );

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({ error: "Not found" });
  });

  app.addHook("onClose", async () => {
    await service.shutdown();
  });

  service.start();
  return { app, service, config };
}
