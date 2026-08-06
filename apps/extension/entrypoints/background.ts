import {
  DEFAULT_ROOM_PARTICIPANT_CAPACITY,
  PROTOCOL_VERSION,
  compareVideoIdentities,
  createCommandId,
  createPingId,
  createRequestId,
  decodeServerMessage,
  normalizeRoomCode,
  type ClientMessage,
  type ParticipantId,
  type ParticipantSummary,
  type PlaybackCommand,
  type ReconnectToken,
  type RequestId,
  type RoomCode,
  type RoomId,
  type ServerMessage,
  type SessionId,
  type VideoIdentity,
  type VideoState,
} from "@vyzync/protocol";
import { ClockEstimator } from "@vyzync/sync-core";
import { browser } from "wxt/browser";

import { failure, success } from "../lib/bridge";
import { recordDiagnostic } from "../lib/diagnostics";
import { RuntimeRequestSchema } from "../lib/runtime-schema";
import { getSettings, originPatternForUrl, saveSettings, SYNC_SERVER_URL } from "../lib/settings";
import type {
  ControlMode,
  LocalMediaAction,
  PopupState,
  RoomView,
  RuntimeEvent,
  RuntimeRequest,
  SafeVideoIdentity,
  StoredSession,
  VideoSnapshot,
} from "../lib/types";

const CONTENT_SCRIPT_FILE = "/content-scripts/content.js";
const STORED_SESSION_KEY = "activeSession";
const LEGACY_STORED_SESSIONS_KEY = "activeSessions";
const SOCKET_HEARTBEAT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SOCKET_ATTEMPT_TIMEOUT_MS = 8_000;
const INITIAL_CONNECT_WINDOW_MS = 75_000;
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type RoomSessionMessage = Extract<
  ServerMessage,
  { type: "room.created" | "room.joined" | "room.restored" }
>;

