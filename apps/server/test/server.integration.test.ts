import {
  PROTOCOL_VERSION,
  createCommandId,
  createParticipantId,
  createPingId,
  createSessionId,
} from "@vyzync/protocol";
import type { ClientMessage, PlaybackCommand } from "@vyzync/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  TEST_ORIGIN,
  TestClient,
  VIDEO,
  auth,
  createRoom,
  envelope,
  joinRoom,
  startHarness,
} from "./helpers.js";
import type { TestHarness } from "./helpers.js";

const harnesses: TestHarness[] = [];

async function harness(overrides: Parameters<typeof startHarness>[0] = {}): Promise<TestHarness> {
  const started = await startHarness(overrides);
  harnesses.push(started);
  return started;
}

async function expectUpgradeRejected(
  server: TestHarness,
  statusCode: number,
  origin = TEST_ORIGIN,
): Promise<void> {
  await expect(TestClient.connect(server.wsUrl, origin)).rejects.toThrow();
  const response = await server.built.app.inject({
    method: "GET",
    url: "/ws",
    headers: {
      connection: "upgrade",
      origin,
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      upgrade: "websocket",
    },
  });
  expect(response.statusCode).toBe(statusCode);
}

async function expectClientClosed(
  client: TestClient,
  expectedCode: number,
  scenario: string,
): Promise<void> {
  try {
    expect(await client.waitForClose()).toBe(expectedCode);
  } catch (error) {
    throw new Error(
      `${scenario}: ${error instanceof Error ? error.message : "WebSocket did not close"}`,
    );
  }
}

afterEach(async () => {
  for (const current of harnesses.splice(0).reverse()) {
    await current.stop();
  }
});

