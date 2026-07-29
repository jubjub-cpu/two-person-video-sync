import type { AddressInfo } from "node:net";

import { PROTOCOL_VERSION, createRequestId, decodeServerMessage } from "@watch-sync/protocol";
import type {
  ClientMessage,
  ControlMode,
  RoomCreatedServerMessage,
  RoomJoinedServerMessage,
  ServerMessage,
  VideoState,
} from "@watch-sync/protocol";
import WebSocket from "ws";

import { loadConfig } from "../src/config.js";
import type { RateLimitConfig, ServerConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { BuiltServer } from "../src/server.js";
import type { Clock } from "../src/service.js";

export const TEST_ORIGIN = "http://localhost:4173";

export class FakeClock implements Clock {
  public constructor(private currentMs = 1_800_000_000_000) {}

  public now(): number {
    return this.currentMs;
  }

  public advance(milliseconds: number): void {
    this.currentMs += milliseconds;
  }
}

type MessageWaiter = {
  readonly predicate: (message: ServerMessage) => boolean;
  readonly resolve: (message: ServerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

export class TestClient {
  readonly #queue: ServerMessage[] = [];
  readonly #waiters: MessageWaiter[] = [];
  #closeCode: number | undefined;

  private constructor(public readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = decodeServerMessage(
        data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.from(data as Buffer),
      );
      const index = this.#waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.#waiters.splice(index, 1)[0];
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      } else {
        this.#queue.push(message);
      }
    });
    socket.on("error", () => {
      // Test assertions observe connection failures/close codes explicitly. Keeping this
      // listener prevents an expected abuse-test close from becoming an unhandled event.
    });
    socket.on("close", (code) => {
      this.#closeCode = code;
    });
  }

  public static connect(url: string, origin = TEST_ORIGIN): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Origin: origin } });
      const onError = (error: Error): void => {
        reject(error);
      };
      socket.once("error", onError);
      socket.once("open", () => {
        socket.off("error", onError);
        resolve(new TestClient(socket));
      });
    });
  }

  public send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  public sendRaw(payload: string | Buffer): void {
    this.socket.send(payload);
  }

  public next(
    predicate: (message: ServerMessage) => boolean = () => true,
    timeoutMs = 2_000,
  ): Promise<ServerMessage> {
    const index = this.#queue.findIndex(predicate);
    if (index >= 0) {
      const message = this.#queue.splice(index, 1)[0];
      if (message !== undefined) {
        return Promise.resolve(message);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) {
          this.#waiters.splice(waiterIndex, 1);
        }
        reject(new Error("Timed out waiting for a server message"));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }

  public async nextType<Type extends ServerMessage["type"]>(
    type: Type,
  ): Promise<Extract<ServerMessage, { type: Type }>> {
    return (await this.next((message) => message.type === type)) as Extract<
      ServerMessage,
      { type: Type }
    >;
  }

  public waitForClose(timeoutMs = 2_000): Promise<number> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve(this.#closeCode ?? 1006);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for WebSocket close"));
      }, timeoutMs);
      this.socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  public terminate(): void {
    this.socket.terminate();
  }
}

export interface TestHarness {
  readonly built: BuiltServer;
  readonly clock: FakeClock;
  readonly wsUrl: string;
  stop(): Promise<void>;
}

function defaultRateLimits(): RateLimitConfig {
  return {
    connectionAttempts: 1_000,
    connectionWindowMs: 60_000,
    roomCreates: 1_000,
    roomCreateWindowMs: 60_000,
    roomJoins: 1_000,
    roomJoinWindowMs: 60_000,
    messagesPerConnection: 1_000,
    messagesPerIp: 10_000,
    messageWindowMs: 10_000,
  };
}

export async function startHarness(
  overrides: Partial<Omit<ServerConfig, "rateLimits">> & {
    rateLimits?: Partial<RateLimitConfig>;
  } = {},
): Promise<TestHarness> {
  const base = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "8787",
    ALLOWED_ORIGINS: TEST_ORIGIN,
    ALLOW_EXTENSION_ORIGINS: "true",
    ALLOW_LOCALHOST_ORIGINS: "false",
    ALLOW_MISSING_ORIGIN: "false",
  });
  const clock = new FakeClock();
  const config: ServerConfig = {
    ...base,
    ...overrides,
    host: "127.0.0.1",
    port: 0,
    rateLimits: {
      ...defaultRateLimits(),
      ...overrides.rateLimits,
    },
  };
  const built = await buildServer({ config, clock, logger: false });
  await built.app.listen({ host: config.host, port: config.port });
  const address = built.app.server.address() as AddressInfo;
  return {
    built,
    clock,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    async stop() {
      await built.service.shutdown();
      await built.app.close();
    },
  };
}

export const VIDEO: VideoState = {
  identity: {
    identityVersion: 1,
    kind: "known",
    provider: "youtube",
    origin: "https://www.youtube.com",
    contentId: "test-video",
    titleFingerprint: "0123456789abcdef",
    durationSec: 600,
    isLive: false,
  },
  capabilities: {
    canPlayPause: true,
    canSeek: true,
    canSetPlaybackRate: true,
    seekableStartSec: 0,
    seekableEndSec: 600,
  },
  adState: "content",
};

export function envelope(clock: Clock) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: createRequestId(),
    clientTimeMs: clock.now(),
  } as const;
}

export async function createRoom(
  client: TestClient,
  clock: Clock,
  controlMode: ControlMode = "host-only",
  video?: VideoState,
): Promise<RoomCreatedServerMessage> {
  client.send({
    ...envelope(clock),
    type: "room.create",
    controlMode,
    ...(video === undefined ? {} : { video }),
  });
  return client.nextType("room.created");
}

export async function joinRoom(
  client: TestClient,
  clock: Clock,
  roomCode: RoomCreatedServerMessage["roomCode"],
  video?: VideoState,
): Promise<RoomJoinedServerMessage> {
  client.send({
    ...envelope(clock),
    type: "room.join",
    roomCode,
    ...(video === undefined ? {} : { video }),
  });
  return client.nextType("room.joined");
}

export function auth(
  session: Pick<
    RoomCreatedServerMessage | RoomJoinedServerMessage,
    "roomId" | "participantId" | "sessionId"
  >,
) {
  return {
    roomId: session.roomId,
    participantId: session.participantId,
    sessionId: session.sessionId,
  } as const;
}
