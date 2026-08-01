export type ControlMode = "host-only" | "shared";
export type ThemeMode = "system" | "light" | "dark";

export type SyncStatus =
  | "disabled"
  | "no-video"
  | "ready"
  | "waiting"
  | "connected"
  | "in-sync"
  | "correcting"
  | "peer-buffering"
  | "mismatch"
  | "autoplay-blocked"
  | "reconnecting"
  | "offline"
  | "ended";

export interface ExtensionSettings {
  defaultControlMode: ControlMode;
  themeMode: ThemeMode;
  showBadge: boolean;
  enabledOrigins: string[];
}

export interface SafeVideoIdentity {
  provider: string;
  contentKey: string;
  origin: string;
  pathFingerprint: string;
  titleFingerprint: string;
  displayTitle: string;
  durationMs: number | null;
  isLive: boolean;
  seekable: boolean;
}

export interface VideoCapabilities {
  canPlay: boolean;
  canPause: boolean;
  canSeek: boolean;
  canSetRate: boolean;
  isLive: boolean;
}

export interface VideoSnapshot {
  identity: SafeVideoIdentity;
  positionSeconds: number;
  durationSeconds: number | null;
  paused: boolean;
  playbackRate: number;
  readyState: number;
  buffering: boolean;
  ended: boolean;
  adState: "content" | "ad" | "unknown";
  capabilities: VideoCapabilities;
  capturedAt: number;
}

export interface VideoCandidateSummary {
  id: string;
  label: string;
  score: number;
  width: number;
  height: number;
  selected: boolean;
}

export interface RoomView {
  roomCode?: string;
  role?: "host" | "guest";
  participantCount: 0 | 1 | 2;
  controlMode: ControlMode;
  status: SyncStatus;
  peerStatus?: SyncStatus;
  message: string;
  latencyMs?: number;
  driftMs?: number;
  expiresAt?: number;
  reconnecting?: boolean;
  peerVideo?: SafeVideoIdentity;
}

export interface PopupState {
  enabled: boolean;
  supportedPage: boolean;
  video?: VideoSnapshot;
  candidates: VideoCandidateSummary[];
  room: RoomView;
}

export type LocalMediaAction =
  | { kind: "play"; positionSeconds: number; playbackRate: number }
  | { kind: "pause"; positionSeconds: number; playbackRate: number }
  | { kind: "seek"; positionSeconds: number; playbackRate: number }
  | { kind: "rate"; positionSeconds: number; playbackRate: number }
  | { kind: "waiting"; positionSeconds: number; playbackRate: number }
  | { kind: "can-play"; positionSeconds: number; playbackRate: number }
  | { kind: "ended"; positionSeconds: number; playbackRate: number };

export interface RemoteMediaCommand {
  commandId: string;
  kind: "play" | "pause" | "seek" | "rate";
  positionSeconds: number;
  playbackRate: number;
  issuedAtServerMs: number;
  sequence: number;
}

export type RuntimeRequest =
  | { type: "popup/get-state"; requestId: string; tabId: number }
  | { type: "popup/activate"; requestId: string; tabId: number; originPattern: string }
  | { type: "popup/create-room"; requestId: string; tabId: number; controlMode: ControlMode }
  | { type: "popup/join-room"; requestId: string; tabId: number; roomCode: string }
  | { type: "popup/leave-room"; requestId: string; tabId: number; endRoom: boolean }
  | { type: "popup/set-control-mode"; requestId: string; tabId: number; mode: ControlMode }
  | { type: "popup/select-video"; requestId: string; tabId: number; candidateId: string }
  | { type: "popup/user-ready"; requestId: string; tabId: number }
  | { type: "content/hello"; requestId: string }
  | {
      type: "content/snapshot";
      requestId: string;
      snapshot: VideoSnapshot;
      candidates: VideoCandidateSummary[];
    }
  | { type: "content/action"; requestId: string; action: LocalMediaAction }
  | {
      type: "content/mismatch";
      requestId: string;
      local: SafeVideoIdentity;
      remote: SafeVideoIdentity;
      reason: string;
    }
  | { type: "content/autoplay-blocked"; requestId: string }
  | {
      type: "content/ready-state";
      requestId: string;
      autoplayUnlocked: boolean;
    }
  | { type: "options/get-diagnostics"; requestId: string };

export type RuntimeEvent =
  | { type: "background/room-state"; room: RoomView }
  | { type: "background/remote-command"; command: RemoteMediaCommand }
  | {
      type: "background/authoritative-snapshot";
      snapshot: VideoSnapshot;
      serverNowMs: number;
      sequence: number;
      commandId: string;
    }
  | { type: "background/select-video"; candidateId: string }
  | { type: "background/status"; status: SyncStatus; message: string }
  | { type: "background/request-snapshot" }
  | { type: "background/user-ready" }
  | { type: "background/deactivate" };

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: string;
}

export interface StoredSession {
  tabId: number;
  roomCode: string;
  roomId: string;
  role: "host" | "guest";
  participantId: string;
  sessionId: string;
  reconnectToken: string;
  reconnectExpiresAt: number;
  controlMode: ControlMode;
  lastServerSequence: number;
  clientSequence: number;
}