describe("Vyzync WebSocket service", () => {
  it("holds a host and three guests, broadcasts presence, and enforces room capacity", async () => {
    const server = await harness({ maxParticipantsPerRoom: 4 });
    const host = await TestClient.connect(server.wsUrl);
    const firstGuest = await TestClient.connect(server.wsUrl);
    const secondGuest = await TestClient.connect(server.wsUrl);
    const thirdGuest = await TestClient.connect(server.wsUrl);
    const overflow = await TestClient.connect(server.wsUrl);

    const created = await createRoom(host, server.clock);
    expect(created.role).toBe("host");
    expect(created.participantCapacity).toBe(4);
    expect(created.participants).toHaveLength(1);
    const firstJoined = await joinRoom(firstGuest, server.clock, created.roomCode);
    expect((await host.nextType("participant.joined")).participant.participantId).toBe(
      firstJoined.participantId,
    );
    const secondJoined = await joinRoom(secondGuest, server.clock, created.roomCode);
    expect((await host.nextType("participant.joined")).participant.participantId).toBe(
      secondJoined.participantId,
    );
    expect((await firstGuest.nextType("participant.joined")).participant.participantId).toBe(
      secondJoined.participantId,
    );
    const thirdJoined = await joinRoom(thirdGuest, server.clock, created.roomCode);
    expect(thirdJoined.role).toBe("guest");
    expect(thirdJoined.participants).toHaveLength(4);
    expect(thirdJoined.participants.every((participant) => participant.connected)).toBe(true);
    for (const existing of [host, firstGuest, secondGuest]) {
      expect((await existing.nextType("participant.joined")).participant.participantId).toBe(
        thirdJoined.participantId,
      );
    }

    overflow.send({
      ...envelope(server.clock),
      type: "room.join",
      roomCode: created.roomCode,
    });
    const full = await overflow.nextType("error");
    expect(full.code).toBe("ROOM_FULL");

    const health = await server.built.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(health.json()).toMatchObject({
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      rooms: 1,
      connections: 5,
    });
  });

  it("orders play, pause, seek, and rate commands and rejects unauthorized, duplicate, and stale input", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const guest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);
    const joined = await joinRoom(guest, server.clock, created.roomCode);

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "command.submit",
      commandId: createCommandId(),
      clientSequence: 0,
      action: { type: "play", positionSec: 10, playbackRate: 1 },
    });
    expect((await guest.nextType("error")).code).toBe("NOT_AUTHORIZED");

    const actions: PlaybackCommand[] = [
      { type: "play", positionSec: 10, playbackRate: 1 },
      { type: "pause", positionSec: 12 },
      { type: "seek", positionSec: 120, paused: true, playbackRate: 1 },
      { type: "rate", positionSec: 120, paused: false, playbackRate: 1.25 },
    ];
    const acceptedSequences: number[] = [];
    let firstMessage: Extract<ClientMessage, { type: "command.submit" }> | undefined;
    for (const [clientSequence, action] of actions.entries()) {
      const message: Extract<ClientMessage, { type: "command.submit" }> = {
        ...envelope(server.clock),
        ...auth(created),
        type: "command.submit",
        commandId: createCommandId(),
        clientSequence,
        action,
      };
      firstMessage ??= message;
      host.send(message);
      const hostAccepted = await host.nextType("command.accepted");
      const guestAccepted = await guest.nextType("command.accepted");
      expect(guestAccepted).toEqual(hostAccepted);
      expect(hostAccepted.action.type).toBe(action.type);
      acceptedSequences.push(hostAccepted.serverSequence);
    }
    expect(acceptedSequences).toEqual([...acceptedSequences].sort((left, right) => left - right));
    expect(new Set(acceptedSequences).size).toBe(actions.length);

    if (firstMessage === undefined) {
      throw new Error("Expected a command fixture");
    }
    host.send(firstMessage);
    expect((await host.nextType("error")).code).toBe("DUPLICATE_COMMAND");

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "command.submit",
      commandId: createCommandId(),
      clientSequence: 3,
      action: { type: "pause", positionSec: 121 },
    });
    expect((await host.nextType("error")).code).toBe("STALE_COMMAND");
  });

  it("allows both participants in shared mode while preserving host-only control-mode authority", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const guest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock, "shared");
    const joined = await joinRoom(guest, server.clock, created.roomCode);

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "command.submit",
      commandId: createCommandId(),
      clientSequence: 0,
      action: { type: "seek", positionSec: 42, paused: false, playbackRate: 1 },
    });
    const accepted = await host.nextType("command.accepted");
    expect(accepted.originParticipantId).toBe(joined.participantId);
    expect((await guest.nextType("command.accepted")).serverSequence).toBe(accepted.serverSequence);

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "control.set",
      controlMode: "host-only",
    });
    expect((await guest.nextType("error")).code).toBe("NOT_AUTHORIZED");

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "control.set",
      controlMode: "host-only",
    });
    expect((await guest.nextType("control.updated")).controlMode).toBe("host-only");

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "command.submit",
      commandId: createCommandId(),
      clientSequence: 1,
      action: { type: "pause", positionSec: 42 },
    });
    expect((await guest.nextType("error")).code).toBe("NOT_AUTHORIZED");
  });

  it("transfers host authority to a selected guest and preserves every other role", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const firstGuest = await TestClient.connect(server.wsUrl);
    const secondGuest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "room.transfer-host",
      targetParticipantId: createParticipantId(),
    });
    expect((await host.nextType("error")).message).toContain("must be connected");

    const firstJoined = await joinRoom(firstGuest, server.clock, created.roomCode);
    const secondJoined = await joinRoom(secondGuest, server.clock, created.roomCode);
    firstGuest.send({
      ...envelope(server.clock),
      ...auth(firstJoined),
      type: "room.transfer-host",
      targetParticipantId: secondJoined.participantId,
    });
    expect((await firstGuest.nextType("error")).code).toBe("NOT_AUTHORIZED");

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "room.transfer-host",
      targetParticipantId: secondJoined.participantId,
    });
    const hostTransfer = await host.nextType("room.host-transferred");
    const firstGuestTransfer = await firstGuest.nextType("room.host-transferred");
    const secondGuestTransfer = await secondGuest.nextType("room.host-transferred");
    expect(firstGuestTransfer).toEqual(hostTransfer);
    expect(secondGuestTransfer).toEqual(hostTransfer);
    expect(hostTransfer).toMatchObject({
      previousHostParticipantId: created.participantId,
      hostParticipantId: secondJoined.participantId,
      participants: [
        { participantId: secondJoined.participantId, role: "host", connected: true },
        { participantId: created.participantId, role: "guest" },
        { participantId: firstJoined.participantId, role: "guest" },
      ],
    });

    const storedRoom = await server.built.service.store.getById(created.roomId);
    expect(storedRoom?.hostParticipantId).toBe(secondJoined.participantId);
    expect(storedRoom?.authoritativeParticipantId).toBe(secondJoined.participantId);
    expect(storedRoom?.state).toBeUndefined();

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "command.submit",
      commandId: createCommandId(),
      clientSequence: 0,
      action: { type: "play", positionSec: 15, playbackRate: 1 },
    });
    expect((await host.nextType("error")).code).toBe("NOT_AUTHORIZED");

    secondGuest.send({
      ...envelope(server.clock),
      ...auth(secondJoined),
      type: "command.submit",
      commandId: createCommandId(),
      clientSequence: 0,
      action: { type: "play", positionSec: 15, playbackRate: 1 },
    });
    const accepted = await secondGuest.nextType("command.accepted");
    expect(accepted.originParticipantId).toBe(secondJoined.participantId);
    expect((await host.nextType("command.accepted")).serverSequence).toBe(accepted.serverSequence);
    expect((await firstGuest.nextType("command.accepted")).serverSequence).toBe(
      accepted.serverSequence,
    );

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "room.end",
    });
    expect((await host.nextType("error")).code).toBe("NOT_AUTHORIZED");

    secondGuest.send({
      ...envelope(server.clock),
      ...auth(secondJoined),
      type: "room.end",
    });
    expect((await secondGuest.nextType("room.ended")).endedByParticipantId).toBe(
      secondJoined.participantId,
    );
    expect((await host.nextType("room.ended")).reason).toBe("host-ended");
    expect((await firstGuest.nextType("room.ended")).reason).toBe("host-ended");
  });

  it("broadcasts readiness, video, playback status, snapshots, and NTP-style pong timestamps", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const guest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock, "host-only", VIDEO);
    const joined = await joinRoom(guest, server.clock, created.roomCode, VIDEO);

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "participant.ready",
      ready: true,
      autoplayUnlocked: true,
      video: VIDEO,
    });
    const ready = await host.nextType("participant.ready");
    expect(ready).toMatchObject({
      participantId: joined.participantId,
      ready: true,
      autoplayUnlocked: true,
    });
    expect((await guest.nextType("participant.ready")).serverSequence).toBe(ready.serverSequence);

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "playback.status",
      status: "stalled",
      positionSec: 25,
      playbackRate: 1,
      stalledForMs: 2_500,
    });
    const status = await host.nextType("playback.status");
    expect(status).toMatchObject({ status: "stalled", stalledForMs: 2_500 });

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "state.snapshot",
      clientSequence: 0,
      state: {
        positionSec: 30,
        paused: false,
        playbackRate: 1,
        status: "playing",
        sampledAtTimeMs: server.clock.now(),
      },
      video: VIDEO,
    });
    const snapshot = await guest.nextType("state.snapshot");
    expect(snapshot.authoritativeParticipantId).toBe(created.participantId);
    expect(snapshot.state.positionSec).toBe(30);
    expect(snapshot.participants).toHaveLength(2);

    const pingId = createPingId();
    const sendTime = server.clock.now() - 25;
    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "ping",
      pingId,
      clientSendTimeMs: sendTime,
    });
    const pong = await host.nextType("pong");
    expect(pong).toMatchObject({
      pingId,
      clientSendTimeMs: sendTime,
      serverReceiveTimeMs: server.clock.now(),
      serverSendTimeMs: server.clock.now(),
    });

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "video.update",
      video: { ...VIDEO, adState: "advertisement" },
    });
    const video = (await host.next(
      (message) =>
        message.type === "video.updated" &&
        message.participantId === joined.participantId &&
        message.video.adState === "advertisement",
    )) as Extract<Awaited<ReturnType<typeof host.next>>, { type: "video.updated" }>;
    expect(video.participantId).toBe(joined.participantId);
    expect(video.video.adState).toBe("advertisement");
  });

  it("rejects malformed, binary, oversized, and incompatible messages", async () => {
    const server = await harness();

    const malformed = await TestClient.connect(server.wsUrl);
    for (let count = 0; count < 3; count += 1) {
      malformed.sendRaw("{");
      expect((await malformed.nextType("error")).code).toBe("INVALID_MESSAGE");
    }
    await expectClientClosed(malformed, 1008, "repeated malformed message close");

    const binary = await TestClient.connect(server.wsUrl);
    binary.sendRaw(Buffer.from("{}"));
    expect((await binary.nextType("error")).code).toBe("INVALID_MESSAGE");
    await expectClientClosed(binary, 1003, "binary message close");

    const incompatible = await TestClient.connect(server.wsUrl);
    incompatible.sendRaw(
      JSON.stringify({
        ...envelope(server.clock),
        protocolVersion: 99,
        type: "room.create",
        controlMode: "host-only",
      }),
    );
    const version = await incompatible.nextType("incompatible");
    expect(version).toMatchObject({
      receivedVersion: 99,
      supportedVersions: [PROTOCOL_VERSION],
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expectClientClosed(incompatible, 1002, "incompatible protocol close");

    const oversized = await TestClient.connect(server.wsUrl);
    oversized.sendRaw("x".repeat(16 * 1024 + 1));
    await expectClientClosed(oversized, 1009, "oversized message close");
  });

  it("restores a disconnected participant, rotates credentials, and rejects an old token", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const guest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);
    await joinRoom(guest, server.clock, created.roomCode);
    await host.nextType("participant.joined");

    host.terminate();
    const disconnected = await guest.nextType("participant.left");
    expect(disconnected.reason).toBe("disconnect");

    const replacement = await TestClient.connect(server.wsUrl);
    replacement.send({
      ...envelope(server.clock),
      type: "room.reconnect",
      roomId: created.roomId,
      participantId: created.participantId,
      reconnectToken: created.reconnectToken,
      lastServerSequence: disconnected.serverSequence,
    });
    const restored = await replacement.nextType("room.restored");
    expect(restored.sessionId).not.toBe(created.sessionId);
    expect(restored.reconnectToken).not.toBe(created.reconnectToken);
    expect((await guest.nextType("participant.joined")).participant.participantId).toBe(
      created.participantId,
    );

    const replay = await TestClient.connect(server.wsUrl);
    replay.send({
      ...envelope(server.clock),
      type: "room.reconnect",
      roomId: created.roomId,
      participantId: created.participantId,
      reconnectToken: created.reconnectToken,
      lastServerSequence: restored.serverSequence,
    });
    expect((await replay.nextType("error")).code).toBe("RECONNECT_REJECTED");
  });

  it("replaces an active session only with its reconnect credential", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);
    const replacement = await TestClient.connect(server.wsUrl);
    const oldClosed = host.waitForClose();
    replacement.send({
      ...envelope(server.clock),
      type: "room.reconnect",
      roomId: created.roomId,
      participantId: created.participantId,
      reconnectToken: created.reconnectToken,
      lastServerSequence: created.serverSequence,
    });
    const restored = await replacement.nextType("room.restored");
    expect(restored.participantId).toBe(created.participantId);
    expect(await oldClosed).toBe(4001);
  });

  it("removes an explicitly leaving guest and permits a replacement guest", async () => {
    const server = await harness({ maxParticipantsPerRoom: 2 });
    const host = await TestClient.connect(server.wsUrl);
    const guest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);
    const joined = await joinRoom(guest, server.clock, created.roomCode);

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "participant.leave",
      reason: "user",
    });
    const left = await host.nextType("participant.left");
    expect(left).toMatchObject({ participantId: joined.participantId, reason: "user" });

    const replacement = await TestClient.connect(server.wsUrl);
    const replacementSession = await joinRoom(replacement, server.clock, created.roomCode);
    expect(replacementSession.participantId).not.toBe(joined.participantId);
  });

  it("reserves a disconnected slot only for the configured reconnect grace period", async () => {
    const server = await harness({ reconnectGraceMs: 1_000, maxParticipantsPerRoom: 2 });
    const host = await TestClient.connect(server.wsUrl);
    const guest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);
    await joinRoom(guest, server.clock, created.roomCode);
    guest.terminate();
    expect((await host.nextType("participant.left")).reason).toBe("disconnect");

    const early = await TestClient.connect(server.wsUrl);
    early.send({
      ...envelope(server.clock),
      type: "room.join",
      roomCode: created.roomCode,
    });
    expect((await early.nextType("error")).code).toBe("ROOM_FULL");

    server.clock.advance(1_001);
    await server.built.service.cleanup();
    expect((await host.nextType("participant.left")).reason).toBe("timeout");

    const replacement = await TestClient.connect(server.wsUrl);
    expect((await joinRoom(replacement, server.clock, created.roomCode)).role).toBe("guest");
  });

  it("expires rooms by absolute lifetime and idle timeout", async () => {
    const absolute = await harness({ roomTtlMs: 1_000, roomIdleTtlMs: 10_000 });
    const firstHost = await TestClient.connect(absolute.wsUrl);
    await createRoom(firstHost, absolute.clock);
    absolute.clock.advance(1_001);
    await absolute.built.service.cleanup();
    expect((await firstHost.nextType("room.ended")).reason).toBe("expired");
    expect(await absolute.built.service.roomCount()).toBe(0);

    const idle = await harness({ roomTtlMs: 10_000, roomIdleTtlMs: 1_000 });
    const secondHost = await TestClient.connect(idle.wsUrl);
    await createRoom(secondHost, idle.clock);
    idle.clock.advance(1_001);
    await idle.built.service.cleanup();
    expect((await secondHost.nextType("room.ended")).reason).toBe("idle-timeout");
    expect(await idle.built.service.roomCount()).toBe(0);
  });

  it("enforces create, join, message, connection-attempt, and active-connection limits", async () => {
    const creates = await harness({ rateLimits: { roomCreates: 1 } });
    const creatorOne = await TestClient.connect(creates.wsUrl);
    const creatorTwo = await TestClient.connect(creates.wsUrl);
    await createRoom(creatorOne, creates.clock);
    creatorTwo.send({
      ...envelope(creates.clock),
      type: "room.create",
      controlMode: "host-only",
    });
    expect((await creatorTwo.nextType("error")).code).toBe("RATE_LIMITED");

    const joins = await harness({ rateLimits: { roomJoins: 1 } });
    const joinHost = await TestClient.connect(joins.wsUrl);
    const joinOne = await TestClient.connect(joins.wsUrl);
    const joinTwo = await TestClient.connect(joins.wsUrl);
    const joinRoomCreated = await createRoom(joinHost, joins.clock);
    await joinRoom(joinOne, joins.clock, joinRoomCreated.roomCode);
    joinTwo.send({
      ...envelope(joins.clock),
      type: "room.join",
      roomCode: joinRoomCreated.roomCode,
    });
    expect((await joinTwo.nextType("error")).code).toBe("RATE_LIMITED");

    const messages = await harness({
      rateLimits: { messagesPerConnection: 1, messagesPerIp: 100 },
    });
    const noisy = await TestClient.connect(messages.wsUrl);
    const noisyRoom = await createRoom(noisy, messages.clock);
    noisy.send({
      ...envelope(messages.clock),
      ...auth(noisyRoom),
      type: "ping",
      pingId: createPingId(),
      clientSendTimeMs: messages.clock.now(),
    });
    expect((await noisy.nextType("error")).code).toBe("RATE_LIMITED");

    const attempts = await harness({ rateLimits: { connectionAttempts: 1 } });
    await TestClient.connect(attempts.wsUrl);
    await expectUpgradeRejected(attempts, 429);

    const capacity = await harness({ maxConnections: 2, maxConnectionsPerIp: 2 });
    await TestClient.connect(capacity.wsUrl);
    await TestClient.connect(capacity.wsUrl);
    await expectUpgradeRejected(capacity, 503);
  });

  it("checks exact extension/local origins and requires WSS when configured", async () => {
    const origins = await harness();
    await expectUpgradeRejected(origins, 403, "https://attacker.invalid");
    const extension = await TestClient.connect(
      origins.wsUrl,
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    );
    expect(extension.socket.readyState).toBe(1);

    const secure = await harness({ requireSecureWebSocket: true });
    await expectUpgradeRejected(secure, 426);
  });

  it("prevents session spoofing and permits only the host to end a room", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const guest = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);
    const joined = await joinRoom(guest, server.clock, created.roomCode);

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      sessionId: createSessionId(),
      type: "participant.ready",
      ready: true,
      autoplayUnlocked: true,
    });
    expect((await guest.nextType("error")).code).toBe("NOT_AUTHORIZED");

    guest.send({
      ...envelope(server.clock),
      ...auth(joined),
      type: "room.end",
    });
    expect((await guest.nextType("error")).code).toBe("NOT_AUTHORIZED");

    host.send({
      ...envelope(server.clock),
      ...auth(created),
      type: "room.end",
    });
    const hostEnded = await host.nextType("room.ended");
    const guestEnded = await guest.nextType("room.ended");
    expect(hostEnded.reason).toBe("host-ended");
    expect(guestEnded.serverSequence).toBe(hostEnded.serverSequence);
    expect(await server.built.service.roomCount()).toBe(0);
  });

  it("rejects reconnect sequences ahead of the authoritative server order", async () => {
    const server = await harness();
    const host = await TestClient.connect(server.wsUrl);
    const created = await createRoom(host, server.clock);
    host.terminate();

    const replacement = await TestClient.connect(server.wsUrl);
    replacement.send({
      ...envelope(server.clock),
      type: "room.reconnect",
      roomId: created.roomId,
      participantId: created.participantId,
      reconnectToken: created.reconnectToken,
      lastServerSequence: Number.MAX_SAFE_INTEGER,
    });
    expect((await replacement.nextType("error")).code).toBe("RECONNECT_REJECTED");
  });
});
