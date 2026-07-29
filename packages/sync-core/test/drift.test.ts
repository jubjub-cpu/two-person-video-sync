import { describe, expect, it } from "vitest";

import { DEFAULT_DRIFT_CONFIG, DriftController, type DriftObservation } from "../src/index.js";

function observation(overrides: Partial<DriftObservation> = {}): DriftObservation {
  return {
    nowMs: 0,
    expectedPositionSec: 10,
    actualPositionSec: 10,
    selectedPlaybackRate: 1,
    actualPlaybackRate: 1,
    paused: false,
    canSeek: true,
    synchronizationAllowed: true,
    isBuffering: false,
    isAdvertisement: false,
    ...overrides,
  };
}

describe("DriftController thresholds", () => {
  it("does nothing for very small drift and waits below the correction threshold", () => {
    const controller = new DriftController();
    expect(controller.decide(observation({ expectedPositionSec: 10.05 }))).toMatchObject({
      type: "none",
      reason: "within-deadband",
    });
    expect(controller.decide(observation({ expectedPositionSec: 10.15 }))).toMatchObject({
      type: "none",
      reason: "below-rate-threshold",
    });
  });

  it("nudges faster when behind and slower when ahead within a subtle cap", () => {
    const behind = new DriftController();
    expect(behind.decide(observation({ expectedPositionSec: 10.3 }))).toMatchObject({
      type: "adjust-rate",
      playbackRate: 1.024,
      reason: "moderate-drift",
    });

    const ahead = new DriftController();
    expect(ahead.decide(observation({ actualPositionSec: 10.5 }))).toMatchObject({
      type: "adjust-rate",
      playbackRate: 0.96,
    });

    const capped = new DriftController();
    expect(capped.decide(observation({ expectedPositionSec: 11 }))).toMatchObject({
      type: "adjust-rate",
      playbackRate: 1.05,
    });
  });

  it("restores the selected rate after the drift exits through hysteresis", () => {
    const controller = new DriftController();
    const correction = controller.decide(observation({ expectedPositionSec: 10.3 }));
    expect(correction.type).toBe("adjust-rate");
    const correctedRate = correction.type === "adjust-rate" ? correction.playbackRate : Number.NaN;
    expect(
      controller.decide(
        observation({
          nowMs: 300,
          expectedPositionSec: 10.09,
          actualPlaybackRate: correctedRate,
        }),
      ),
    ).toEqual({
      type: "restore-rate",
      driftSec: 0.08999999999999986,
      playbackRate: 1,
      reason: "drift-settled",
    });
    expect(controller.isRateCorrecting).toBe(false);
  });

  it("keeps correcting between the enter and lower exit thresholds", () => {
    const controller = new DriftController();
    const initial = controller.decide(observation({ expectedPositionSec: 10.3 }));
    const initialRate = initial.type === "adjust-rate" ? initial.playbackRate : 1;
    const between = controller.decide(
      observation({
        nowMs: 300,
        expectedPositionSec: 10.15,
        actualPlaybackRate: initialRate,
      }),
    );
    expect(between.type).not.toBe("restore-rate");
    expect(controller.isRateCorrecting).toBe(true);
  });

  it("waits between repeated rate instructions", () => {
    const controller = new DriftController();
    controller.decide(observation({ expectedPositionSec: 10.5 }));
    expect(controller.decide(observation({ nowMs: 100, expectedPositionSec: 10.5 }))).toMatchObject(
      { type: "none", reason: "decision-cooldown" },
    );
    expect(controller.decide(observation({ nowMs: 300, expectedPositionSec: 10.5 }))).toMatchObject(
      { type: "adjust-rate" },
    );
  });
});

