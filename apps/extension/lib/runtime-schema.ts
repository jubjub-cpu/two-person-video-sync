import { z } from "zod";

const ControlModeSchema = z.enum(["host-only", "shared"]);
const SyncStatusSchema = z.enum([
  "disabled",
  "no-video",
  "ready",
  "waiting",
  "connected",
  "in-sync",
  "correcting",
  "peer-buffering",
  "mismatch",
  "autoplay-blocked",
  "reconnecting",
  "offline",
  "ended",
]);

const SafeVideoIdentitySchema = z
  .object({
    provider: z.string().min(1).max(80),
    contentKey: z.string().min(1).max(200),
    origin: z.string().url().max(300),
    pathFingerprint: z.string().min(1).max(200),
    titleFingerprint: z.string().min(1).max(200),
    displayTitle: z.string().max(120),
    durationMs: z
      .number()
      .finite()
      .nonnegative()
      .max(31 * 24 * 60 * 60 * 1_000)
      .nullable(),
    isLive: z.boolean(),
    seekable: z.boolean(),
  })
  .strict();

const VideoCapabilitiesSchema = z
  .object({
    canPlay: z.boolean(),
    canPause: z.boolean(),
    canSeek: z.boolean(),
    canSetRate: z.boolean(),
    isLive: z.boolean(),
  })
  .strict();

const VideoSnapshotSchema = z
  .object({
    identity: SafeVideoIdentitySchema,
    positionSeconds: z.number().finite().nonnegative(),
    durationSeconds: z.number().finite().positive().nullable(),
    paused: z.boolean(),
    playbackRate: z.number().finite().min(0.25).max(4),
    readyState: z.number().int().min(0).max(4),
    buffering: z.boolean(),
    ended: z.boolean(),
    adState: z.enum(["content", "ad", "unknown"]),
    capabilities: VideoCapabilitiesSchema,
    capturedAt: z.number().finite().nonnegative(),
  })
  .strict();

const VideoCandidateSummarySchema = z
  .object({
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(160),
    score: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    selected: z.boolean(),
  })
  .strict();

const RoomViewSchema = z
  .object({
    roomCode: z.string().max(32).optional(),
    role: z.enum(["host", "guest"]).optional(),
    participantCount: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    controlMode: ControlModeSchema,
    status: SyncStatusSchema,
    peerStatus: SyncStatusSchema.optional(),
    message: z.string().max(240),
    latencyMs: z.number().finite().nonnegative().optional(),
    driftMs: z.number().finite().optional(),
    expiresAt: z.number().finite().nonnegative().optional(),
    reconnecting: z.boolean().optional(),
    peerVideo: SafeVideoIdentitySchema.optional(),
  })
  .strict();

const LocalMediaActionSchema = z
  .object({
    kind: z.enum(["play", "pause", "seek", "rate", "waiting", "can-play", "ended"]),
    positionSeconds: z.number().finite().nonnegative(),
    playbackRate: z.number().finite().min(0.25).max(4),
  })
  .strict();

const requestId = z.string().min(1).max(100);
const tabId = z.number().int().positive();

export const RuntimeRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("popup/get-state"), requestId, tabId }).strict(),
  z
    .object({
      type: z.literal("popup/activate"),
      requestId,
      tabId,
      originPattern: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal("popup/create-room"),
      requestId,
      tabId,
      controlMode: ControlModeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("popup/join-room"),
      requestId,
      tabId,
      roomCode: z.string().min(1).max(32),
    })
    .strict(),
  z
    .object({
      type: z.literal("popup/leave-room"),
      requestId,
      tabId,
      endRoom: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("popup/set-control-mode"),
      requestId,
      tabId,
      mode: ControlModeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("popup/select-video"),
      requestId,
      tabId,
      candidateId: z.string().min(1).max(160),
    })
    .strict(),
  z.object({ type: z.literal("popup/user-ready"), requestId, tabId }).strict(),
  z.object({ type: z.literal("content/hello"), requestId }).strict(),
  z
    .object({
      type: z.literal("content/snapshot"),
      requestId,
      snapshot: VideoSnapshotSchema,
      candidates: z.array(VideoCandidateSummarySchema).max(32),
    })
    .strict(),
  z
    .object({
      type: z.literal("content/action"),
      requestId,
      action: LocalMediaActionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("content/mismatch"),
      requestId,
      local: SafeVideoIdentitySchema,
      remote: SafeVideoIdentitySchema,
      reason: z.string().min(1).max(240),
    })
    .strict(),
  z.object({ type: z.literal("content/autoplay-blocked"), requestId }).strict(),
  z
    .object({
      type: z.literal("content/ready-state"),
      requestId,
      autoplayUnlocked: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("options/get-diagnostics"), requestId }).strict(),
]);

const RemoteMediaCommandSchema = z
  .object({
    commandId: z.string().min(1).max(160),
    kind: z.enum(["play", "pause", "seek", "rate"]),
    positionSeconds: z.number().finite().nonnegative(),
    playbackRate: z.number().finite().min(0.25).max(4),
    issuedAtServerMs: z.number().finite().nonnegative(),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("background/room-state"),
      room: RoomViewSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("background/remote-command"),
      command: RemoteMediaCommandSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("background/authoritative-snapshot"),
      snapshot: VideoSnapshotSchema,
      serverNowMs: z.number().finite().nonnegative(),
      sequence: z.number().int().nonnegative(),
      commandId: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({
      type: z.literal("background/select-video"),
      candidateId: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({
      type: z.literal("background/status"),
      status: SyncStatusSchema,
      message: z.string().max(240),
    })
    .strict(),
  z.object({ type: z.literal("background/request-snapshot") }).strict(),
  z.object({ type: z.literal("background/user-ready") }).strict(),
  z.object({ type: z.literal("background/deactivate") }).strict(),
]);
