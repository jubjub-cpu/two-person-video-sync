import { describe, expect, it } from "vitest";

import {
  ClientMessageSchema,
  PlaybackCommandSchema,
  PlaybackStatusSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  createCommandId,
  createParticipantId,
  createPingId,
  createReconnectToken,
  createRequestId,
  createRoomCode,
  createRoomId,
  createServerMessageId,
  createSessionId,
  normalizeVideoIdentity,
} from "../src/index.js";

const random =
  (value: number) =>
  (buffer: Uint8Array): Uint8Array => {
    buffer.fill(value);
    return buffer;
  };

const requestId = createRequestId(random(1));
const roomId = createRoomId(random(2));
const roomCode = createRoomCode(random(3));
const hostId = createParticipantId(random(4));
const guestId = createParticipantId(random(5));
const sessionId = createSessionId(random(6));
const reconnectToken = createReconnectToken(random(7));
const commandId = createCommandId(random(8));
const pingId = createPingId(random(9));
const messageId = createServerMessageId(random(10));

const video = {
  identity: normalizeVideoIdentity({
    url: "https://example.test/watch/one?secret=removed",
    title: "Safe title",
    durationSec: 300,
  }),
  capabilities: {
    canPlayPause: true,
    canSeek: true,
    canSetPlaybackRate: true,
    seekableStartSec: 0,
    seekableEndSec: 300,
  },
  adState: "content" as const,
};

const playbackState = {
  positionSec: 12,
  paused: false,
  playbackRate: 1,
  status: "playing" as const,
  sampledAtTimeMs: 1_000,
};

const clientBase = {
  protocolVersion: PROTOCOL_VERSION,
  requestId,
  clientTimeMs: 1_000,
};

const authBase = {
  ...clientBase,
  roomId,
  participantId: hostId,
  sessionId,
};

describe("client runtime message schemas", () => {
  const validMessages: unknown[] = [
    { ...clientBase, type: "room.create", controlMode: "host-only", video },
    { ...clientBase, type: "room.join", roomCode, video },
    {
      ...clientBase,
      type: "room.reconnect",
      roomId,
      participantId: hostId,
      reconnectToken,
      lastServerSequence: 4,
    },
    {
      ...authBase,
      type: "participant.ready",
      ready: true,
      autoplayUnlocked: false,
      video,
    },
    { ...authBase, type: "participant.leave", reason: "user" },
    { ...authBase, type: "room.end" },
    { ...authBase, type: "room.transfer-host" },
    { ...authBase, type: "control.set", controlMode: "shared" },
    { ...authBase, type: "video.update", video },
    {
      ...authBase,
      type: "playback.status",
      status: "stalled",
      positionSec: 12,
      playbackRate: 1,
      stalledForMs: 2_500,
    },
    {
      ...authBase,
      type: "command.submit",
      commandId,
      clientSequence: 7,
      action: { type: "seek", positionSec: 99, paused: false, playbackRate: 1.25 },
    },
    {
      ...authBase,
      type: "state.snapshot",
      clientSequence: 8,
      state: playbackState,
      video,
    },
    { ...authBase, type: "ping", pingId, clientSendTimeMs: 1_000 },
  ];

  it.each(validMessages.map((message, index) => [index, message]))(
    "accepts required client message variant %s",
    (_index, message) => {
      expect(ClientMessageSchema.safeParse(message).success).toBe(true);
    },
  );

  it.each(["play", "pause", "seek", "rate"] as const)(
    "runtime-validates the %s command action",
    (type) => {
      const action =
        type === "play"
          ? { type, positionSec: 1, playbackRate: 1 }
          : type === "pause"
            ? { type, positionSec: 1 }
            : type === "seek"
              ? { type, positionSec: 10, paused: false, playbackRate: 1 }
              : { type, positionSec: 10, paused: false, playbackRate: 1.5 };
      expect(PlaybackCommandSchema.safeParse(action).success).toBe(true);
    },
  );

  it.each(["waiting", "stalled", "playing", "can-play", "paused", "ended", "advertisement"])(
    "models the %s playback lifecycle state",
    (status) => {
      expect(PlaybackStatusSchema.safeParse(status).success).toBe(true);
    },
  );

  it("rejects unknown fields, missing auth, bad ranges, and a future protocol version", () => {
    expect(
      ClientMessageSchema.safeParse({
        ...(validMessages[0] as Record<string, unknown>),
        leakedPageContents: "private",
      }).success,
    ).toBe(false);
    expect(
      ClientMessageSchema.safeParse({
        ...authBase,
        type: "participant.leave",
        reason: "user",
        sessionId: undefined,
      }).success,
    ).toBe(false);
    expect(
      ClientMessageSchema.safeParse({
        ...authBase,
        type: "command.submit",
        commandId,
        clientSequence: -1,
        action: { type: "rate", positionSec: 1, paused: false, playbackRate: 20 },
      }).success,
    ).toBe(false);
    expect(
      ClientMessageSchema.safeParse({
        ...(validMessages[0] as Record<string, unknown>),
        protocolVersion: PROTOCOL_VERSION + 1,
      }).success,
    ).toBe(false);
  });
});

