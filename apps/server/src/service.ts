import { createHash, timingSafeEqual } from "node:crypto";

import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  ServerMessageSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  createParticipantId,
  createReconnectToken,
  createRoomCode,
  createRoomId,
  createServerMessageId,
  createSessionId,
  decodeClientMessage,
  inspectProtocolVersion,
} from "@vyzync/protocol";
import type {
  ClientMessage,
  ErrorServerMessage,
  ParticipantId,
  ParticipantSummary,
  PlaybackCommand,
  PlaybackState,
  ProtocolErrorCode,
  ReconnectToken,
  RequestId,
  RoomId,
  ServerMessage,
  SessionId,
} from "@vyzync/protocol";

import type { ServerConfig } from "./config.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { InMemoryRoomStore } from "./store.js";
import type { ParticipantRecord, RoomRecord, RoomStore } from "./store.js";

const SOCKET_OPEN = 1;
const MAX_RECENT_COMMAND_IDS = 512;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface SocketPeer {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export interface ServiceLogger {
  info(data: object, message?: string): void;
  warn(data: object, message?: string): void;
  error(data: object, message?: string): void;
}

export interface ConnectionHandle {
  readonly id: string;
}

interface ConnectionRecord extends ConnectionHandle {
  readonly socket: SocketPeer;
  readonly ip: string;
  identity:
    | {
        roomId: RoomId;
        participantId: ParticipantId;
        sessionId: SessionId;
      }
    | undefined;
  invalidMessageCount: number;
  closed: boolean;
}

interface AuthenticatedContext {
  readonly room: RoomRecord;
  readonly participant: ParticipantRecord;
}

type AuthenticatedClientMessage = Exclude<
  ClientMessage,
  | Extract<ClientMessage, { type: "room.create" }>
  | Extract<ClientMessage, { type: "room.join" }>
  | Extract<ClientMessage, { type: "room.reconnect" }>
>;

export interface RoomServiceOptions {
  readonly config: ServerConfig;
  readonly logger: ServiceLogger;
  readonly store?: RoomStore;
  readonly clock?: Clock;
}

function digestSecret(secret: string): Uint8Array {
  return createHash("sha256").update(secret, "utf8").digest();
}

function secretsEqual(secret: string, expectedDigest: Uint8Array): boolean {
  const actual = digestSecret(secret);
  return actual.byteLength === expectedDigest.byteLength && timingSafeEqual(actual, expectedDigest);
}

function participantSummary(participant: ParticipantRecord): ParticipantSummary {
  return {
    participantId: participant.participantId,
    role: participant.role,
    connected: participant.connectionId !== undefined,
    ready: participant.ready,
    playbackStatus: participant.playbackStatus,
  };
}

function participantSummaries(room: RoomRecord): ParticipantSummary[] {
  return [...room.participants.values()]
    .sort((left, right) => (left.role === right.role ? 0 : left.role === "host" ? -1 : 1))
    .map(participantSummary);
}

function updatePlaybackState(
  previous: PlaybackState | undefined,
  action: PlaybackCommand,
  sampledAtTimeMs: number,
): PlaybackState {
  switch (action.type) {
    case "play":
      return {
        positionSec: action.positionSec,
        paused: false,
        playbackRate: action.playbackRate,
        status: "playing",
        sampledAtTimeMs,
      };
    case "pause":
      return {
        positionSec: action.positionSec,
        paused: true,
        playbackRate: previous?.playbackRate ?? 1,
        status: "paused",
        sampledAtTimeMs,
      };
    case "seek":
      return {
        positionSec: action.positionSec,
        paused: action.paused,
        playbackRate: action.playbackRate,
        status: action.paused ? "paused" : "playing",
        sampledAtTimeMs,
      };
    case "rate":
      return {
        positionSec: action.positionSec,
        paused: action.paused,
        playbackRate: action.playbackRate,
        status: action.paused ? "paused" : "playing",
        sampledAtTimeMs,
      };
  }
}

function safeRetryAfter(value: number): number {
  return Math.max(1, Math.min(24 * 60 * 60_000, Math.ceil(value)));
}

export class RoomService {
  public readonly store: RoomStore;

  readonly #config: ServerConfig;
  readonly #logger: ServiceLogger;
  readonly #clock: Clock;
  readonly #rateLimiter = new FixedWindowRateLimiter();
  readonly #connections = new Map<string, ConnectionRecord>();
  readonly #connectionsByIp = new Map<string, number>();
  #serialTail: Promise<void> = Promise.resolve();
  #cleanupTimer: NodeJS.Timeout | undefined;
  #closing = false;

  public constructor(options: RoomServiceOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemClock;
    this.store = options.store ?? new InMemoryRoomStore();
  }

  public start(): void {
    if (this.#cleanupTimer !== undefined) {
      return;
    }
    this.#cleanupTimer = setInterval(() => {
      void this.cleanup().catch((error: unknown) => {
        this.#logger.error({ error }, "Room cleanup failed");
      });
    }, this.#config.cleanupIntervalMs);
    this.#cleanupTimer.unref();
  }

  public connectionCount(): number {
    return this.#connections.size;
  }

  public roomCount(): Promise<number> {
    return this.store.count();
  }

  public canAcceptConnection(ip: string): boolean {
    return (
      !this.#closing &&
      this.#connections.size < this.#config.maxConnections &&
      (this.#connectionsByIp.get(ip) ?? 0) < this.#config.maxConnectionsPerIp
    );
  }

  public consumeConnectionAttempt(ip: string): { allowed: boolean; retryAfterMs: number } {
    const limit = this.#config.rateLimits;
    return this.#rateLimiter.consume(
      "connect",
      ip,
      limit.connectionAttempts,
      limit.connectionWindowMs,
      this.#clock.now(),
    );
  }

  public openConnection(socket: SocketPeer, ip: string): ConnectionHandle | undefined {
    if (!this.canAcceptConnection(ip)) {
      socket.close(1013, "Connection capacity reached");
      return undefined;
    }
    const id = createServerMessageId();
    const connection: ConnectionRecord = {
      id,
      socket,
      ip,
      identity: undefined,
      invalidMessageCount: 0,
      closed: false,
    };
    this.#connections.set(id, connection);
    this.#connectionsByIp.set(ip, (this.#connectionsByIp.get(ip) ?? 0) + 1);
    return { id };
  }

  public handleMessage(
    handle: ConnectionHandle,
    payload: string | Uint8Array,
    isBinary: boolean,
  ): void {
    const connection = this.#connections.get(handle.id);
    if (connection === undefined || connection.closed || this.#closing) {
      return;
    }
    const now = this.#clock.now();
    const limits = this.#config.rateLimits;
    const connectionDecision = this.#rateLimiter.consume(
      "message-connection",
      connection.id,
      limits.messagesPerConnection,
      limits.messageWindowMs,
      now,
    );
    const ipDecision = this.#rateLimiter.consume(
      "message-ip",
      connection.ip,
      limits.messagesPerIp,
      limits.messageWindowMs,
      now,
    );
    if (!connectionDecision.allowed || !ipDecision.allowed) {
      this.#sendError(
        connection,
        "RATE_LIMITED",
        "Message rate limit exceeded",
        true,
        undefined,
        safeRetryAfter(Math.max(connectionDecision.retryAfterMs, ipDecision.retryAfterMs)),
      );
      return;
    }
    if (isBinary) {
      this.#invalidMessage(connection, "Binary WebSocket messages are not supported");
      connection.socket.close(1003, "Text messages required");
      return;
    }

    let message: ClientMessage;
    try {
      message = decodeClientMessage(payload, this.#config.maxPayloadBytes);
    } catch (error) {
      if (error instanceof ProtocolDecodeError) {
        if (error.code === "PAYLOAD_TOO_LARGE") {
          this.#sendError(connection, "PAYLOAD_TOO_LARGE", "Protocol payload is too large", false);
          connection.socket.close(1009, "Payload too large");
          return;
        }
        if (this.#sendIncompatibleIfApplicable(connection, payload)) {
          connection.socket.close(1002, "Unsupported protocol version");
          return;
        }
        this.#invalidMessage(connection, "Protocol payload is malformed");
        return;
      }
      this.#internalFailure(connection, error);
      return;
    }

    void this.#enqueue(async () => {
      await this.#processMessage(connection, message, now);
    }, connection);
  }

  public closeConnection(handle: ConnectionHandle): void {
    const connection = this.#connections.get(handle.id);
    if (connection === undefined || connection.closed) {
      return;
    }
    connection.closed = true;
    this.#connections.delete(connection.id);
    const remaining = (this.#connectionsByIp.get(connection.ip) ?? 1) - 1;
    if (remaining <= 0) {
      this.#connectionsByIp.delete(connection.ip);
    } else {
      this.#connectionsByIp.set(connection.ip, remaining);
    }
    void this.#enqueue(async () => {
      await this.#disconnectParticipant(connection);
    });
  }

  public cleanup(nowMs = this.#clock.now()): Promise<void> {
    return this.#enqueue(async () => {
      this.#rateLimiter.prune(nowMs);
      const rooms = await this.store.list();
      for (const room of rooms) {
        if (nowMs >= room.expiresAtMs) {
          await this.#endRoom(room, "expired");
          continue;
        }
        if (nowMs - room.lastActivityAtMs >= this.#config.roomIdleTtlMs) {
          await this.#endRoom(room, "idle-timeout");
          continue;
        }

        let changed = false;
        for (const participant of [...room.participants.values()]) {
          if (
            participant.connectionId === undefined &&
            participant.disconnectedAtMs !== undefined &&
            nowMs - participant.disconnectedAtMs >= this.#config.reconnectGraceMs
          ) {
            if (participant.role === "host") {
              await this.#endRoom(room, "idle-timeout");
              changed = false;
              break;
            }
            room.participants.delete(participant.participantId);
            room.serverSequence += 1;
            this.#broadcast(room, {
              ...this.#orderedEnvelope(room, nowMs),
              type: "participant.left",
              participantId: participant.participantId,
              reason: "timeout",
            });
            changed = true;
          }
        }
        if (changed) {
          room.lastActivityAtMs = nowMs;
          await this.store.save(room);
        }
      }
    });
  }

  public async shutdown(): Promise<void> {
    if (this.#closing) {
      await this.#serialTail;
      return;
    }
    this.#closing = true;
    if (this.#cleanupTimer !== undefined) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
    await this.#enqueue(async () => {
      const rooms = await this.store.list();
      for (const room of rooms) {
        await this.#endRoom(room, "server-shutdown");
      }
      for (const connection of this.#connections.values()) {
        connection.identity = undefined;
        if (connection.socket.readyState === SOCKET_OPEN) {
          connection.socket.close(1012, "Server restarting");
        }
      }
      if (this.#connections.size > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          timer.unref();
        });
      }
      for (const connection of this.#connections.values()) {
        connection.socket.terminate?.();
      }
    });
    this.#rateLimiter.clear();
  }

  #enqueue(task: () => Promise<void>, connection?: ConnectionRecord): Promise<void> {
    const result = this.#serialTail.then(task, task);
    this.#serialTail = result.catch((error: unknown) => {
      if (connection !== undefined) {
        this.#internalFailure(connection, error);
      } else {
        this.#logger.error({ error }, "Serialized room operation failed");
      }
    });
    return result;
  }

  async #processMessage(
    connection: ConnectionRecord,
    message: ClientMessage,
    receivedAtMs: number,
  ): Promise<void> {
    if (connection.closed || this.#closing) {
      return;
    }
    switch (message.type) {
      case "room.create":
        await this.#createRoom(connection, message);
        return;
      case "room.join":
        await this.#joinRoom(connection, message);
        return;
      case "room.reconnect":
        await this.#reconnect(connection, message);
        return;
      case "participant.ready":
      case "participant.leave":
      case "room.end":
      case "room.transfer-host":
      case "control.set":
      case "video.update":
      case "playback.status":
      case "command.submit":
      case "state.snapshot":
      case "ping": {
        const authenticated = await this.#authenticate(connection, message);
        if (authenticated === undefined) {
          return;
        }
        await this.#processAuthenticated(
          connection,
          authenticated.room,
          authenticated.participant,
          message,
          receivedAtMs,
        );
      }
    }
  }

  async #createRoom(
    connection: ConnectionRecord,
    message: Extract<ClientMessage, { type: "room.create" }>,
  ): Promise<void> {
    if (connection.identity !== undefined) {
      this.#sendError(
        connection,
        "NOT_AUTHORIZED",
        "This connection already belongs to a room",
        false,
        message.requestId,
      );
      return;
    }
    const limit = this.#config.rateLimits;
    const decision = this.#rateLimiter.consume(
      "room-create",
      connection.ip,
      limit.roomCreates,
      limit.roomCreateWindowMs,
      this.#clock.now(),
    );
    if (!decision.allowed) {
      this.#sendError(
        connection,
        "RATE_LIMITED",
        "Room creation rate limit exceeded",
        true,
        message.requestId,
        safeRetryAfter(decision.retryAfterMs),
      );
      return;
    }

    const now = this.#clock.now();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const roomId = createRoomId();
      const roomCode = createRoomCode();
      const participantId = createParticipantId();
      const sessionId = createSessionId();
      const reconnectToken = createReconnectToken();
      const participant: ParticipantRecord = {
        participantId,
        role: "host",
        sessionId,
        reconnectTokenDigest: digestSecret(reconnectToken),
        reconnectTokenExpiresAtMs: Math.min(
          now + this.#config.reconnectTokenTtlMs,
          now + this.#config.roomTtlMs,
        ),
        connectionId: connection.id,
        disconnectedAtMs: undefined,
        ready: false,
        autoplayUnlocked: false,
        playbackStatus: "waiting",
        video: message.video,
        lastClientSequence: -1,
        recentCommandIds: new Set(),
      };
      const room: RoomRecord = {
        roomId,
        roomCode,
        createdAtMs: now,
        expiresAtMs: now + this.#config.roomTtlMs,
        lastActivityAtMs: now,
        serverSequence: 0,
        controlMode: message.controlMode,
        participantCapacity: this.#config.maxParticipantsPerRoom,
        hostParticipantId: participantId,
        authoritativeParticipantId: participantId,
        state: undefined,
        participants: new Map([[participantId, participant]]),
      };
      if (!(await this.store.insert(room))) {
        continue;
      }
      connection.identity = { roomId, participantId, sessionId };
      this.#send(connection, {
        ...this.#serverEnvelope(now),
        type: "room.created",
        requestId: message.requestId,
        serverSequence: room.serverSequence,
        ...this.#sessionFields(room, participant, reconnectToken),
        role: "host",
      });
      return;
    }
    this.#sendError(
      connection,
      "INTERNAL_ERROR",
      "Unable to allocate a room",
      true,
      message.requestId,
    );
  }

  async #joinRoom(
    connection: ConnectionRecord,
    message: Extract<ClientMessage, { type: "room.join" }>,
  ): Promise<void> {
    if (connection.identity !== undefined) {
      this.#sendError(
        connection,
        "NOT_AUTHORIZED",
        "This connection already belongs to a room",
        false,
        message.requestId,
      );
      return;
    }
    const limits = this.#config.rateLimits;
    const decision = this.#rateLimiter.consume(
      "room-join",
      connection.ip,
      limits.roomJoins,
      limits.roomJoinWindowMs,
      this.#clock.now(),
    );
    if (!decision.allowed) {
      this.#sendError(
        connection,
        "RATE_LIMITED",
        "Room join rate limit exceeded",
        true,
        message.requestId,
        safeRetryAfter(decision.retryAfterMs),
      );
      return;
    }

    const room = await this.store.getByCode(message.roomCode);
    if (room === undefined) {
      this.#sendError(
        connection,
        "INVALID_ROOM_CODE",
        "Room code is invalid or unavailable",
        false,
        message.requestId,
      );
      return;
    }
    const now = this.#clock.now();
    if (now >= room.expiresAtMs) {
      await this.#endRoom(room, "expired");
      this.#sendError(connection, "ROOM_EXPIRED", "Room has expired", false, message.requestId);
      return;
    }
    if (room.participants.size >= room.participantCapacity) {
      this.#sendError(
        connection,
        "ROOM_FULL",
        "Room has reached its participant limit",
        false,
        message.requestId,
      );
      return;
    }

    const participantId = createParticipantId();
    const sessionId = createSessionId();
    const reconnectToken = createReconnectToken();
    const participant: ParticipantRecord = {
      participantId,
      role: "guest",
      sessionId,
      reconnectTokenDigest: digestSecret(reconnectToken),
      reconnectTokenExpiresAtMs: Math.min(room.expiresAtMs, now + this.#config.reconnectTokenTtlMs),
      connectionId: connection.id,
      disconnectedAtMs: undefined,
      ready: false,
      autoplayUnlocked: false,
      playbackStatus: "waiting",
      video: message.video,
      lastClientSequence: -1,
      recentCommandIds: new Set(),
    };
    room.participants.set(participantId, participant);
    room.lastActivityAtMs = now;
    room.serverSequence += 1;
    connection.identity = { roomId: room.roomId, participantId, sessionId };
    await this.store.save(room);

    this.#send(connection, {
      ...this.#serverEnvelope(now),
      type: "room.joined",
      requestId: message.requestId,
      serverSequence: room.serverSequence,
      ...this.#sessionFields(room, participant, reconnectToken),
    });
    this.#broadcast(
      room,
      {
        ...this.#orderedEnvelope(room, now),
        type: "participant.joined",
        participant: participantSummary(participant),
      },
      participantId,
    );

    for (const current of room.participants.values()) {
      if (current.video !== undefined) {
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "video.updated",
          participantId: current.participantId,
          video: current.video,
        });
      }
    }
    if (room.state !== undefined) {
      room.serverSequence += 1;
      this.#broadcast(room, {
        ...this.#orderedEnvelope(room, now),
        type: "state.snapshot",
        authoritativeParticipantId: room.authoritativeParticipantId,
        state: room.state,
        participants: participantSummaries(room),
      });
    }
    await this.store.save(room);
  }

  async #reconnect(
    connection: ConnectionRecord,
    message: Extract<ClientMessage, { type: "room.reconnect" }>,
  ): Promise<void> {
    if (connection.identity !== undefined) {
      this.#sendError(
        connection,
        "NOT_AUTHORIZED",
        "This connection already belongs to a room",
        false,
        message.requestId,
      );
      return;
    }
    const room = await this.store.getById(message.roomId);
    if (room === undefined) {
      this.#sendError(
        connection,
        "ROOM_NOT_FOUND",
        "Room is unavailable",
        false,
        message.requestId,
      );
      return;
    }
    const now = this.#clock.now();
    if (now >= room.expiresAtMs) {
      await this.#endRoom(room, "expired");
      this.#sendError(connection, "ROOM_EXPIRED", "Room has expired", false, message.requestId);
      return;
    }
    const participant = room.participants.get(message.participantId);
    if (
      participant === undefined ||
      now >= participant.reconnectTokenExpiresAtMs ||
      !secretsEqual(message.reconnectToken, participant.reconnectTokenDigest)
    ) {
      this.#sendError(
        connection,
        "RECONNECT_REJECTED",
        "Reconnect credential is invalid or expired",
        false,
        message.requestId,
      );
      return;
    }
    if (message.lastServerSequence > room.serverSequence) {
      this.#sendError(
        connection,
        "RECONNECT_REJECTED",
        "Reconnect sequence is ahead of the room",
        false,
        message.requestId,
      );
      return;
    }

    if (participant.connectionId !== undefined) {
      const previous = this.#connections.get(participant.connectionId);
      if (previous !== undefined && previous !== connection) {
        previous.identity = undefined;
        if (previous.socket.readyState === SOCKET_OPEN) {
          previous.socket.close(4001, "Session replaced");
        }
      }
    }

    const sessionId = createSessionId();
    const reconnectToken = createReconnectToken();
    participant.sessionId = sessionId;
    participant.reconnectTokenDigest = digestSecret(reconnectToken);
    participant.reconnectTokenExpiresAtMs = Math.min(
      room.expiresAtMs,
      now + this.#config.reconnectTokenTtlMs,
    );
    participant.connectionId = connection.id;
    participant.disconnectedAtMs = undefined;
    participant.ready = false;
    participant.autoplayUnlocked = false;
    participant.playbackStatus = "waiting";
    room.lastActivityAtMs = now;
    room.serverSequence += 1;
    connection.identity = {
      roomId: room.roomId,
      participantId: participant.participantId,
      sessionId,
    };
    await this.store.save(room);

    this.#send(connection, {
      ...this.#serverEnvelope(now),
      type: "room.restored",
      requestId: message.requestId,
      serverSequence: room.serverSequence,
      ...this.#sessionFields(room, participant, reconnectToken),
    });
    this.#broadcast(
      room,
      {
        ...this.#orderedEnvelope(room, now),
        type: "participant.joined",
        participant: participantSummary(participant),
      },
      participant.participantId,
    );
    for (const current of room.participants.values()) {
      if (current.video !== undefined) {
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "video.updated",
          participantId: current.participantId,
          video: current.video,
        });
      }
    }
    if (room.state !== undefined) {
      room.serverSequence += 1;
      this.#broadcast(room, {
        ...this.#orderedEnvelope(room, now),
        type: "state.snapshot",
        authoritativeParticipantId: room.authoritativeParticipantId,
        state: room.state,
        participants: participantSummaries(room),
      });
    }
    await this.store.save(room);
  }

  async #authenticate(
    connection: ConnectionRecord,
    message: AuthenticatedClientMessage,
  ): Promise<AuthenticatedContext | undefined> {
    const identity = connection.identity;
    if (
      identity === undefined ||
      identity.roomId !== message.roomId ||
      identity.participantId !== message.participantId ||
      identity.sessionId !== message.sessionId
    ) {
      this.#sendError(
        connection,
        "NOT_AUTHORIZED",
        "Session is not authorized for this room",
        false,
        message.requestId,
      );
      return undefined;
    }
    const room = await this.store.getById(identity.roomId);
    const participant = room?.participants.get(identity.participantId);
    if (
      room === undefined ||
      participant === undefined ||
      participant.connectionId !== connection.id ||
      participant.sessionId !== identity.sessionId
    ) {
      connection.identity = undefined;
      this.#sendError(
        connection,
        "SESSION_EXPIRED",
        "Session has expired",
        false,
        message.requestId,
      );
      return undefined;
    }
    const now = this.#clock.now();
    if (now >= room.expiresAtMs) {
      await this.#endRoom(room, "expired");
      this.#sendError(connection, "ROOM_EXPIRED", "Room has expired", false, message.requestId);
      return undefined;
    }
    room.lastActivityAtMs = now;
    return { room, participant };
  }

  async #processAuthenticated(
    connection: ConnectionRecord,
    room: RoomRecord,
    participant: ParticipantRecord,
    message: AuthenticatedClientMessage,
    receivedAtMs: number,
  ): Promise<void> {
    const now = this.#clock.now();
    switch (message.type) {
      case "participant.ready": {
        participant.ready = message.ready;
        participant.autoplayUnlocked = message.autoplayUnlocked;
        if (message.video !== undefined) {
          participant.video = message.video;
        }
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "participant.ready",
          participantId: participant.participantId,
          ready: participant.ready,
          autoplayUnlocked: participant.autoplayUnlocked,
        });
        if (message.video !== undefined) {
          room.serverSequence += 1;
          this.#broadcast(room, {
            ...this.#orderedEnvelope(room, now),
            type: "video.updated",
            participantId: participant.participantId,
            video: message.video,
          });
        }
        await this.store.save(room);
        return;
      }
      case "participant.leave":
        await this.#leaveRoom(connection, room, participant, message.reason);
        return;
      case "room.end":
        if (participant.role !== "host") {
          this.#sendError(
            connection,
            "NOT_AUTHORIZED",
            "Only the host can end the room",
            false,
            message.requestId,
          );
          return;
        }
        await this.#endRoom(room, "host-ended", participant.participantId);
        return;
      case "room.transfer-host": {
        if (participant.role !== "host") {
          this.#sendError(
            connection,
            "NOT_AUTHORIZED",
            "Only the host can pass host control",
            false,
            message.requestId,
          );
          return;
        }
        const nextHost = room.participants.get(message.targetParticipantId);
        const nextHostConnection =
          nextHost?.connectionId === undefined
            ? undefined
            : this.#connections.get(nextHost.connectionId);
        if (
          nextHost === undefined ||
          nextHost.participantId === participant.participantId ||
          nextHost.role !== "guest" ||
          nextHostConnection === undefined ||
          nextHostConnection.closed ||
          nextHostConnection.socket.readyState !== SOCKET_OPEN
        ) {
          this.#sendError(
            connection,
            "NOT_AUTHORIZED",
            "The selected participant must be connected before host control can be passed",
            false,
            message.requestId,
          );
          return;
        }

        const previousHostParticipantId = participant.participantId;
        participant.role = "guest";
        nextHost.role = "host";
        room.hostParticipantId = nextHost.participantId;
        room.authoritativeParticipantId = nextHost.participantId;
        room.state = undefined;
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "room.host-transferred",
          previousHostParticipantId,
          hostParticipantId: nextHost.participantId,
          participants: participantSummaries(room),
        });
        await this.store.save(room);
        return;
      }
      case "control.set":
        if (participant.role !== "host") {
          this.#sendError(
            connection,
            "NOT_AUTHORIZED",
            "Only the host can change the control mode",
            false,
            message.requestId,
          );
          return;
        }
        room.controlMode = message.controlMode;
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "control.updated",
          controlMode: room.controlMode,
          updatedByParticipantId: participant.participantId,
        });
        await this.store.save(room);
        return;
      case "video.update":
        participant.video = message.video;
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "video.updated",
          participantId: participant.participantId,
          video: message.video,
        });
        await this.store.save(room);
        return;
      case "playback.status":
        participant.playbackStatus = message.status;
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "playback.status",
          participantId: participant.participantId,
          status: message.status,
          positionSec: message.positionSec,
          playbackRate: message.playbackRate,
          ...(message.stalledForMs === undefined ? {} : { stalledForMs: message.stalledForMs }),
        });
        await this.store.save(room);
        return;
      case "command.submit":
        await this.#acceptCommand(connection, room, participant, message, now);
        return;
      case "state.snapshot":
        if (participant.role !== "host") {
          this.#sendError(
            connection,
            "NOT_AUTHORIZED",
            "Only the host can publish authoritative state",
            false,
            message.requestId,
          );
          return;
        }
        if (
          !this.#acceptClientSequence(
            connection,
            participant,
            message.clientSequence,
            message.requestId,
          )
        ) {
          return;
        }
        room.state = { ...message.state, sampledAtTimeMs: now };
        room.authoritativeParticipantId = participant.participantId;
        if (message.video !== undefined) {
          participant.video = message.video;
        }
        room.serverSequence += 1;
        this.#broadcast(room, {
          ...this.#orderedEnvelope(room, now),
          type: "state.snapshot",
          authoritativeParticipantId: participant.participantId,
          state: room.state,
          participants: participantSummaries(room),
        });
        if (message.video !== undefined) {
          room.serverSequence += 1;
          this.#broadcast(room, {
            ...this.#orderedEnvelope(room, now),
            type: "video.updated",
            participantId: participant.participantId,
            video: message.video,
          });
        }
        await this.store.save(room);
        return;
      case "ping": {
        const sendAtMs = this.#clock.now();
        this.#send(connection, {
          ...this.#serverEnvelope(sendAtMs),
          type: "pong",
          requestId: message.requestId,
          pingId: message.pingId,
          clientSendTimeMs: message.clientSendTimeMs,
          serverReceiveTimeMs: receivedAtMs,
          serverSendTimeMs: sendAtMs,
        });
        await this.store.save(room);
      }
    }
  }

  async #acceptCommand(
    connection: ConnectionRecord,
    room: RoomRecord,
    participant: ParticipantRecord,
    message: Extract<ClientMessage, { type: "command.submit" }>,
    now: number,
  ): Promise<void> {
    if (room.controlMode === "host-only" && participant.role !== "host") {
      this.#sendError(
        connection,
        "NOT_AUTHORIZED",
        "Only the host can control playback",
        false,
        message.requestId,
      );
      return;
    }
    if (participant.recentCommandIds.has(message.commandId)) {
      this.#sendError(
        connection,
        "DUPLICATE_COMMAND",
        "Command was already accepted",
        false,
        message.requestId,
      );
      return;
    }
    if (
      !this.#acceptClientSequence(
        connection,
        participant,
        message.clientSequence,
        message.requestId,
      )
    ) {
      return;
    }
    participant.recentCommandIds.add(message.commandId);
    if (participant.recentCommandIds.size > MAX_RECENT_COMMAND_IDS) {
      const oldest = participant.recentCommandIds.values().next().value;
      if (oldest !== undefined) {
        participant.recentCommandIds.delete(oldest);
      }
    }
    room.authoritativeParticipantId = participant.participantId;
    room.state = updatePlaybackState(room.state, message.action, now);
    participant.playbackStatus = room.state.status;
    room.serverSequence += 1;
    this.#broadcast(room, {
      ...this.#orderedEnvelope(room, now),
      type: "command.accepted",
      commandId: message.commandId,
      originParticipantId: participant.participantId,
      clientSequence: message.clientSequence,
      action: message.action,
    });
    await this.store.save(room);
  }

  #acceptClientSequence(
    connection: ConnectionRecord,
    participant: ParticipantRecord,
    clientSequence: number,
    requestId: RequestId,
  ): boolean {
    if (clientSequence <= participant.lastClientSequence) {
      this.#sendError(
        connection,
        "STALE_COMMAND",
        "Client sequence must increase monotonically",
        false,
        requestId,
      );
      return false;
    }
    participant.lastClientSequence = clientSequence;
    return true;
  }

  async #leaveRoom(
    connection: ConnectionRecord,
    room: RoomRecord,
    participant: ParticipantRecord,
    reason: Extract<ClientMessage, { type: "participant.leave" }>["reason"],
  ): Promise<void> {
    connection.identity = undefined;
    participant.connectionId = undefined;
    if (participant.role === "host") {
      await this.#endRoom(room, "host-ended", participant.participantId);
      return;
    }
    room.participants.delete(participant.participantId);
    room.lastActivityAtMs = this.#clock.now();
    room.serverSequence += 1;
    this.#broadcast(room, {
      ...this.#orderedEnvelope(room),
      type: "participant.left",
      participantId: participant.participantId,
      reason,
    });
    await this.store.save(room);
  }

  async #disconnectParticipant(connection: ConnectionRecord): Promise<void> {
    const identity = connection.identity;
    connection.identity = undefined;
    if (identity === undefined || this.#closing) {
      return;
    }
    const room = await this.store.getById(identity.roomId);
    const participant = room?.participants.get(identity.participantId);
    if (
      room === undefined ||
      participant === undefined ||
      participant.connectionId !== connection.id ||
      participant.sessionId !== identity.sessionId
    ) {
      return;
    }
    const now = this.#clock.now();
    participant.connectionId = undefined;
    participant.disconnectedAtMs = now;
    participant.ready = false;
    participant.autoplayUnlocked = false;
    participant.playbackStatus = "waiting";
    room.lastActivityAtMs = now;
    room.serverSequence += 1;
    this.#broadcast(room, {
      ...this.#orderedEnvelope(room, now),
      type: "participant.left",
      participantId: participant.participantId,
      reason: "disconnect",
    });
    await this.store.save(room);
  }

  async #endRoom(
    room: RoomRecord,
    reason: "host-ended" | "expired" | "idle-timeout" | "server-shutdown",
    endedByParticipantId?: ParticipantId,
  ): Promise<void> {
    const now = this.#clock.now();
    room.serverSequence += 1;
    this.#broadcast(room, {
      ...this.#orderedEnvelope(room, now),
      type: "room.ended",
      ...(endedByParticipantId === undefined ? {} : { endedByParticipantId }),
      reason,
    });
    for (const participant of room.participants.values()) {
      if (participant.connectionId === undefined) {
        continue;
      }
      const connection = this.#connections.get(participant.connectionId);
      if (
        connection !== undefined &&
        connection.identity?.roomId === room.roomId &&
        connection.identity.participantId === participant.participantId
      ) {
        connection.identity = undefined;
      }
      participant.connectionId = undefined;
    }
    await this.store.delete(room.roomId);
  }

  #sessionFields(room: RoomRecord, participant: ParticipantRecord, token: ReconnectToken) {
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      participantId: participant.participantId,
      sessionId: participant.sessionId,
      reconnectToken: token,
      role: participant.role,
      controlMode: room.controlMode,
      hostParticipantId: room.hostParticipantId,
      participantCapacity: room.participantCapacity,
      expiresAtMs: room.expiresAtMs,
      participants: participantSummaries(room),
      ...(room.state === undefined ? {} : { state: room.state }),
    };
  }

  #serverEnvelope(now = this.#clock.now()) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId: createServerMessageId(),
      serverTimeMs: now,
    };
  }

  #orderedEnvelope(room: RoomRecord, now = this.#clock.now()) {
    return {
      ...this.#serverEnvelope(now),
      roomId: room.roomId,
      serverSequence: room.serverSequence,
    };
  }

  #broadcast(room: RoomRecord, message: unknown, excludedParticipantId?: ParticipantId): void {
    for (const participant of room.participants.values()) {
      if (
        participant.participantId === excludedParticipantId ||
        participant.connectionId === undefined
      ) {
        continue;
      }
      const connection = this.#connections.get(participant.connectionId);
      if (connection !== undefined) {
        this.#send(connection, message);
      }
    }
  }

  #send(connection: ConnectionRecord, candidate: unknown): void {
    if (connection.closed || connection.socket.readyState !== SOCKET_OPEN) {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(candidate);
    if (!parsed.success) {
      this.#logger.error(
        { event: "invalid-outbound-message", issues: parsed.error.issues.length },
        "Refused to send an invalid server message",
      );
      return;
    }
    connection.socket.send(JSON.stringify(parsed.data));
  }

  #sendError(
    connection: ConnectionRecord,
    code: ProtocolErrorCode,
    message: string,
    retryable: boolean,
    requestId?: RequestId,
    retryAfterMs?: number,
  ): void {
    const response: ErrorServerMessage = {
      ...this.#serverEnvelope(),
      type: "error",
      code,
      message,
      retryable,
      ...(requestId === undefined ? {} : { requestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    this.#send(connection, response);
  }

  #invalidMessage(connection: ConnectionRecord, message: string): void {
    connection.invalidMessageCount += 1;
    this.#sendError(connection, "INVALID_MESSAGE", message, false);
    if (connection.invalidMessageCount >= 3) {
      connection.socket.close(1008, "Repeated invalid messages");
    }
  }

  #sendIncompatibleIfApplicable(
    connection: ConnectionRecord,
    payload: string | Uint8Array,
  ): boolean {
    try {
      const text =
        typeof payload === "string"
          ? payload
          : new TextDecoder("utf-8", { fatal: true }).decode(payload);
      const parsed = JSON.parse(text) as unknown;
      const inspection = inspectProtocolVersion(parsed);
      if (inspection.supported) {
        return false;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Object.prototype.hasOwnProperty.call(parsed, "protocolVersion")
      ) {
        return false;
      }
      this.#send(connection, {
        ...this.#serverEnvelope(),
        type: "incompatible",
        receivedVersion: inspection.receivedVersion,
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        code: "PROTOCOL_VERSION_UNSUPPORTED",
      });
      return true;
    } catch {
      return false;
    }
  }

  #internalFailure(connection: ConnectionRecord, error: unknown): void {
    this.#logger.error(
      {
        event: "connection-operation-failed",
        error,
        hasRoom: connection.identity !== undefined,
      },
      "Connection operation failed",
    );
    this.#sendError(connection, "INTERNAL_ERROR", "An internal server error occurred", true);
  }
}

// Compile-time guard: keep this module coupled to the strict shared schema rather than
// maintaining a second hand-written message union.
void ClientMessageSchema;
void (undefined as ServerMessage | undefined);
