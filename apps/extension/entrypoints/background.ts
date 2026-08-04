import {
  PROTOCOL_VERSION,
  compareVideoIdentities,
  createCommandId,
  createPingId,
  createRequestId,
  decodeServerMessage,
  normalizeRoomCode,
  type ClientMessage,
  type ParticipantId,
  type PlaybackCommand,
  type ReconnectToken,
  type RequestId,
  type RoomCode,
  type RoomId,
  type ServerMessage,
  type SessionId,
  type VideoIdentity,
  type VideoState,
} from "@watch-sync/protocol";
import { ClockEstimator } from "@watch-sync/sync-core";
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
const STORED_SESSIONS_KEY = "activeSessions";
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

interface RoomClientOptions {
  tabId: number;
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
    controlMode,
    status: "ready",
    message: "Video found and ready.",
  };
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
    ROOM_FULL: "This private room already has two participants.",
    ROOM_NOT_FOUND: "That room was not found or has expired.",
    INVALID_ROOM_CODE: "The room code is not valid.",
    RATE_LIMITED: "Too many requests. Wait briefly and try again.",
    NOT_AUTHORIZED: "Only the host can do that in the current control mode.",
    VIDEO_MISMATCH: "The two tabs appear to have different videos open.",
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
  private peerVideo?: VideoState;
  private lastSentVideoFingerprint?: string;
  private compatibility: "unknown" | "compatible" | "blocked" = "unknown";
  private endResolver?: () => void;

  constructor(private readonly options: RoomClientOptions) {
    this.session = options.restored;
    this.room = options.restored
      ? {
          roomCode: options.restored.roomCode,
          role: options.restored.role,
          participantCount: 1,
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
    if (this.peerVideo) {
      const comparison = compareVideoIdentities(video.identity, this.peerVideo.identity);
      const safeToSynchronize =
        comparison.compatible &&
        video.capabilities.canSeek &&
        this.peerVideo.capabilities.canSeek &&
        video.adState !== "advertisement" &&
        this.peerVideo.adState !== "advertisement";
      this.compatibility = safeToSynchronize ? "compatible" : "blocked";
      if (!safeToSynchronize) {
        this.updateRoom({
          status: "mismatch",
          message: "The two tabs appear to have different or incompatible videos.",
          peerVideo: safeVideo(this.peerVideo.identity, this.peerVideo.capabilities),
        });
      } else if (this.room.status === "mismatch") {
        this.updateRoom({
          status: "connected",
          message: "Video identities match. Synchronization is active.",
        });
      }
    }
    const videoFingerprint = JSON.stringify(video);
    if (videoFingerprint !== this.lastSentVideoFingerprint) {
      this.send({ ...this.envelope(), type: "video.update", video });
      this.lastSentVideoFingerprint = videoFingerprint;
    }
    if (this.session.role === "guest" && this.session.controlMode === "host-only") {
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
    this.compatibility = "blocked";
    this.updateRoom({
      status: "mismatch",
      message: reason,
      peerVideo: remote,
    });
  }

  suspendForNavigation(): void {
    if (!this.session) return;
    this.peerVideo = undefined;
    this.lastSentVideoFingerprint = undefined;
    this.compatibility = "unknown";
    this.updateRoom({
      status: "waiting",
      message: "Page changed. Waiting to verify the new video before resuming.",
    });
  }

  close(clearSession: boolean): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) globalThis.clearTimeout(this.reconnectTimer);
    if (this.heartbeat) globalThis.clearInterval(this.heartbeat);
    this.pending.forEach(({ reject, timer }) => {
      globalThis.clearTimeout(timer);
      reject(new Error("The room connection closed."));
    });
    this.pending.clear();
    this.socket?.close(1000, "client closing");
    this.socket = undefined;
    if (clearSession) {
      this.session = undefined;
      this.peerVideo = undefined;
      this.lastSentVideoFingerprint = undefined;
      this.compatibility = "unknown";
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
      case "participant.joined":
        this.updateRoom({
          participantCount: 2,
          status: "connected",
          message: "Connected to the other participant.",
        });
        break;
      case "participant.left":
        this.updateRoom({
          participantCount: 1,
          status: "waiting",
          message: "The other participant left. Waiting for reconnection…",
        });
        break;
      case "participant.ready":
        if (this.session && message.participantId !== this.session.participantId) {
          this.updateRoom({
            status: message.ready ? "connected" : "waiting",
            message: message.ready
              ? "Both participants are ready."
              : "Waiting for the other participant to get ready.",
          });
        }
        break;
      case "control.updated":
        this.updateRoom({ controlMode: message.controlMode });
        if (this.session) {
          this.session.controlMode = message.controlMode;
          this.persist();
        }
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
              : this.room.participantCount === 2
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
          message: "The extension and server use incompatible protocol versions.",
        });
        break;
    }
  }

  private acceptSession(message: RoomSessionMessage): void {
    const priorClientSequence = this.session?.clientSequence ?? 0;
    this.peerVideo = undefined;
    this.compatibility = "unknown";
    this.session = {
      tabId: this.options.tabId,
      roomCode: message.roomCode,
      roomId: message.roomId,
      role: message.role,
      participantId: message.participantId,
      sessionId: message.sessionId,
      reconnectToken: message.reconnectToken,
      reconnectExpiresAt: message.expiresAtMs,
      controlMode: message.controlMode,
      lastServerSequence: message.serverSequence,
      clientSequence: priorClientSequence,
    };
    this.persist();
    this.room = {
      roomCode: message.roomCode,
      role: message.role,
      participantCount: message.participants.length as 1 | 2,
      controlMode: message.controlMode,
      status: message.participants.length === 2 ? "connected" : "waiting",
      message:
        message.participants.length === 2
          ? "Connected to the other participant."
          : "Share the private room code with one person.",
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
    this.peerVideo = video;
    const local = this.options.getSnapshot();
    if (!local) return;
    const comparison = compareVideoIdentities(protocolVideo(local).identity, video.identity);
    const safeToSynchronize =
      comparison.compatible &&
      local.capabilities.canSeek &&
      video.capabilities.canSeek &&
      local.adState !== "ad" &&
      video.adState !== "advertisement";
    if (!safeToSynchronize) {
      this.compatibility = "blocked";
      this.updateRoom({
        status: "mismatch",
        message: comparison.compatible
          ? "Synchronization is paused for an ad or unsupported player state."
          : "The two tabs appear to have different or incompatible videos.",
        peerVideo: safeVideo(video.identity, video.capabilities),
      });
    } else {
      this.compatibility = "compatible";
      this.updateRoom({
        status: "connected",
        message: "Video identities match. Synchronization is active.",
        peerVideo: safeVideo(video.identity, video.capabilities),
      });
    }
  }

  private handlePlaybackStatus(
    participantId: ParticipantId,
    status: "waiting" | "stalled" | "playing" | "can-play" | "paused" | "ended" | "advertisement",
  ): void {
    if (!this.session || participantId === this.session.participantId) return;
    if (this.compatibility !== "compatible") return;
    if (status === "waiting" || status === "stalled" || status === "advertisement") {
      this.updateRoom({
        status: "peer-buffering",
        message:
          status === "advertisement"
            ? "Synchronization is paused during the other participant’s ad."
            : "The other participant is buffering. Holding playback briefly.",
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
        message: "Both players are ready. Resynchronizing…",
      });
      this.options.onEvent({ type: "background/request-snapshot" });
    } else if (status === "ended") {
      this.updateRoom({ status: "ended", message: "The other participant reached the end." });
    }
  }

  private handleCommand(message: Extract<ServerMessage, { type: "command.accepted" }>): void {
    if (!this.session || message.originParticipantId === this.session.participantId) return;
    if (this.compatibility !== "compatible") return;
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
      message: "Applied the other participant’s playback change.",
    });
  }

  private handleSnapshot(message: Extract<ServerMessage, { type: "state.snapshot" }>): void {
    if (!this.session || message.authoritativeParticipantId === this.session.participantId) return;
    if (this.compatibility !== "compatible") return;
    const local = this.options.getSnapshot();
    const remoteVideo = this.peerVideo;
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

  private envelope() {
    if (!this.session) throw new Error("No active room session.");
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: createRequestId(),
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
  const clients = new Map<number, RoomClient>();
  const snapshots = new Map<number, VideoSnapshot>();
  const candidates = new Map<number, PopupState["candidates"]>();
  const injectedTabs = new Set<number>();
  const tabOrigins = new Map<number, string>();
  const persisted = new Map<number, StoredSession>();

  const sendToTab = async (tabId: number, event: RuntimeEvent): Promise<void> => {
    try {
      await browser.tabs.sendMessage(tabId, event);
    } catch {
      // The tab may be navigating or may not have granted access yet.
    }
  };

  const broadcastRoom = (tabId: number, room: RoomView): void => {
    void sendToTab(tabId, { type: "background/room-state", room });
    void browser.runtime
      .sendMessage({ type: "background/room-state", room })
      .catch(() => undefined);
  };

  const persistSessions = async (): Promise<void> => {
    await browser.storage.local.set({
      [STORED_SESSIONS_KEY]: Object.fromEntries(
        [...persisted.entries()].map(([tabId, session]) => [String(tabId), session]),
      ),
    });
  };

  const makeClient = (tabId: number, restored?: StoredSession): RoomClient => {
    const client = new RoomClient({
      tabId,
      serverUrl: SYNC_SERVER_URL,
      restored,
      getSnapshot: () => snapshots.get(tabId),
      onRoom: (room) => broadcastRoom(tabId, room),
      onEvent: (event) => void sendToTab(tabId, event),
      onPersist: (session) => {
        if (session) persisted.set(tabId, session);
        else persisted.delete(tabId);
        void persistSessions();
      },
    });
    clients.set(tabId, client);
    return client;
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
    const client = clients.get(tabId);
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
        ? "Browser pages, PDFs, and extension stores cannot be controlled."
        : !enabled
          ? "Enable access to detect and control the video on this site."
          : snapshot?.capabilities.canPlay
            ? "Video found and ready."
            : "No controllable HTML5 video was found on this page.",
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
        const client = clients.get(request.tabId) ?? makeClient(request.tabId);
        await client.create(request.controlMode);
        return client.view();
      }
      case "popup/join-room": {
        const client = clients.get(request.tabId) ?? makeClient(request.tabId);
        await client.join(request.roomCode);
        return client.view();
      }
      case "popup/leave-room": {
        const client = clients.get(request.tabId);
        await client?.leave(request.endRoom);
        clients.delete(request.tabId);
        return defaultRoom((await getSettings()).defaultControlMode);
      }
      case "popup/set-control-mode": {
        const client = clients.get(request.tabId);
        if (!client) throw new Error("No active room.");
        client.setControlMode(request.mode);
        return client.view();
      }
      case "popup/select-video":
        await sendToTab(request.tabId, {
          type: "background/select-video",
          candidateId: request.candidateId,
        });
        return undefined;
      case "popup/user-ready": {
        await sendToTab(request.tabId, { type: "background/user-ready" });
        return undefined;
      }
      case "content/hello": {
        if (contentTabId === undefined) return undefined;
        injectedTabs.add(contentTabId);
        const originPattern = originPatternForUrl(sender.url ?? "");
        if (originPattern) tabOrigins.set(contentTabId, originPattern);
        const restored = clients.get(contentTabId);
        if (restored) broadcastRoom(contentTabId, restored.view());
        await sendToTab(contentTabId, { type: "background/request-snapshot" });
        return restored?.view();
      }
      case "content/snapshot": {
        if (contentTabId === undefined) return undefined;
        snapshots.set(contentTabId, request.snapshot);
        candidates.set(contentTabId, request.candidates);
        clients.get(contentTabId)?.updateSnapshot(request.snapshot);
        return undefined;
      }
      case "content/action":
        if (contentTabId !== undefined) clients.get(contentTabId)?.submitAction(request.action);
        return undefined;
      case "content/autoplay-blocked":
        if (contentTabId !== undefined) clients.get(contentTabId)?.markAutoplayBlocked();
        return undefined;
      case "content/ready-state":
        if (contentTabId !== undefined) {
          clients.get(contentTabId)?.setReady(request.autoplayUnlocked);
        }
        return undefined;
      case "content/mismatch":
        if (contentTabId !== undefined) {
          clients.get(contentTabId)?.markMismatch(request.remote, request.reason);
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
    const client = clients.get(tabId);
    void client?.leave(false);
    clients.delete(tabId);
    snapshots.delete(tabId);
    candidates.delete(tabId);
    injectedTabs.delete(tabId);
    tabOrigins.delete(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      clients.get(tabId)?.suspendForNavigation();
      injectedTabs.delete(tabId);
      snapshots.delete(tabId);
      candidates.delete(tabId);
      tabOrigins.delete(tabId);
      return;
    }
    if (changeInfo.status === "complete" && clients.has(tabId)) {
      void (async () => {
        let enabled = false;
        try {
          enabled = await enabledForTab(tabId);
        } catch {
          enabled = false;
        }
        if (!enabled) {
          void clients.get(tabId)?.leave(false);
          clients.delete(tabId);
          persisted.delete(tabId);
          await persistSessions();
          return;
        }
        try {
          await injectCurrent(tabId);
          await sendToTab(tabId, { type: "background/request-snapshot" });
        } catch {
          // A following navigation event will retry or close the stale session.
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
    const stored = await browser.storage.local.get(STORED_SESSIONS_KEY);
    const sessions =
      stored[STORED_SESSIONS_KEY] && typeof stored[STORED_SESSIONS_KEY] === "object"
        ? (stored[STORED_SESSIONS_KEY] as Record<string, StoredSession>)
        : {};
    for (const [tabIdText, session] of Object.entries(sessions)) {
      const tabId = Number(tabIdText);
      if (!Number.isSafeInteger(tabId) || session.reconnectExpiresAt <= Date.now()) continue;
      try {
        await browser.tabs.get(tabId);
        persisted.set(tabId, session);
        const client = makeClient(tabId, session);
        void client.restore().catch(() => undefined);
      } catch {
        persisted.delete(tabId);
      }
    }
    await persistSessions();
  })();
});
