import { z } from "zod";

import {
  CommandIdSchema,
  ParticipantIdSchema,
  PingIdSchema,
  ReconnectTokenSchema,
  RequestIdSchema,
  RoomCodeSchema,
  RoomIdSchema,
  ServerMessageIdSchema,
  SessionIdSchema,
} from "./identifiers.js";
import { ProtocolVersionSchema } from "./version.js";
import { VideoStateSchema } from "./video.js";

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export const TimestampMsSchema = z.number().finite().nonnegative().max(10_000_000_000_000);
export const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PlaybackPositionSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(31 * 24 * 60 * 60);
export const PlaybackRateSchema = z.number().finite().min(0.25).max(4);
export const ControlModeSchema = z.enum(["host-only", "shared"]);
export const ParticipantRoleSchema = z.enum(["host", "guest"]);
export const PlaybackStatusSchema = z.enum([
  "waiting",
  "stalled",
  "playing",
  "can-play",
  "paused",
  "ended",
  "advertisement",
]);
export const LeaveReasonSchema = z.enum([
  "user",
  "navigation",
  "disconnect",
  "timeout",
  "room-ended",
  "replaced-session",
]);

export const PlaybackStateSchema = z
  .object({
    positionSec: PlaybackPositionSchema,
    paused: z.boolean(),
    playbackRate: PlaybackRateSchema,
    status: PlaybackStatusSchema,
    sampledAtTimeMs: TimestampMsSchema,
  })
  .strict();

export const PlayCommandSchema = z
  .object({
    type: z.literal("play"),
    positionSec: PlaybackPositionSchema,
    playbackRate: PlaybackRateSchema,
  })
  .strict();

export const PauseCommandSchema = z
  .object({
    type: z.literal("pause"),
    positionSec: PlaybackPositionSchema,
  })
  .strict();

export const SeekCommandSchema = z
  .object({
    type: z.literal("seek"),
    positionSec: PlaybackPositionSchema,
    paused: z.boolean(),
    playbackRate: PlaybackRateSchema,
  })
  .strict();

export const RateCommandSchema = z
  .object({
    type: z.literal("rate"),
    positionSec: PlaybackPositionSchema,
    playbackRate: PlaybackRateSchema,
    paused: z.boolean(),
  })
  .strict();

export const PlaybackCommandSchema = z.discriminatedUnion("type", [
  PlayCommandSchema,
  PauseCommandSchema,
  SeekCommandSchema,
  RateCommandSchema,
]);

export const ParticipantSummarySchema = z
  .object({
    participantId: ParticipantIdSchema,
    role: ParticipantRoleSchema,
    ready: z.boolean(),
    playbackStatus: PlaybackStatusSchema,
  })
  .strict();

const ClientEnvelopeSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    requestId: RequestIdSchema,
    clientTimeMs: TimestampMsSchema,
  })
  .strict();

const AuthenticatedClientEnvelopeSchema = ClientEnvelopeSchema.extend({
  roomId: RoomIdSchema,
  participantId: ParticipantIdSchema,
  sessionId: SessionIdSchema,
});

export const RoomCreateClientMessageSchema = ClientEnvelopeSchema.extend({
  type: z.literal("room.create"),
  controlMode: ControlModeSchema,
  video: VideoStateSchema.optional(),
});

export const RoomJoinClientMessageSchema = ClientEnvelopeSchema.extend({
  type: z.literal("room.join"),
  roomCode: RoomCodeSchema,
  video: VideoStateSchema.optional(),
});

export const RoomReconnectClientMessageSchema = ClientEnvelopeSchema.extend({
  type: z.literal("room.reconnect"),
  roomId: RoomIdSchema,
  participantId: ParticipantIdSchema,
  reconnectToken: ReconnectTokenSchema,
  lastServerSequence: SequenceSchema,
});

export const ParticipantReadyClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("participant.ready"),
  ready: z.boolean(),
  autoplayUnlocked: z.boolean(),
  video: VideoStateSchema.optional(),
});

export const ParticipantLeaveClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("participant.leave"),
  reason: LeaveReasonSchema,
});

export const RoomEndClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("room.end"),
});

export const ControlSetClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("control.set"),
  controlMode: ControlModeSchema,
});

export const VideoUpdateClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("video.update"),
  video: VideoStateSchema,
});

export const PlaybackStatusClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("playback.status"),
  status: PlaybackStatusSchema,
  positionSec: PlaybackPositionSchema,
  playbackRate: PlaybackRateSchema,
  stalledForMs: z
    .number()
    .int()
    .nonnegative()
    .max(60 * 60 * 1_000)
    .optional(),
});

export const CommandSubmitClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("command.submit"),
  commandId: CommandIdSchema,
  clientSequence: SequenceSchema,
  action: PlaybackCommandSchema,
});

