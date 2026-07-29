import { describe, expect, it } from "vitest";

import { expectedPosition, expectedPositionAtClientTime } from "../src/index.js";

describe("expectedPosition", () => {
  it("projects a playing timeline using elapsed synchronized time and selected rate", () => {
    expect(
      expectedPosition(
        {
          positionSec: 10,
          paused: false,
          playbackRate: 1.5,
          sampledAtServerTimeMs: 1_000,
        },
        3_000,
      ),
    ).toBe(13);
  });

  it("holds paused timelines and never rewinds for a future-dated sample", () => {
    expect(
      expectedPosition(
        {
          positionSec: 10,
          paused: true,
          playbackRate: 1,
          sampledAtServerTimeMs: 1_000,
        },
        10_000,
      ),
    ).toBe(10);
    expect(
      expectedPosition(
        {
          positionSec: 10,
          paused: false,
          playbackRate: 1,
          sampledAtServerTimeMs: 2_000,
        },
        1_000,
      ),
    ).toBe(10);
  });

  it("clamps projection to duration and seekable bounds", () => {
    const timeline = {
      positionSec: 98,
      paused: false,
      playbackRate: 2,
      sampledAtServerTimeMs: 0,
    };
    expect(expectedPosition(timeline, 5_000, { durationSec: 100 })).toBe(100);
    expect(
      expectedPosition({ ...timeline, positionSec: 2, paused: true }, 0, {
        seekableStartSec: 5,
        seekableEndSec: 90,
      }),
    ).toBe(5);
  });

  it("converts the local clock with server-minus-client offset", () => {
    expect(
      expectedPositionAtClientTime(
        {
          positionSec: 20,
          paused: false,
          playbackRate: 1,
          sampledAtServerTimeMs: 5_000,
        },
        5_800,
        200,
      ),
    ).toBe(21);
  });

  it("rejects non-finite and invalid timeline values", () => {
    expect(() =>
      expectedPosition(
        {
          positionSec: Number.NaN,
          paused: false,
          playbackRate: 1,
          sampledAtServerTimeMs: 0,
        },
        0,
      ),
    ).toThrow(RangeError);
    expect(() =>
      expectedPosition(
        { positionSec: 0, paused: false, playbackRate: 0, sampledAtServerTimeMs: 0 },
        0,
      ),
    ).toThrow(RangeError);
  });
});
