import { describe, expect, it } from "vitest";

import { ClockEstimator, estimateClockSample } from "../src/index.js";

describe("NTP-style clock estimation", () => {
  it("calculates offset and RTT while removing server processing time", () => {
    const sample = estimateClockSample({
      clientSendTimeMs: 1_000,
      serverReceiveTimeMs: 1_250,
      serverSendTimeMs: 1_260,
      clientReceiveTimeMs: 1_110,
    });
    expect(sample.offsetMs).toBe(200);
    expect(sample.rttMs).toBe(100);
    expect(sample.oneWayDelayMs).toBe(50);
  });

  it("reflects asymmetric network delay without producing a negative RTT", () => {
    const sample = estimateClockSample({
      clientSendTimeMs: 1_000,
      serverReceiveTimeMs: 1_240,
      serverSendTimeMs: 1_250,
      clientReceiveTimeMs: 1_110,
    });
    expect(sample.offsetMs).toBe(190);
    expect(sample.rttMs).toBe(100);

    const clamped = estimateClockSample({
      clientSendTimeMs: 0,
      serverReceiveTimeMs: 100,
      serverSendTimeMs: 200,
      clientReceiveTimeMs: 50,
    });
    expect(clamped.rttMs).toBe(0);
  });

  it("rejects impossible same-clock ordering", () => {
    expect(() =>
      estimateClockSample({
        clientSendTimeMs: 2,
        serverReceiveTimeMs: 100,
        serverSendTimeMs: 101,
        clientReceiveTimeMs: 1,
      }),
    ).toThrow("Client receive time precedes");
    expect(() =>
      estimateClockSample({
        clientSendTimeMs: 1,
        serverReceiveTimeMs: 101,
        serverSendTimeMs: 100,
        clientReceiveTimeMs: 2,
      }),
    ).toThrow("Server send time precedes");
  });
});

describe("ClockEstimator", () => {
  function exchange(offsetMs: number, rttMs: number, startMs: number) {
    const oneWay = rttMs / 2;
    return {
      clientSendTimeMs: startMs,
      serverReceiveTimeMs: startMs + offsetMs + oneWay,
      serverSendTimeMs: startMs + offsetMs + oneWay,
      clientReceiveTimeMs: startMs + rttMs,
    };
  }

  it("filters a high-RTT offset outlier and converts between clocks", () => {
    const estimator = new ClockEstimator({ fastestSampleFraction: 0.5 });
    estimator.addExchange(exchange(100, 20, 1_000));
    estimator.addExchange(exchange(102, 24, 2_000));
    estimator.addExchange(exchange(500, 400, 3_000));

    const estimate = estimator.estimate();
    expect(estimate).not.toBeNull();
    expect(estimate?.offsetMs).toBeGreaterThanOrEqual(100);
    expect(estimate?.offsetMs).toBeLessThan(102);
    expect(estimate?.minRttMs).toBe(20);
    expect(estimate?.sampleCount).toBe(3);
    expect(estimator.serverTimeAt(10_000)).toBeCloseTo(10_000 + (estimate?.offsetMs ?? 0));
    expect(estimator.clientTimeAt(10_100)).toBeCloseTo(10_100 - (estimate?.offsetMs ?? 0));
  });

  it("maintains a bounded window and can reset", () => {
    const estimator = new ClockEstimator({ maxSamples: 2, fastestSampleFraction: 1 });
    estimator.addExchange(exchange(10, 20, 0));
    estimator.addExchange(exchange(20, 20, 100));
    estimator.addExchange(exchange(30, 20, 200));
    expect(estimator.sampleCount).toBe(2);
    expect(estimator.estimate()?.offsetMs).toBeCloseTo(25);
    estimator.reset();
    expect(estimator.estimate()).toBeNull();
    expect(estimator.serverTimeAt(50)).toBe(50);
  });

  it("validates estimator configuration", () => {
    expect(() => new ClockEstimator({ maxSamples: 0 })).toThrow(RangeError);
    expect(() => new ClockEstimator({ fastestSampleFraction: 2 })).toThrow(RangeError);
  });
});