interface PendingRequest {
  resolve: (message: RoomSessionMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

interface PendingHostTransfer {
  requestId: RequestId;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

interface RoomClientOptions {
  initialTabId: number;
  serverUrl: string;
  onRoom: (room: RoomView) => void;
  onEvent: (event: RuntimeEvent) => void;
  onPersist: (session?: StoredSession) => void;
  getSnapshot: () => VideoSnapshot | undefined;
  restored?: StoredSession;
}

function defaultRoom(controlMode: ControlMode = "host-only"): RoomView {
  return {
    participantCount: 0,
    participantCapacity: DEFAULT_ROOM_PARTICIPANT_CAPACITY,
    participants: [],
    controlMode,
    status: "ready",
    message: "Video found and ready.",
  };
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StoredSession>;
  return (
    Number.isSafeInteger(session.tabId) &&
    (session.tabId ?? 0) > 0 &&
    typeof session.roomCode === "string" &&
    typeof session.roomId === "string" &&
    (session.role === "host" || session.role === "guest") &&
    typeof session.participantId === "string" &&
    typeof session.sessionId === "string" &&
    typeof session.reconnectToken === "string" &&
    typeof session.reconnectExpiresAt === "number" &&
    (session.controlMode === "host-only" || session.controlMode === "shared") &&
    Number.isSafeInteger(session.lastServerSequence) &&
    Number.isSafeInteger(session.clientSequence)
  );
}

function protocolVideo(snapshot: VideoSnapshot): VideoState {
  const known = snapshot.identity.provider !== "generic-html5";
  const identity: VideoIdentity = {
    identityVersion: 1,
    kind: known ? "known" : "generic",
    provider: known ? snapshot.identity.provider : "generic",
    origin: snapshot.identity.origin,
    ...(known
      ? { contentId: snapshot.identity.contentKey }
      : { normalizedPath: `/fingerprint/${snapshot.identity.contentKey}` }),
    titleFingerprint: snapshot.identity.titleFingerprint,
    durationSec: snapshot.durationSeconds,
    isLive: snapshot.identity.isLive,
  };
  return {
    identity,
    capabilities: {
      canPlayPause: snapshot.capabilities.canPlay && snapshot.capabilities.canPause,
      canSeek: snapshot.capabilities.canSeek,
      canSetPlaybackRate: snapshot.capabilities.canSetRate,
      seekableStartSec: snapshot.capabilities.canSeek ? 0 : null,
      seekableEndSec:
        snapshot.capabilities.canSeek && snapshot.durationSeconds !== null
          ? snapshot.durationSeconds
          : null,
    },
    adState:
      snapshot.adState === "ad"
        ? "advertisement"
        : snapshot.adState === "content"
          ? "content"
          : "unknown",
  };
}

function safeVideo(
  identity: VideoIdentity,
  capabilities?: VideoState["capabilities"],
): SafeVideoIdentity {
  return {
    provider: identity.provider === "generic" ? "generic-html5" : identity.provider,
    contentKey:
      identity.contentId ??
      identity.normalizedPath?.replace(/^\/fingerprint\//, "") ??
      identity.titleFingerprint,
    origin: identity.origin,
    pathFingerprint:
      identity.normalizedPath?.replace(/^\/fingerprint\//, "") ?? identity.titleFingerprint,
    titleFingerprint: identity.titleFingerprint,
    displayTitle:
      identity.provider === "generic"
        ? `Video on ${new URL(identity.origin).hostname}`
        : `${identity.provider.replaceAll("-", " ")} video`,
    durationMs: identity.durationSec === null ? null : Math.round(identity.durationSec * 1_000),
    isLive: identity.isLive,
    seekable: capabilities?.canSeek ?? !identity.isLive,
  };
}

function requestError(message: Extract<ServerMessage, { type: "error" }>): Error {
  const friendly: Partial<Record<typeof message.code, string>> = {
    ROOM_FULL: "This room has reached its participant limit.",
    ROOM_NOT_FOUND: "That room was not found or has expired.",
    INVALID_ROOM_CODE: "The room code is not valid.",
    RATE_LIMITED: "Too many requests. Wait briefly and try again.",
    NOT_AUTHORIZED: "Only the host can do that in the current control mode.",
    VIDEO_MISMATCH: "The room has different videos open.",
  };
  return new Error(friendly[message.code] ?? message.message);
}

class RoomClient {
  private socket?: WebSocket;
  private room: RoomView;
  private session?: StoredSession;
  private pending = new Map<RequestId, PendingRequest>();
  private clock = new ClockEstimator();
  private heartbeat?: ReturnType<typeof globalThis.setInterval>;
  private reconnectTimer?: ReturnType<typeof globalThis.setTimeout>;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private connecting?: Promise<void>;
  private readonly participants = new Map<ParticipantId, ParticipantSummary>();
  private readonly remoteVideos = new Map<ParticipantId, VideoState>();
  private lastSentVideoFingerprint?: string;
  private endResolver?: () => void;
  private pendingHostTransfer?: PendingHostTransfer;
  private activeTabId: number;

  constructor(private readonly options: RoomClientOptions) {
    this.activeTabId = options.restored?.tabId ?? options.initialTabId;
    this.session = options.restored;
    this.room = options.restored
      ? {
          roomCode: options.restored.roomCode,
          role: options.restored.role,
          hostParticipantId: options.restored.hostParticipantId,
          participantCount: 1,
          participantCapacity:
            options.restored.participantCapacity ?? DEFAULT_ROOM_PARTICIPANT_CAPACITY,
          participants: [
            {
              participantId: options.restored.participantId,
              role: options.restored.role,
              connected: true,
              isSelf: true,
            },
          ],
          controlMode: options.restored.controlMode,
          status: "reconnecting",
          message: "Restoring the private room…",
          reconnecting: true,
          expiresAt: options.restored.reconnectExpiresAt,
        }
      : defaultRoom();
  }

  view(): RoomView {
    return { ...this.room };
  }

  activateTab(tabId: number): void {
    if (this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.lastSentVideoFingerprint = undefined;
    if (this.session) {
      this.session.tabId = tabId;
      this.persist();
      this.updateRoom({
        status: "waiting",
        message: "Video tab changed. Waiting to verify the new video before resuming.",
      });
    }
  }

  async create(controlMode: ControlMode): Promise<void> {
    await this.connect();
    const requestId = createRequestId();
    const snapshot = this.options.getSnapshot();
    const response = this.waitForSession(requestId);
    this.send({
      type: "room.create",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      clientTimeMs: Date.now(),
      controlMode,
      ...(snapshot ? { video: protocolVideo(snapshot) } : {}),
    });
    await response;
  }

  async join(roomCodeInput: string): Promise<void> {
    await this.connect();
    let roomCode: RoomCode;
    try {
      roomCode = normalizeRoomCode(roomCodeInput);
    } catch {
      throw new Error("Enter the complete 16-character room code.");
    }
    const requestId = createRequestId();
    const snapshot = this.options.getSnapshot();
    const response = this.waitForSession(requestId);
    this.send({
      type: "room.join",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      clientTimeMs: Date.now(),
      roomCode,
      ...(snapshot ? { video: protocolVideo(snapshot) } : {}),
    });
    await response;
  }

  async restore(): Promise<void> {
    if (!this.session || this.session.reconnectExpiresAt <= Date.now()) {
      this.close(true);
      return;
    }
    await this.connect();
    const requestId = createRequestId();
    const response = this.waitForSession(requestId);
    this.send({
      type: "room.reconnect",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      clientTimeMs: Date.now(),
      roomId: this.session.roomId as RoomId,
      participantId: this.session.participantId as ParticipantId,
      reconnectToken: this.session.reconnectToken as ReconnectToken,
      lastServerSequence: this.session.lastServerSequence,
    });
    await response;
  }

  async reconnectNow(): Promise<void> {
    if (!this.session) throw new Error("Join or create a room first.");
    if (this.session.reconnectExpiresAt <= Date.now()) {
      this.close(true);
      throw new Error("This room can no longer reconnect. Create or join a new room.");
    }

    this.updateRoom({
      status: "reconnecting",
      message: "Reconnecting now…",
      reconnecting: true,
    });
    const activeConnection = this.connecting;
    this.close(false);
    if (activeConnection) {
      try {
        await activeConnection;
      } catch {
        // The old connection was intentionally closed before starting a fresh one.
      }
    }

    try {
      await this.restore();
    } catch (error) {
      this.updateRoom({
        status: "reconnecting",
        message: "Could not reconnect yet. Trying again…",
        reconnecting: true,
      });
      this.scheduleReconnect();
      throw error;
    }
  }

  async leave(endRoom: boolean): Promise<void> {
    if (this.session && this.socket?.readyState === WebSocket.OPEN) {
      const authenticated = this.envelope();
      this.send(
        endRoom
          ? { ...authenticated, type: "room.end" }
          : { ...authenticated, type: "participant.leave", reason: "user" },
      );
      if (endRoom) {
        await new Promise<void>((resolve) => {
          const timer = globalThis.setTimeout(resolve, 2_000);
          this.endResolver = () => {
            globalThis.clearTimeout(timer);
            resolve();
          };
        });
      } else {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 150));
      }
    }
    if (this.session) this.close(true);
  }

  setControlMode(mode: ControlMode): void {
    if (!this.session) throw new Error("Join or create a room first.");
    this.send({ ...this.envelope(), type: "control.set", controlMode: mode });
  }

  async transferHost(targetParticipantId: string): Promise<void> {
    if (!this.session) throw new Error("Join or create a room first.");
    if (this.session.role !== "host") throw new Error("Only the host can pass host control.");
    const target = this.participants.get(targetParticipantId as ParticipantId);
    if (!target || !target.connected || target.role !== "guest") {
      throw new Error("Choose a connected guest before passing host control.");
    }
    if (this.pendingHostTransfer) throw new Error("Host control is already being passed.");

    const requestId = createRequestId();
    this.send({
      ...this.envelope(requestId),
      type: "room.transfer-host",
      targetParticipantId: target.participantId,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pendingHostTransfer = undefined;
        reject(new Error("The synchronization service did not confirm the new host."));
      }, REQUEST_TIMEOUT_MS);
      this.pendingHostTransfer = { requestId, resolve, reject, timer };
    });
  }

  setReady(autoplayUnlocked: boolean): void {
    if (!this.session) return;
    const snapshot = this.options.getSnapshot();
    this.send({
      ...this.envelope(),
      type: "participant.ready",
      ready: true,
      autoplayUnlocked,
      ...(snapshot ? { video: protocolVideo(snapshot) } : {}),
    });
  }

  updateSnapshot(snapshot: VideoSnapshot): void {
    if (!this.session || this.socket?.readyState !== WebSocket.OPEN) return;
    const video = protocolVideo(snapshot);
    this.refreshVideoCompatibility(video);
    const videoFingerprint = JSON.stringify(video);
    if (videoFingerprint !== this.lastSentVideoFingerprint) {
      this.send({ ...this.envelope(), type: "video.update", video });
      this.lastSentVideoFingerprint = videoFingerprint;
    }
    if (this.session.role === "guest") {
      this.persist();
      return;
    }
    this.session.clientSequence += 1;
    this.send({
      ...this.envelope(),
      type: "state.snapshot",
      clientSequence: this.session.clientSequence,
      state: {
        positionSec: snapshot.positionSeconds,
        paused: snapshot.paused,
        playbackRate: snapshot.playbackRate,
        status: snapshot.ended
          ? "ended"
          : snapshot.buffering
            ? "stalled"
            : snapshot.paused
              ? "paused"
              : "playing",
        sampledAtTimeMs: Date.now(),
      },
      video,
    });
    this.persist();
  }

  submitAction(action: LocalMediaAction): void {
    if (!this.session) return;
    if (this.session.role === "guest" && this.session.controlMode === "host-only") return;
    if (action.kind === "waiting" || action.kind === "can-play" || action.kind === "ended") {
      this.send({
        ...this.envelope(),
        type: "playback.status",
        status:
          action.kind === "waiting" ? "stalled" : action.kind === "can-play" ? "can-play" : "ended",
        positionSec: action.positionSeconds,
        playbackRate: action.playbackRate,
        ...(action.kind === "waiting" ? { stalledForMs: 1_500 } : {}),
      });
      return;
    }
    this.session.clientSequence += 1;
    const commandId = createCommandId();
    let command: PlaybackCommand;
    switch (action.kind) {
      case "play":
        command = {
          type: "play",
          positionSec: action.positionSeconds,
          playbackRate: action.playbackRate,
        };
        break;
      case "pause":
        command = { type: "pause", positionSec: action.positionSeconds };
        break;
      case "seek":
        command = {
          type: "seek",
          positionSec: action.positionSeconds,
          paused: this.options.getSnapshot()?.paused ?? false,
          playbackRate: action.playbackRate,
        };
        break;
      case "rate":
        command = {
          type: "rate",
          positionSec: action.positionSeconds,
          playbackRate: action.playbackRate,
          paused: this.options.getSnapshot()?.paused ?? false,
        };
        break;
    }
    this.send({
      ...this.envelope(),
      type: "command.submit",
      commandId,
      clientSequence: this.session.clientSequence,
      action: command,
    });
    this.persist();
  }

  markAutoplayBlocked(): void {
    this.updateRoom({
      status: "autoplay-blocked",
      message: "Click once to enable synchronized playback.",
    });
    this.setReady(false);
  }

  markMismatch(remote: SafeVideoIdentity, reason: string): void {
    const followsHost = this.session?.role === "guest";
    this.updateRoom({
      status: "mismatch",
      message: followsHost ? reason : "Someone in the room is on a different video.",
      peerVideo: followsHost ? remote : undefined,
    });
  }

  suspendForNavigation(): void {
    if (!this.session) return;
    this.lastSentVideoFingerprint = undefined;
    this.updateRoom({
      status: "waiting",
      message: "Page changed. Waiting to verify the new video before resuming.",
    });
  }

  close(clearSession: boolean): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.heartbeat) {
      globalThis.clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.pending.forEach(({ reject, timer }) => {
      globalThis.clearTimeout(timer);
      reject(new Error("The room connection closed."));
    });
    this.pending.clear();
    if (this.pendingHostTransfer) {
      globalThis.clearTimeout(this.pendingHostTransfer.timer);
      this.pendingHostTransfer.reject(new Error("The room connection closed."));
      this.pendingHostTransfer = undefined;
    }
    this.socket?.close(1000, "client closing");
    this.socket = undefined;
    if (clearSession) {
      this.session = undefined;
      this.participants.clear();
      this.remoteVideos.clear();
      this.lastSentVideoFingerprint = undefined;
      this.options.onPersist(undefined);
      this.room = defaultRoom(this.room.controlMode);
      this.options.onRoom(this.room);
    }
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.intentionalClose = false;
    const connection = this.session ? this.openSocket() : this.connectWithRetry();
    this.connecting = connection.finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectWithRetry(): Promise<void> {
    const deadline = Date.now() + INITIAL_CONNECT_WINDOW_MS;
    let lastError = new Error("Could not connect to the synchronization service.");
    while (!this.intentionalClose && Date.now() < deadline) {
      try {
        await this.openSocket();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : lastError;
        if (this.intentionalClose || Date.now() >= deadline) break;
        this.updateRoom({
          status: "reconnecting",
          message: "Starting the synchronization service. The first connection can take a minute.",
          reconnecting: true,
        });
        await new Promise<void>((resolve) =>
          globalThis.setTimeout(resolve, INITIAL_RETRY_DELAY_MS),
        );
      }
    }
    this.updateRoom({
      status: "offline",
      message: "Could not reach the synchronization service. Try again in a moment.",
      reconnecting: false,
    });
    throw lastError;
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.options.serverUrl);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Could not open the sync service."));
        return;
      }
      this.socket = socket;
      const timeout = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("The synchronization service did not respond."));
      }, SOCKET_ATTEMPT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        opened = true;
        globalThis.clearTimeout(timeout);
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        globalThis.clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to the synchronization service."));
        }
        if (opened && this.socket === socket) this.handleDisconnect();
      });
      socket.addEventListener("error", () => {
        void recordDiagnostic("background", "socket-error");
      });
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      this.socket?.close(1003, "text messages required");
      return;
    }
    try {
      const message = decodeServerMessage(raw);
      this.handleDecodedMessage(message);
    } catch {
      this.socket?.close(1007, "invalid json");
    }
  }

  private handleDecodedMessage(message: ServerMessage): void {
    const sessionMessage =
      message.type === "room.created" ||
      message.type === "room.joined" ||
      message.type === "room.restored";
    if ("serverSequence" in message && this.session && !sessionMessage) {
      if (message.serverSequence <= this.session.lastServerSequence) return;
      if (message.serverSequence > this.session.lastServerSequence + 1) {
        this.updateRoom({
          status: "reconnecting",
          message: "A synchronization update was missed. Restoring authoritative state.",
          reconnecting: true,
        });
        this.socket?.close(4002, "sequence gap");
        return;
      }
      this.session.lastServerSequence = message.serverSequence;
      this.persist();
    }
    switch (message.type) {
      case "room.created":
      case "room.joined":
      case "room.restored":
        this.acceptSession(message);
        break;
      case "participant.joined": {
        this.participants.set(message.participant.participantId, message.participant);
        this.syncParticipantRoom("A participant connected.");
        break;
      }
      case "participant.left": {
        const current = this.participants.get(message.participantId);
        if (message.reason === "disconnect" && current) {
          this.participants.set(message.participantId, {
            ...current,
            connected: false,
            ready: false,
            playbackStatus: "waiting",
          });
        } else {
          this.participants.delete(message.participantId);
        }
        this.remoteVideos.delete(message.participantId);
        this.syncParticipantRoom(
          this.connectedParticipantCount() > 1
            ? "A participant disconnected. The room is still active."
            : "Waiting for people to connect…",
        );
        break;
      }
      case "participant.ready": {
        const current = this.participants.get(message.participantId);
        if (current) {
          this.participants.set(message.participantId, { ...current, ready: message.ready });
        }
        const connected = [...this.participants.values()].filter(
          (candidate) => candidate.connected,
        );
        const allReady = connected.length > 1 && connected.every((candidate) => candidate.ready);
        this.syncParticipantRoom(
          allReady ? "Everyone is ready." : "Waiting for everyone to get ready.",
          allReady ? "connected" : "waiting",
        );
        break;
      }
      case "control.updated":
        this.updateRoom({ controlMode: message.controlMode });
        if (this.session) {
          this.session.controlMode = message.controlMode;
          this.persist();
        }
        break;
      case "room.host-transferred":
        this.handleHostTransfer(message);
        break;
      case "video.updated":
        this.handleVideoUpdate(message.participantId, message.video);
        break;
      case "playback.status":
        this.handlePlaybackStatus(message.participantId, message.status);
        break;
      case "command.accepted":
        this.handleCommand(message);
        break;
      case "state.snapshot":
        this.handleSnapshot(message);
        break;
      case "pong":
        this.clock.addExchange({
          clientSendTimeMs: message.clientSendTimeMs,
          serverReceiveTimeMs: message.serverReceiveTimeMs,
          serverSendTimeMs: message.serverSendTimeMs,
          clientReceiveTimeMs: Date.now(),
        });
        this.updateRoom({ latencyMs: Math.round(this.clock.estimate()?.rttMs ?? 0) });
        break;
      case "room.ended":
        this.endResolver?.();
        this.endResolver = undefined;
        this.close(true);
        this.updateRoom({
          participantCount: 0,
          participants: [],
          status: "offline",
          message:
            message.reason === "host-ended" ? "The host ended the room." : "The room expired.",
        });
        break;
      case "error": {
        const error = requestError(message);
        if (message.requestId) {
          const pending = this.pending.get(message.requestId);
          if (pending) {
            globalThis.clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            pending.reject(error);
          }
        }
        const pendingHostTransfer = this.pendingHostTransfer;
        if (pendingHostTransfer && message.requestId === pendingHostTransfer.requestId) {
          globalThis.clearTimeout(pendingHostTransfer.timer);
          pendingHostTransfer.reject(error);
          this.pendingHostTransfer = undefined;
        }
        const terminal = [
          "ROOM_NOT_FOUND",
          "ROOM_EXPIRED",
          "SESSION_EXPIRED",
          "RECONNECT_REJECTED",
          "PROTOCOL_VERSION_UNSUPPORTED",
        ].includes(message.code);
        if (terminal) this.close(true);
        this.updateRoom({
          status: terminal
            ? "offline"
            : message.retryable
              ? "reconnecting"
              : this.room.participantCount > 1
                ? "connected"
                : this.room.status,
          message: error.message,
        });
        break;
      }
      case "incompatible":
        this.close(true);
        this.updateRoom({
          status: "offline",
          message: "This extension version can’t connect. Update it and try again.",
        });
        break;
    }
  }

  private acceptSession(message: RoomSessionMessage): void {
    const priorClientSequence = this.session?.clientSequence ?? 0;
    this.participants.clear();
    for (const participant of message.participants) {
      this.participants.set(participant.participantId, participant);
    }
    this.remoteVideos.clear();
    this.session = {
      tabId: this.activeTabId,
      roomCode: message.roomCode,
      roomId: message.roomId,
      role: message.role,
      hostParticipantId: message.hostParticipantId,
      participantCapacity: message.participantCapacity,
      participantId: message.participantId,
      sessionId: message.sessionId,
      reconnectToken: message.reconnectToken,
      reconnectExpiresAt: message.expiresAtMs,
      controlMode: message.controlMode,
      lastServerSequence: message.serverSequence,
      clientSequence: priorClientSequence,
    };
    this.persist();
    const participantCount = this.connectedParticipantCount();
    this.room = {
      roomCode: message.roomCode,
      role: message.role,
      hostParticipantId: message.hostParticipantId,
      participantCount,
      participantCapacity: message.participantCapacity,
      participants: this.participantViews(),
      controlMode: message.controlMode,
      status: participantCount > 1 ? "connected" : "waiting",
      message:
        participantCount > 1
          ? `${participantCount - 1} ${participantCount === 2 ? "person is" : "people are"} connected with you.`
          : `Share the private room code with up to ${message.participantCapacity - 1} people.`,
      expiresAt: message.expiresAtMs,
      reconnecting: false,
    };
    this.options.onRoom(this.room);
    const pending = this.pending.get(message.requestId);
    if (pending) {
      globalThis.clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.resolve(message);
    }
    this.sendPing();
    this.setReady(false);
    const snapshot = this.options.getSnapshot();
    if (snapshot) this.updateSnapshot(snapshot);
  }

  private handleVideoUpdate(participantId: ParticipantId, video: VideoState): void {
    if (!this.session || participantId === this.session.participantId) return;
    this.remoteVideos.set(participantId, video);
    const local = this.options.getSnapshot();
    if (!local) return;
    this.refreshVideoCompatibility(protocolVideo(local));
  }

  private videoCompatibility(local: VideoState, remote: VideoState) {
    const comparison = compareVideoIdentities(local.identity, remote.identity);
    const safeToSynchronize =
      comparison.compatible &&
      local.capabilities.canSeek &&
      remote.capabilities.canSeek &&
      local.adState !== "advertisement" &&
      remote.adState !== "advertisement";
    return { comparison, safeToSynchronize };
  }

  private canSynchronizeWith(participantId: ParticipantId): boolean {
    const local = this.options.getSnapshot();
    const remote = this.remoteVideos.get(participantId);
    return Boolean(
      local && remote && this.videoCompatibility(protocolVideo(local), remote).safeToSynchronize,
    );
  }

  private refreshVideoCompatibility(local: VideoState): void {
    if (!this.session) return;
    const remoteParticipantIds =
      this.session.role === "guest" && this.session.hostParticipantId
        ? [this.session.hostParticipantId as ParticipantId]
        : [...this.participants.values()]
            .filter(
              (participant) =>
                participant.connected && participant.participantId !== this.session?.participantId,
            )
            .map((participant) => participant.participantId);
    const remoteStates = remoteParticipantIds.flatMap((participantId) => {
      const video = this.remoteVideos.get(participantId);
      return video ? [{ participantId, video }] : [];
    });
    if (remoteStates.length === 0) {
      this.updateRoom({ peerVideo: undefined });
      return;
    }

    const blocked = remoteStates.filter(
      ({ video }) => !this.videoCompatibility(local, video).safeToSynchronize,
    );
    const followsHost = this.session.role === "guest";
    const hostVideo = followsHost ? remoteStates[0]?.video : undefined;
    if (blocked.length > 0) {
      const hostComparison = hostVideo
        ? this.videoCompatibility(local, hostVideo).comparison
        : undefined;
      this.updateRoom({
        status: "mismatch",
        message: followsHost
          ? hostComparison?.compatible
            ? "Sync is paused while an ad is playing or the player is unavailable."
            : "The videos don’t match. Open the host’s video to continue."
          : `${blocked.length} ${blocked.length === 1 ? "person is" : "people are"} on a different video.`,
        peerVideo:
          followsHost && hostVideo && !hostComparison?.compatible
            ? safeVideo(hostVideo.identity, hostVideo.capabilities)
            : undefined,
      });
    } else {
      this.updateRoom({
        ...(this.room.status === "mismatch" || this.room.status === "waiting"
          ? { status: "connected" as const, message: "The videos match. Sync is active." }
          : {}),
        peerVideo: hostVideo ? safeVideo(hostVideo.identity, hostVideo.capabilities) : undefined,
      });
    }
  }

  private connectedParticipantCount(): number {
    return [...this.participants.values()].filter((participant) => participant.connected).length;
  }

  private participantViews(): RoomView["participants"] {
    return [...this.participants.values()].map((participant) => ({
      participantId: participant.participantId,
      role: participant.role,
      connected: participant.connected,
      isSelf: participant.participantId === this.session?.participantId,
    }));
  }

  private syncParticipantRoom(message?: string, status?: RoomView["status"]): void {
    const participantCount = this.connectedParticipantCount();
    const peerCount = Math.max(0, participantCount - 1);
    this.updateRoom({
      participantCount,
      participants: this.participantViews(),
      status: status ?? (participantCount > 1 ? "connected" : "waiting"),
      message:
        message ??
        (participantCount > 1
          ? `${peerCount} ${peerCount === 1 ? "person is" : "people are"} connected with you.`
          : "Waiting for people to connect…"),
    });
    const local = this.options.getSnapshot();
    if (local) this.refreshVideoCompatibility(protocolVideo(local));
  }

  private handleHostTransfer(
    message: Extract<ServerMessage, { type: "room.host-transferred" }>,
  ): void {
    if (!this.session) return;
    const role = message.hostParticipantId === this.session.participantId ? "host" : "guest";
    this.session.role = role;
    this.session.hostParticipantId = message.hostParticipantId;
    this.participants.clear();
    for (const participant of message.participants) {
      this.participants.set(participant.participantId, participant);
    }
    this.persist();
    this.updateRoom({
      role,
      hostParticipantId: message.hostParticipantId,
      participantCount: this.connectedParticipantCount(),
      participants: this.participantViews(),
      status: "connected",
      message:
        role === "host"
          ? "You’re now the host. Choose the video for the room."
          : "A new host is leading the room. Follow their video to stay in sync.",
    });

    const snapshot = this.options.getSnapshot();
    if (snapshot) this.updateSnapshot(snapshot);
    else this.options.onEvent({ type: "background/request-snapshot" });

    if (
      message.previousHostParticipantId === this.session.participantId &&
      this.pendingHostTransfer
    ) {
      globalThis.clearTimeout(this.pendingHostTransfer.timer);
      this.pendingHostTransfer.resolve();
      this.pendingHostTransfer = undefined;
    }
  }

  private handlePlaybackStatus(
    participantId: ParticipantId,
    status: "waiting" | "stalled" | "playing" | "can-play" | "paused" | "ended" | "advertisement",
  ): void {
    if (!this.session || participantId === this.session.participantId) return;
    const participant = this.participants.get(participantId);
    if (participant) {
      this.participants.set(participantId, { ...participant, playbackStatus: status });
      this.updateRoom({ participants: this.participantViews() });
    }
    if (!this.canSynchronizeWith(participantId)) return;
    const blockers = [...this.participants.values()].filter(
      (candidate) =>
        candidate.connected &&
        candidate.participantId !== this.session?.participantId &&
        (candidate.playbackStatus === "waiting" ||
          candidate.playbackStatus === "stalled" ||
          candidate.playbackStatus === "advertisement") &&
        this.canSynchronizeWith(candidate.participantId),
    );
    if (blockers.length > 0) {
      this.updateRoom({
        status: "peer-buffering",
        message: `${blockers.length} ${blockers.length === 1 ? "person is" : "people are"} buffering. Holding playback briefly.`,
      });
      this.options.onEvent({
        type: "background/remote-command",
        command: {
          commandId: `barrier-${Date.now()}`,
          kind: "pause",
          positionSeconds: this.options.getSnapshot()?.positionSeconds ?? 0,
          playbackRate: this.options.getSnapshot()?.playbackRate ?? 1,
          issuedAtServerMs: Date.now(),
          sequence: this.session.lastServerSequence,
        },
      });
    } else if (status === "can-play" || status === "playing") {
      this.updateRoom({
        status: "connected",
        message: "Everyone is ready. Resynchronizing…",
      });
      this.options.onEvent({ type: "background/request-snapshot" });
    }
  }

  private handleCommand(message: Extract<ServerMessage, { type: "command.accepted" }>): void {
    if (!this.session || message.originParticipantId === this.session.participantId) return;
    if (!this.canSynchronizeWith(message.originParticipantId)) return;
    const command = message.action;
    const projectedPosition =
      command.type === "play"
        ? command.positionSec +
          (Math.max(0, Date.now() - this.clock.clientTimeAt(message.serverTimeMs)) *
            command.playbackRate) /
            1_000
        : command.positionSec;
    this.options.onEvent({
      type: "background/remote-command",
      command: {
        commandId: message.commandId,
        kind: command.type,
        positionSeconds: projectedPosition,
        playbackRate:
          "playbackRate" in command
            ? command.playbackRate
            : (this.options.getSnapshot()?.playbackRate ?? 1),
        issuedAtServerMs: message.serverTimeMs,
        sequence: message.serverSequence,
      },
    });
    this.updateRoom({
      status: "in-sync",
      message: "Applied a participant’s playback change.",
    });
  }

  private handleSnapshot(message: Extract<ServerMessage, { type: "state.snapshot" }>): void {
    if (!this.session || message.authoritativeParticipantId === this.session.participantId) return;
    for (const participant of message.participants) {
      this.participants.set(participant.participantId, participant);
    }
    this.updateRoom({
      participantCount: this.connectedParticipantCount(),
      participants: this.participantViews(),
    });
    if (!this.canSynchronizeWith(message.authoritativeParticipantId)) return;
    const local = this.options.getSnapshot();
    const remoteVideo = this.remoteVideos.get(message.authoritativeParticipantId);
    if (!local || !remoteVideo) return;
    const snapshot: VideoSnapshot = {
      identity: safeVideo(remoteVideo.identity, remoteVideo.capabilities),
      positionSeconds: message.state.positionSec,
      durationSeconds: remoteVideo.identity.durationSec,
      paused: message.state.paused,
      playbackRate: message.state.playbackRate,
      readyState: 4,
      buffering: message.state.status === "stalled" || message.state.status === "waiting",
      ended: message.state.status === "ended",
      adState: remoteVideo.adState === "advertisement" ? "ad" : remoteVideo.adState,
      capabilities: {
        canPlay: remoteVideo.capabilities.canPlayPause,
        canPause: remoteVideo.capabilities.canPlayPause,
        canSeek: remoteVideo.capabilities.canSeek,
        canSetRate: remoteVideo.capabilities.canSetPlaybackRate,
        isLive: remoteVideo.identity.isLive,
      },
      capturedAt: this.clock.clientTimeAt(message.state.sampledAtTimeMs),
    };
    const expected = snapshot.paused
      ? snapshot.positionSeconds
      : snapshot.positionSeconds +
        (Math.max(0, Date.now() - snapshot.capturedAt) * snapshot.playbackRate) / 1_000;
    this.updateRoom({
      status: "in-sync",
      message: "Authoritative playback state received.",
      driftMs: Math.round((expected - local.positionSeconds) * 1_000),
    });
    this.options.onEvent({
      type: "background/authoritative-snapshot",
      snapshot,
      serverNowMs: message.serverTimeMs,
      sequence: message.serverSequence,
      commandId: `snapshot-${message.serverSequence}`,
    });
  }

  private updateRoom(patch: Partial<RoomView>): void {
    this.room = { ...this.room, ...patch };
    this.options.onRoom(this.room);
  }

  private envelope(requestId = createRequestId()) {
    if (!this.session) throw new Error("No active room session.");
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      clientTimeMs: Date.now(),
      roomId: this.session.roomId as RoomId,
      participantId: this.session.participantId as ParticipantId,
      sessionId: this.session.sessionId as SessionId,
    };
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("The synchronization service is not connected.");
    }
    this.socket.send(JSON.stringify(message));
  }

  private waitForSession(requestId: RequestId): Promise<RoomSessionMessage> {
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("The synchronization service did not complete the request."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) globalThis.clearInterval(this.heartbeat);
    this.sendPing();
    this.heartbeat = globalThis.setInterval(() => {
      this.sendPing();
    }, SOCKET_HEARTBEAT_MS);
  }

  private sendPing(): void {
    if (!this.session || this.socket?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    this.send({
      ...this.envelope(),
      type: "ping",
      pingId: createPingId(),
      clientSendTimeMs: now,
    });
  }

  private handleDisconnect(): void {
    if (this.heartbeat) globalThis.clearInterval(this.heartbeat);
    this.socket = undefined;
    if (this.intentionalClose || !this.session) return;
    this.updateRoom({
      status: "reconnecting",
      message: "Connection lost. Reconnecting with bounded backoff…",
      reconnecting: true,
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.session || this.reconnectTimer) return;
    const base = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** this.reconnectAttempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectAttempt += 1;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.restore().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private persist(): void {
    this.options.onPersist(this.session ? { ...this.session } : undefined);
  }
}

function scriptRegistrationId(originPattern: string): string {
  let hash = 0x811c9dc5;
  for (const character of originPattern) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  }
  return `video-sync-${(hash >>> 0).toString(36)}`;
}

export default defineBackground(() => {
  let roomClient: RoomClient | undefined;
  let activeTabId: number | undefined;
  let persistedSession: StoredSession | undefined;
  const snapshots = new Map<number, VideoSnapshot>();
  const candidates = new Map<number, PopupState["candidates"]>();
  const injectedTabs = new Set<number>();
  const tabOrigins = new Map<number, string>();

  const sendToTab = async (tabId: number, event: RuntimeEvent): Promise<void> => {
    try {
      await browser.tabs.sendMessage(tabId, event);
    } catch {
      // The tab may be navigating or may not have granted access yet.
    }
  };

  const sendToActiveTab = (event: RuntimeEvent): void => {
    if (activeTabId !== undefined) void sendToTab(activeTabId, event);
  };

  const broadcastRoom = (room: RoomView): void => {
    for (const tabId of injectedTabs) {
      void sendToTab(tabId, { type: "background/room-state", room });
    }
    void browser.runtime
      .sendMessage({ type: "background/room-state", room })
      .catch(() => undefined);
  };

  const persistSession = async (): Promise<void> => {
    if (persistedSession) {
      await browser.storage.local.set({ [STORED_SESSION_KEY]: persistedSession });
    } else {
      await browser.storage.local.remove(STORED_SESSION_KEY);
    }
    await browser.storage.local.remove(LEGACY_STORED_SESSIONS_KEY);
  };

  const makeClient = (initialTabId: number, restored?: StoredSession): RoomClient => {
    const client = new RoomClient({
      initialTabId,
      serverUrl: SYNC_SERVER_URL,
      restored,
      getSnapshot: () => (activeTabId === undefined ? undefined : snapshots.get(activeTabId)),
      onRoom: broadcastRoom,
      onEvent: sendToActiveTab,
      onPersist: (session) => {
        persistedSession = session;
        void persistSession();
      },
    });
    roomClient = client;
    return client;
  };

  const activateRoomTab = (tabId: number, requestSnapshot = true): void => {
    const changed = activeTabId !== tabId;
    activeTabId = tabId;
    if (changed) roomClient?.activateTab(tabId);
    if (!roomClient) return;
    broadcastRoom(roomClient.view());
    if (requestSnapshot) {
      void sendToTab(tabId, { type: "background/request-snapshot" });
    }
  };

  const resetRoom = async (): Promise<RoomView> => {
    roomClient = undefined;
    persistedSession = undefined;
    await persistSession();
    const room = defaultRoom((await getSettings()).defaultControlMode);
    broadcastRoom(room);
    return room;
  };

  const registerOrigin = async (originPattern: string): Promise<void> => {
    const id = scriptRegistrationId(originPattern);
    const registered = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
    if (registered.length > 0) return;
    await browser.scripting.registerContentScripts([
      {
        id,
        matches: [originPattern],
        js: [CONTENT_SCRIPT_FILE],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  };

  const reconcilePermissions = async (): Promise<void> => {
    const granted = await browser.permissions.getAll();
    const origins = (granted.origins ?? []).filter(
      (origin) => origin.startsWith("http://") || origin.startsWith("https://"),
    );
    for (const origin of origins) await registerOrigin(origin);
    const desiredIds = new Set(origins.map(scriptRegistrationId));
    const registered = await browser.scripting.getRegisteredContentScripts();
    const staleIds = registered
      .filter((script) => script.id.startsWith("video-sync-") && !desiredIds.has(script.id))
      .map((script) => script.id);
    if (staleIds.length > 0) {
      await browser.scripting.unregisterContentScripts({ ids: staleIds });
    }
    await saveSettings({ enabledOrigins: origins });
  };

  const injectCurrent = async (tabId: number): Promise<void> => {
    if (injectedTabs.has(tabId)) return;
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
    injectedTabs.add(tabId);
  };

  const enabledForTab = async (tabId: number): Promise<boolean> => {
    const tab = await browser.tabs.get(tabId);
    const pattern = originPatternForUrl(tab.url ?? "");
    return pattern ? browser.permissions.contains({ origins: [pattern] }) : false;
  };

  const isFocusedTab = async (tabId: number): Promise<boolean> => {
    const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return focused?.id === tabId;
  };

  const popupState = async (tabId: number): Promise<PopupState> => {
    const settings = await getSettings();
    let tabUrl = "";
    try {
      tabUrl = (await browser.tabs.get(tabId)).url ?? "";
    } catch {
      // The tab may have closed between opening and reading the popup.
    }
    const supportedPage = originPatternForUrl(tabUrl) !== null;
    const enabled = supportedPage && (await enabledForTab(tabId));
    if (enabled) {
      try {
        await injectCurrent(tabId);
        await sendToTab(tabId, { type: "background/request-snapshot" });
      } catch {
        // The page may be navigating; the registered script will load at document_idle.
      }
    }
    const snapshot = snapshots.get(tabId);
    const client = roomClient;
    const room = client?.view() ?? {
      ...defaultRoom(settings.defaultControlMode),
      status: !supportedPage
        ? "no-video"
        : !enabled
          ? "disabled"
          : snapshot?.capabilities.canPlay
            ? "ready"
            : "no-video",
      message: !supportedPage
        ? "Open a regular video page and try again."
        : !enabled
          ? "Enable access to detect and control the video on this site."
          : snapshot?.capabilities.canPlay
            ? "Video found and ready."
            : "Try another video or site.",
    };
    return {
      enabled,
      supportedPage,
      ...(snapshot ? { video: snapshot } : {}),
      candidates: candidates.get(tabId) ?? [],
      room,
    };
  };

  const handle = async (
    request: RuntimeRequest,
    sender: Browser.runtime.MessageSender,
  ): Promise<unknown> => {
    const contentTabId = sender.tab?.id;
    switch (request.type) {
      case "popup/get-state":
        return popupState(request.tabId);
      case "popup/activate":
        await registerOrigin(request.originPattern);
        await injectCurrent(request.tabId);
        return popupState(request.tabId);
      case "popup/create-room": {
        if (roomClient?.view().participantCount) {
          throw new Error("Leave the current room before creating another one.");
        }
        activeTabId = request.tabId;
        const client = roomClient ?? makeClient(request.tabId);
        client.activateTab(request.tabId);
        await client.create(request.controlMode);
        return client.view();
      }
      case "popup/join-room": {
        if (roomClient?.view().participantCount) {
          throw new Error("Leave the current room before joining another one.");
        }
        activeTabId = request.tabId;
        const client = roomClient ?? makeClient(request.tabId);
        client.activateTab(request.tabId);
        await client.join(request.roomCode);
        return client.view();
      }
      case "popup/leave-room": {
        await roomClient?.leave(request.endRoom);
        return resetRoom();
      }
      case "popup/transfer-host": {
        const client = roomClient;
        if (!client) throw new Error("No active room.");
        await client.transferHost(request.targetParticipantId);
        return client.view();
      }
      case "popup/set-control-mode": {
        const client = roomClient;
        if (!client) throw new Error("No active room.");
        client.setControlMode(request.mode);
        return client.view();
      }
      case "popup/select-video":
        activateRoomTab(request.tabId, false);
        await sendToTab(request.tabId, {
          type: "background/select-video",
          candidateId: request.candidateId,
        });
        return undefined;
      case "popup/user-ready": {
        if (snapshots.get(request.tabId)?.capabilities.canPlay) {
          activateRoomTab(request.tabId, false);
        }
        await sendToTab(activeTabId ?? request.tabId, { type: "background/user-ready" });
        return undefined;
      }
      case "content/hello": {
        if (contentTabId === undefined) return undefined;
        injectedTabs.add(contentTabId);
        const originPattern = originPatternForUrl(sender.url ?? "");
        if (originPattern) tabOrigins.set(contentTabId, originPattern);
        if (roomClient) {
          await sendToTab(contentTabId, {
            type: "background/room-state",
            room: roomClient.view(),
          });
        }
        await sendToTab(contentTabId, { type: "background/request-snapshot" });
        return roomClient?.view();
      }
      case "content/snapshot": {
        if (contentTabId === undefined) return undefined;
        snapshots.set(contentTabId, request.snapshot);
        candidates.set(contentTabId, request.candidates);
        if (
          roomClient &&
          contentTabId !== activeTabId &&
          sender.tab?.active &&
          request.snapshot.capabilities.canPlay &&
          (await isFocusedTab(contentTabId))
        ) {
          activateRoomTab(contentTabId, false);
        }
        if (contentTabId === activeTabId) roomClient?.updateSnapshot(request.snapshot);
        return undefined;
      }
      case "content/action":
        if (contentTabId !== undefined && contentTabId === activeTabId) {
          roomClient?.submitAction(request.action);
        }
        return undefined;
      case "content/reconnect": {
        if (contentTabId === undefined) throw new Error("This tab is unavailable.");
        const client = roomClient;
        if (!client) throw new Error("Join or create a room first.");
        await client.reconnectNow();
        return client.view();
      }
      case "content/transfer-host": {
        if (contentTabId === undefined) throw new Error("This tab is unavailable.");
        const client = roomClient;
        if (!client) throw new Error("Join or create a room first.");
        await client.transferHost(request.targetParticipantId);
        return client.view();
      }
      case "content/leave-room": {
        if (contentTabId === undefined) throw new Error("This tab is unavailable.");
        await roomClient?.leave(request.endRoom);
        return resetRoom();
      }
      case "content/autoplay-blocked":
        if (contentTabId !== undefined && contentTabId === activeTabId) {
          roomClient?.markAutoplayBlocked();
        }
        return undefined;
      case "content/ready-state":
        if (contentTabId !== undefined && contentTabId === activeTabId) {
          roomClient?.setReady(request.autoplayUnlocked);
        }
        return undefined;
      case "content/mismatch":
        if (contentTabId !== undefined && contentTabId === activeTabId) {
          roomClient?.markMismatch(request.remote, request.reason);
        }
        return undefined;
      case "options/get-diagnostics":
        return undefined;
    }
  };

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const parsed = RuntimeRequestSchema.safeParse(raw);
    if (!parsed.success) return false;
    const request: RuntimeRequest = parsed.data;
    const contentRequest = request.type.startsWith("content/");
    const extensionPageRequest =
      request.type.startsWith("popup/") || request.type.startsWith("options/");
    if (contentRequest && sender.tab?.id === undefined) return false;
    if (
      extensionPageRequest &&
      (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL("")))
    ) {
      return false;
    }
    void handle(request, sender).then(
      (data) => sendResponse(success(request.requestId, data)),
      (error: unknown) => sendResponse(failure(request.requestId, error)),
    );
    return true;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    if (activeTabId === tabId) {
      activeTabId = undefined;
      roomClient?.suspendForNavigation();
    }
    snapshots.delete(tabId);
    candidates.delete(tabId);
    injectedTabs.delete(tabId);
    tabOrigins.delete(tabId);
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    void (async () => {
      if (!roomClient || !(await isFocusedTab(tabId))) return;
      const snapshot = snapshots.get(tabId);
      if (snapshot?.capabilities.canPlay) {
        activateRoomTab(tabId);
        return;
      }
      try {
        if (!(await enabledForTab(tabId))) return;
        await injectCurrent(tabId);
        await sendToTab(tabId, { type: "background/request-snapshot" });
      } catch {
        // Unsupported and still-loading pages do not replace the current video tab.
      }
    })();
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      if (activeTabId === tabId) roomClient?.suspendForNavigation();
      injectedTabs.delete(tabId);
      snapshots.delete(tabId);
      candidates.delete(tabId);
      tabOrigins.delete(tabId);
      return;
    }
    if (changeInfo.status === "complete" && roomClient) {
      void (async () => {
        let tab: Browser.tabs.Tab;
        try {
          tab = await browser.tabs.get(tabId);
        } catch {
          return;
        }
        if (activeTabId !== tabId && !tab.active) return;
        try {
          if (!(await enabledForTab(tabId))) return;
          await injectCurrent(tabId);
          await sendToTab(tabId, { type: "background/request-snapshot" });
        } catch {
          // A following navigation or activation event will retry the handoff.
        }
      })();
    }
  });

  browser.permissions.onRemoved.addListener(() => {
    void (async () => {
      await reconcilePermissions();
      for (const [tabId, origin] of tabOrigins) {
        if (await browser.permissions.contains({ origins: [origin] })) continue;
        await sendToTab(tabId, { type: "background/deactivate" });
        if (activeTabId === tabId) {
          activeTabId = undefined;
          roomClient?.suspendForNavigation();
        }
        injectedTabs.delete(tabId);
        snapshots.delete(tabId);
        candidates.delete(tabId);
        tabOrigins.delete(tabId);
      }
    })();
  });

  browser.permissions.onAdded.addListener(() => {
    void reconcilePermissions();
  });

  browser.runtime.onInstalled.addListener(() => {
    void reconcilePermissions();
  });

  void (async () => {
    await reconcilePermissions();
    const stored = await browser.storage.local.get([
      STORED_SESSION_KEY,
      LEGACY_STORED_SESSIONS_KEY,
    ]);
    const legacy =
      stored[LEGACY_STORED_SESSIONS_KEY] && typeof stored[LEGACY_STORED_SESSIONS_KEY] === "object"
        ? Object.values(stored[LEGACY_STORED_SESSIONS_KEY] as Record<string, unknown>)
        : [];
    const session = [stored[STORED_SESSION_KEY], ...legacy]
      .filter(isStoredSession)
      .filter((candidate) => candidate.reconnectExpiresAt > Date.now())
      .sort((left, right) => right.reconnectExpiresAt - left.reconnectExpiresAt)[0];
    if (!session) {
      await persistSession();
      return;
    }
    persistedSession = session;
    try {
      await browser.tabs.get(session.tabId);
      activeTabId = session.tabId;
    } catch {
      activeTabId = undefined;
    }
    const client = makeClient(session.tabId, session);
    void client.restore().catch(() => undefined);
    await persistSession();
  })();
});