export const StateSnapshotClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("state.snapshot"),
  clientSequence: SequenceSchema,
  state: PlaybackStateSchema,
  video: VideoStateSchema.optional(),
});

export const PingClientMessageSchema = AuthenticatedClientEnvelopeSchema.extend({
  type: z.literal("ping"),
  pingId: PingIdSchema,
  clientSendTimeMs: TimestampMsSchema,
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  RoomCreateClientMessageSchema,
  RoomJoinClientMessageSchema,
  RoomReconnectClientMessageSchema,
  ParticipantReadyClientMessageSchema,
  ParticipantLeaveClientMessageSchema,
  RoomEndClientMessageSchema,
  ControlSetClientMessageSchema,
  VideoUpdateClientMessageSchema,
  PlaybackStatusClientMessageSchema,
  CommandSubmitClientMessageSchema,
  StateSnapshotClientMessageSchema,
  PingClientMessageSchema,
]);

const ServerEnvelopeSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    messageId: ServerMessageIdSchema,
    serverTimeMs: TimestampMsSchema,
  })
  .strict();

const OrderedServerEnvelopeSchema = ServerEnvelopeSchema.extend({
  roomId: RoomIdSchema,
  serverSequence: SequenceSchema,
});

const RoomSessionFields = {
  roomId: RoomIdSchema,
  roomCode: RoomCodeSchema,
  participantId: ParticipantIdSchema,
  sessionId: SessionIdSchema,
  reconnectToken: ReconnectTokenSchema,
  role: ParticipantRoleSchema,
  controlMode: ControlModeSchema,
  hostParticipantId: ParticipantIdSchema,
  expiresAtMs: TimestampMsSchema,
  participants: z.array(ParticipantSummarySchema).min(1).max(2),
  state: PlaybackStateSchema.optional(),
} as const;

export const RoomCreatedServerMessageSchema = ServerEnvelopeSchema.extend({
  type: z.literal("room.created"),
  requestId: RequestIdSchema,
  serverSequence: SequenceSchema,
  ...RoomSessionFields,
  role: z.literal("host"),
});

export const RoomJoinedServerMessageSchema = ServerEnvelopeSchema.extend({
  type: z.literal("room.joined"),
  requestId: RequestIdSchema,
  serverSequence: SequenceSchema,
  ...RoomSessionFields,
});

export const RoomRestoredServerMessageSchema = ServerEnvelopeSchema.extend({
  type: z.literal("room.restored"),
  requestId: RequestIdSchema,
  serverSequence: SequenceSchema,
  ...RoomSessionFields,
});

export const ParticipantJoinedServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("participant.joined"),
  participant: ParticipantSummarySchema,
});

export const ParticipantReadyServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("participant.ready"),
  participantId: ParticipantIdSchema,
  ready: z.boolean(),
  autoplayUnlocked: z.boolean(),
});

export const ParticipantLeftServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("participant.left"),
  participantId: ParticipantIdSchema,
  reason: LeaveReasonSchema,
});

export const ControlUpdatedServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("control.updated"),
  controlMode: ControlModeSchema,
  updatedByParticipantId: ParticipantIdSchema,
});

export const VideoUpdatedServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("video.updated"),
  participantId: ParticipantIdSchema,
  video: VideoStateSchema,
});

export const PlaybackStatusServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("playback.status"),
  participantId: ParticipantIdSchema,
  status: PlaybackStatusSchema,
  positionSec: PlaybackPositionSchema,
  playbackRate: PlaybackRateSchema,
  stalledForMs: z
    .number()
    .int()
    .nonnegative()
    .max(60 * 60 * 1_000)
    .optional(),
});

export const CommandAcceptedServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("command.accepted"),
  commandId: CommandIdSchema,
  originParticipantId: ParticipantIdSchema,
  clientSequence: SequenceSchema,
  action: PlaybackCommandSchema,
});

export const StateSnapshotServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("state.snapshot"),
  authoritativeParticipantId: ParticipantIdSchema,
  state: PlaybackStateSchema,
  participants: z.array(ParticipantSummarySchema).min(1).max(2),
});

export const PongServerMessageSchema = ServerEnvelopeSchema.extend({
  type: z.literal("pong"),
  requestId: RequestIdSchema,
  pingId: PingIdSchema,
  clientSendTimeMs: TimestampMsSchema,
  serverReceiveTimeMs: TimestampMsSchema,
  serverSendTimeMs: TimestampMsSchema,
});

export const RoomEndedServerMessageSchema = OrderedServerEnvelopeSchema.extend({
  type: z.literal("room.ended"),
  endedByParticipantId: ParticipantIdSchema.optional(),
  reason: z.enum(["host-ended", "expired", "idle-timeout", "server-shutdown"]),
});

