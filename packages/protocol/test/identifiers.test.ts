import { describe, expect, it } from "vitest";

import {
  CommandIdSchema,
  IDENTIFIER_SECURITY,
  ParticipantIdSchema,
  ReconnectTokenSchema,
  RoomCodeSchema,
  createCommandId,
  createParticipantId,
  createReconnectToken,
  createRoomCode,
  normalizeRoomCode,
} from "../src/index.js";

const filledRandom =
  (value: number) =>
  (buffer: Uint8Array): Uint8Array => {
    buffer.fill(value);
    return buffer;
  };

describe("safe protocol identifiers", () => {
  it("generates deterministic, schema-valid identifiers from an injected random source", () => {
    expect(createRoomCode(filledRandom(0))).toBe("2222222222222222");
    expect(createParticipantId(filledRandom(1))).toBe("participant_33333333333333333333333333");
    expect(createCommandId(filledRandom(2))).toBe("command_44444444444444444444444444");
    expect(createReconnectToken(filledRandom(3))).toBe(`reconnect_${"5".repeat(52)}`);
  });

  it("normalizes human formatting without admitting ambiguous characters", () => {
    expect(normalizeRoomCode("2345-6789 abcd-efgh")).toBe("23456789ABCDEFGH");
    expect(() => normalizeRoomCode("OOOO-OOOO-OOOO-OOOO")).toThrow();
    expect(RoomCodeSchema.safeParse("short").success).toBe(false);
  });

  it("rejects unsafe, malformed, or wrong-kind identifiers", () => {
    expect(ParticipantIdSchema.safeParse("../participant_secret").success).toBe(false);
    expect(CommandIdSchema.safeParse("participant_22222222222222222222222222").success).toBe(false);
    expect(ReconnectTokenSchema.safeParse("reconnect_token").success).toBe(false);
  });

  it("documents adequate entropy for short-lived private rooms and opaque tokens", () => {
    expect(IDENTIFIER_SECURITY.roomCodeEntropyBits).toBe(80);
    expect(IDENTIFIER_SECURITY.entityIdEntropyBits).toBe(130);
    expect(IDENTIFIER_SECURITY.reconnectTokenEntropyBits).toBe(260);
  });

  it("rejects a broken random source", () => {
    expect(() => createRoomCode(() => new Uint8Array(1))).toThrow("unexpected number of bytes");
  });
});
