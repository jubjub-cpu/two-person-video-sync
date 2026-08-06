import { describe, expect, it } from "vitest";

import { RuntimeEventSchema, RuntimeRequestSchema } from "../lib/runtime-schema";

describe("extension runtime message schemas", () => {
  it("accepts a valid popup request", () => {
    expect(
      RuntimeRequestSchema.parse({
        type: "popup/create-room",
        requestId: "request-1",
        tabId: 42,
        controlMode: "host-only",
      }),
    ).toMatchObject({ type: "popup/create-room", tabId: 42 });
  });

  it("rejects unknown request properties and invalid tab identifiers", () => {
    expect(() =>
      RuntimeRequestSchema.parse({
        type: "popup/get-state",
        requestId: "request-1",
        tabId: -1,
        injected: true,
      }),
    ).toThrow();
  });

  it("rejects malformed nested media state", () => {
    expect(() =>
      RuntimeRequestSchema.parse({
        type: "content/action",
        requestId: "request-1",
        action: { kind: "seek", positionSeconds: Number.NaN, playbackRate: 1 },
      }),
    ).toThrow();
  });

  it("accepts bounded in-page reconnect, host-transfer, and leave actions", () => {
    expect(
      RuntimeRequestSchema.parse({
        type: "content/reconnect",
        requestId: "request-2",
      }),
    ).toMatchObject({ type: "content/reconnect" });
    expect(
      RuntimeRequestSchema.parse({
        type: "content/transfer-host",
        requestId: "request-transfer",
        targetParticipantId: "participant-guest-1",
      }),
    ).toMatchObject({ type: "content/transfer-host" });
    expect(
      RuntimeRequestSchema.parse({
        type: "content/leave-room",
        requestId: "request-3",
        endRoom: true,
      }),
    ).toMatchObject({ type: "content/leave-room", endRoom: true });
  });

  it("accepts a bounded background status event", () => {
    expect(
      RuntimeEventSchema.parse({
        type: "background/status",
        status: "connected",
        message: "Connected",
      }),
    ).toMatchObject({ status: "connected" });
  });

  it("rejects unrecognized background events", () => {
    expect(() =>
      RuntimeEventSchema.parse({ type: "background/eval", source: "alert(1)" }),
    ).toThrow();
  });
});