describe("DriftController hard corrections and anti-oscillation", () => {
  it("performs one corrective seek for large drift and restores selected rate", () => {
    const controller = new DriftController();
    expect(
      controller.decide(
        observation({
          expectedPositionSec: 20,
          actualPositionSec: 17,
          selectedPlaybackRate: 1.25,
          actualPlaybackRate: 1.25,
        }),
      ),
    ).toEqual({
      type: "seek",
      driftSec: 3,
      positionSec: 20,
      playbackRate: 1.25,
      reason: "large-drift",
    });
  });

  it("uses a settling window and seek cooldown instead of repeatedly jumping", () => {
    const controller = new DriftController();
    controller.decide(observation({ expectedPositionSec: 12 }));
    expect(controller.decide(observation({ nowMs: 1_000, expectedPositionSec: 12 }))).toMatchObject(
      { type: "none", reason: "settling" },
    );
    expect(controller.decide(observation({ nowMs: 1_500, expectedPositionSec: 12 }))).toMatchObject(
      { type: "adjust-rate", reason: "seek-cooldown" },
    );
    expect(
      controller.decide(
        observation({
          nowMs: 5_100,
          expectedPositionSec: 12,
          actualPlaybackRate: 1.05,
        }),
      ),
    ).toMatchObject({ type: "seek", reason: "large-drift" });
  });

  it("rate-corrects an unseekable playing source but will not seek a paused source", () => {
    const playing = new DriftController();
    expect(playing.decide(observation({ expectedPositionSec: 12, canSeek: false }))).toMatchObject({
      type: "adjust-rate",
      reason: "seek-cooldown",
    });

    const paused = new DriftController();
    expect(
      paused.decide(observation({ expectedPositionSec: 12, canSeek: false, paused: true })),
    ).toMatchObject({ type: "none", reason: "unseekable" });
  });

  it("restores rather than immediately reversing a rate correction", () => {
    const controller = new DriftController();
    const correction = controller.decide(observation({ expectedPositionSec: 10.5 }));
    const correctedRate = correction.type === "adjust-rate" ? correction.playbackRate : 1;
    expect(
      controller.decide(
        observation({
          nowMs: 300,
          expectedPositionSec: 9.7,
          actualPlaybackRate: correctedRate,
        }),
      ),
    ).toMatchObject({ type: "restore-rate", reason: "direction-changed" });
    expect(controller.decide(observation({ nowMs: 500, expectedPositionSec: 9.7 }))).toMatchObject({
      type: "none",
      reason: "settling",
    });
  });

  it("bounds correction duration and restores the user's selected rate", () => {
    const controller = new DriftController({ maximumRateCorrectionMs: 500 });
    const correction = controller.decide(observation({ expectedPositionSec: 10.5 }));
    const correctedRate = correction.type === "adjust-rate" ? correction.playbackRate : 1;
    expect(
      controller.decide(
        observation({
          nowMs: 501,
          expectedPositionSec: 10.4,
          actualPlaybackRate: correctedRate,
        }),
      ),
    ).toMatchObject({ type: "restore-rate", reason: "correction-timeout" });
  });
});

describe("DriftController barriers and configuration", () => {
  it.each([{ isBuffering: true }, { isAdvertisement: true }, { synchronizationAllowed: false }])(
    "suspends drift correction at a safety barrier: %o",
    (barrier) => {
      const controller = new DriftController();
      const correction = controller.decide(observation({ expectedPositionSec: 10.5 }));
      const correctedRate = correction.type === "adjust-rate" ? correction.playbackRate : 1;
      expect(
        controller.decide(
          observation({
            nowMs: 300,
            expectedPositionSec: 10.5,
            actualPlaybackRate: correctedRate,
            ...barrier,
          }),
        ),
      ).toMatchObject({ type: "restore-rate", reason: "suspended" });
    },
  );

  it("keeps correction rates inside media-safe bounds", () => {
    const fast = new DriftController();
    expect(
      fast.decide(
        observation({
          expectedPositionSec: 11,
          selectedPlaybackRate: 4,
          actualPlaybackRate: 4,
        }),
      ),
    ).toMatchObject({ type: "adjust-rate", playbackRate: 4 });

    const slow = new DriftController();
    expect(
      slow.decide(
        observation({
          actualPositionSec: 11,
          selectedPlaybackRate: 0.25,
          actualPlaybackRate: 0.25,
        }),
      ),
    ).toMatchObject({ type: "adjust-rate", playbackRate: 0.25 });
  });

  it("publishes justified defaults and rejects oscillation-prone threshold order", () => {
    expect(DEFAULT_DRIFT_CONFIG).toMatchObject({
      deadbandSec: 0.1,
      rateCorrectionEnterSec: 0.25,
      rateCorrectionExitSec: 0.1,
      seekThresholdSec: 1.25,
      maximumRateAdjustmentRatio: 0.05,
      seekCooldownMs: 5_000,
      settlingWindowMs: 1_200,
    });
    expect(
      () =>
        new DriftController({
          rateCorrectionExitSec: 0.3,
          deadbandSec: 0.1,
        }),
    ).toThrow(RangeError);
  });
});
