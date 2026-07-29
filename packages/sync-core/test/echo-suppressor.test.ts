import { describe, expect, it } from "vitest";

import { EchoSuppressor, suppressionEventsForCommand } from "../src/index.js";

describe("EchoSuppressor", () => {
  it("suppresses only expected resulting media events, then rejects duplicate application", () => {
    const suppressor = new EchoSuppressor();
    expect(
      suppressor.beginRemote("command-1", [{ kind: "play" }], 0, {
        originParticipantId: "peer",
      }),
    ).toBe(true);
    expect(suppressor.shouldSuppress({ kind: "pause" }, 10)).toBe(false);
    expect(suppressor.consume({ kind: "play" }, 20)).toEqual({
      commandId: "command-1",
      originParticipantId: "peer",
    });
    expect(suppressor.shouldSuppress({ kind: "play" }, 30)).toBe(false);
    expect(suppressor.beginRemote("command-1", [{ kind: "play" }], 40)).toBe(false);
  });

  it("matches seek/rate values with tolerances without hiding a local action", () => {
    const suppressor = new EchoSuppressor();
    suppressor.beginRemote("seek", [{ kind: "seeked", value: 20, tolerance: 0.2 }], 0);
    expect(suppressor.shouldSuppress({ kind: "seeked", value: 25 }, 5)).toBe(false);
    expect(suppressor.shouldSuppress({ kind: "seeked", value: 20.1 }, 6)).toBe(true);
  });

  it("tracks overlapping commands independently and attributes the newest matching event", () => {
    const suppressor = new EchoSuppressor();
    suppressor.beginRemote("old", [{ kind: "pause" }], 0, {
      originParticipantId: "a",
    });
    suppressor.beginRemote("new", [{ kind: "pause" }], 1, {
      originParticipantId: "b",
    });
    expect(suppressor.consume({ kind: "pause" }, 2)).toEqual({
      commandId: "new",
      originParticipantId: "b",
    });
    expect(suppressor.consume({ kind: "pause" }, 3)).toEqual({
      commandId: "old",
      originParticipantId: "a",
    });
  });

  it("expires guards, retains recent command idempotency, and eventually forgets", () => {
    const suppressor = new EchoSuppressor({
      defaultTtlMs: 100,
      recentCommandTtlMs: 1_000,
    });
    suppressor.beginRemote("expired", [{ kind: "play" }], 0);
    expect(suppressor.shouldSuppress({ kind: "play" }, 101)).toBe(false);
    expect(suppressor.hasSeen("expired", 500)).toBe(true);
    expect(suppressor.beginRemote("expired", [], 500)).toBe(false);
    expect(suppressor.hasSeen("expired", 1_102)).toBe(false);
  });

  it("maps each remote command into the resulting media event guard", () => {
    expect(suppressionEventsForCommand({ type: "play", positionSec: 1, playbackRate: 1 })).toEqual([
      { kind: "play" },
    ]);
    expect(suppressionEventsForCommand({ type: "pause", positionSec: 1 })).toEqual([
      { kind: "pause" },
    ]);
    expect(
      suppressionEventsForCommand({
        type: "seek",
        positionSec: 30,
        paused: false,
        playbackRate: 1,
      }),
    ).toEqual([
      { kind: "seeking", value: 30, tolerance: 0.25 },
      { kind: "seeked", value: 30, tolerance: 0.25 },
    ]);
    expect(
      suppressionEventsForCommand({
        type: "rate",
        positionSec: 30,
        paused: false,
        playbackRate: 1.5,
      }),
    ).toEqual([{ kind: "ratechange", value: 1.5, tolerance: 0.01 }]);
  });
});