const serverBase = {
  protocolVersion: PROTOCOL_VERSION,
  messageId,
  serverTimeMs: 2_000,
};
const orderedBase = {
  ...serverBase,
  roomId,
  serverSequence: 5,
};
const participants = [
  { participantId: hostId, role: "host", ready: true, playbackStatus: "playing" },
] as const;
const roomSession = {
  roomId,
  roomCode,
  participantId: hostId,
  sessionId,
  reconnectToken,
  role: "host" as const,
  controlMode: "host-only" as const,
  hostParticipantId: hostId,
  expiresAtMs: 100_000,
  participants,
  state: playbackState,
};

describe("server runtime message schemas", () => {
  const validMessages: unknown[] = [
    {
      ...serverBase,
      type: "room.created",
      requestId,
      serverSequence: 0,
      ...roomSession,
    },
    {
      ...serverBase,
      type: "room.joined",
      requestId,
      serverSequence: 1,
      ...roomSession,
      participantId: guestId,
      role: "guest",
    },
    {
      ...serverBase,
      type: "room.restored",
      requestId,
      serverSequence: 5,
      ...roomSession,
    },
    {
      ...orderedBase,
      type: "participant.joined",
      participant: {
        participantId: guestId,
        role: "guest",
        ready: false,
        playbackStatus: "waiting",
      },
    },
    {
      ...orderedBase,
      type: "participant.ready",
      participantId: guestId,
      ready: true,
      autoplayUnlocked: true,
    },
    {
      ...orderedBase,
      type: "participant.left",
      participantId: guestId,
      reason: "disconnect",
    },
    {
      ...orderedBase,
      type: "control.updated",
      controlMode: "shared",
      updatedByParticipantId: hostId,
    },
    {
      ...orderedBase,
      type: "room.host-transferred",
      previousHostParticipantId: hostId,
      hostParticipantId: guestId,
      participants: [
        { participantId: guestId, role: "host", ready: false, playbackStatus: "waiting" },
        { participantId: hostId, role: "guest", ready: true, playbackStatus: "playing" },
      ],
    },
    { ...orderedBase, type: "video.updated", participantId: hostId, video },
    {
      ...orderedBase,
      type: "playback.status",
      participantId: guestId,
      status: "can-play",
      positionSec: 12,
      playbackRate: 1,
    },
    {
      ...orderedBase,
      type: "command.accepted",
      commandId,
      originParticipantId: hostId,
      clientSequence: 7,
      action: { type: "play", positionSec: 12, playbackRate: 1 },
    },
    {
      ...orderedBase,
      type: "state.snapshot",
      authoritativeParticipantId: hostId,
      state: playbackState,
      participants,
    },
    {
      ...serverBase,
      type: "pong",
      requestId,
      pingId,
      clientSendTimeMs: 1_000,
      serverReceiveTimeMs: 1_100,
      serverSendTimeMs: 1_101,
    },
    { ...orderedBase, type: "room.ended", reason: "host-ended", endedByParticipantId: hostId },
    {
      ...serverBase,
      type: "error",
      requestId,
      code: "RATE_LIMITED",
      message: "Try again later",
      retryable: true,
      retryAfterMs: 1_000,
    },
    {
      ...serverBase,
      type: "incompatible",
      requestId,
      receivedVersion: 99,
      supportedVersions: [PROTOCOL_VERSION],
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    },
  ];

  it.each(validMessages.map((message, index) => [index, message]))(
    "accepts required server message variant %s",
    (_index, message) => {
      expect(ServerMessageSchema.safeParse(message).success).toBe(true);
    },
  );

  it("rejects room payloads with more than two people and unsafe errors", () => {
    const tooMany = {
      ...(validMessages[0] as Record<string, unknown>),
      participants: [participants[0], participants[0], participants[0]],
    };
    expect(ServerMessageSchema.safeParse(tooMany).success).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        ...serverBase,
        type: "error",
        code: "INTERNAL_ERROR",
        message: "unsafe\nlog",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});