export const ProtocolErrorCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "PAYLOAD_TOO_LARGE",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_EXPIRED",
  "INVALID_ROOM_CODE",
  "NOT_AUTHORIZED",
  "DUPLICATE_COMMAND",
  "STALE_COMMAND",
  "RATE_LIMITED",
  "SESSION_EXPIRED",
  "RECONNECT_REJECTED",
  "VIDEO_MISMATCH",
  "UNSUPPORTED_VIDEO",
  "ORIGIN_NOT_ALLOWED",
  "INTERNAL_ERROR",
]);

export const ErrorServerMessageSchema = ServerEnvelopeSchema.extend({
  type: z.literal("error"),
  requestId: RequestIdSchema.optional(),
  code: ProtocolErrorCodeSchema,
  message: z
    .string()
    .min(1)
    .max(240)
    .refine(
      (value) => !containsControlCharacters(value),
      "Error message contains control characters",
    ),
  retryable: z.boolean(),
  field: z
    .string()
    .regex(/^[A-Za-z0-9_.[\]-]{1,80}$/)
    .optional(),
  retryAfterMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1_000)
    .optional(),
});

export const IncompatibleServerMessageSchema = ServerEnvelopeSchema.extend({
  type: z.literal("incompatible"),
  requestId: RequestIdSchema.optional(),
  receivedVersion: z.number().int().nonnegative().nullable(),
  supportedVersions: z.array(z.number().int().nonnegative()).min(1).max(8),
  code: z.literal("PROTOCOL_VERSION_UNSUPPORTED"),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  RoomCreatedServerMessageSchema,
  RoomJoinedServerMessageSchema,
  RoomRestoredServerMessageSchema,
  ParticipantJoinedServerMessageSchema,
  ParticipantReadyServerMessageSchema,
  ParticipantLeftServerMessageSchema,
  ControlUpdatedServerMessageSchema,
  VideoUpdatedServerMessageSchema,
  PlaybackStatusServerMessageSchema,
  CommandAcceptedServerMessageSchema,
  StateSnapshotServerMessageSchema,
  PongServerMessageSchema,
  RoomEndedServerMessageSchema,
  ErrorServerMessageSchema,
  IncompatibleServerMessageSchema,
]);

export type TimestampMs = z.infer<typeof TimestampMsSchema>;
export type Sequence = z.infer<typeof SequenceSchema>;
export type PlaybackState = z.infer<typeof PlaybackStateSchema>;
export type PlaybackCommand = z.infer<typeof PlaybackCommandSchema>;
export type ControlMode = z.infer<typeof ControlModeSchema>;
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;
export type PlaybackStatus = z.infer<typeof PlaybackStatusSchema>;
export type LeaveReason = z.infer<typeof LeaveReasonSchema>;
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type ParticipantSummary = z.infer<typeof ParticipantSummarySchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type RoomCreateClientMessage = z.infer<typeof RoomCreateClientMessageSchema>;
export type RoomJoinClientMessage = z.infer<typeof RoomJoinClientMessageSchema>;
export type RoomReconnectClientMessage = z.infer<typeof RoomReconnectClientMessageSchema>;
export type ParticipantReadyClientMessage = z.infer<typeof ParticipantReadyClientMessageSchema>;
export type ParticipantLeaveClientMessage = z.infer<typeof ParticipantLeaveClientMessageSchema>;
export type RoomEndClientMessage = z.infer<typeof RoomEndClientMessageSchema>;
export type ControlSetClientMessage = z.infer<typeof ControlSetClientMessageSchema>;
export type VideoUpdateClientMessage = z.infer<typeof VideoUpdateClientMessageSchema>;
export type PlaybackStatusClientMessage = z.infer<typeof PlaybackStatusClientMessageSchema>;
export type CommandSubmitClientMessage = z.infer<typeof CommandSubmitClientMessageSchema>;
export type StateSnapshotClientMessage = z.infer<typeof StateSnapshotClientMessageSchema>;
export type PingClientMessage = z.infer<typeof PingClientMessageSchema>;

export type RoomCreatedServerMessage = z.infer<typeof RoomCreatedServerMessageSchema>;
export type RoomJoinedServerMessage = z.infer<typeof RoomJoinedServerMessageSchema>;
export type RoomRestoredServerMessage = z.infer<typeof RoomRestoredServerMessageSchema>;
export type CommandAcceptedServerMessage = z.infer<typeof CommandAcceptedServerMessageSchema>;
export type StateSnapshotServerMessage = z.infer<typeof StateSnapshotServerMessageSchema>;
export type ErrorServerMessage = z.infer<typeof ErrorServerMessageSchema>;
export type IncompatibleServerMessage = z.infer<typeof IncompatibleServerMessageSchema>;
