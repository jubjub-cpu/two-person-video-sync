export interface DriftConfig {
  /** Ignore drift at or below this threshold. */
  readonly deadbandSec: number;
  /** Enter rate correction at or above this threshold. */
  readonly rateCorrectionEnterSec: number;
  /** Exit rate correction at or below this lower threshold (hysteresis). */
  readonly rateCorrectionExitSec: number;
  /** Seek once drift reaches this threshold. */
  readonly seekThresholdSec: number;
  readonly minimumRateAdjustmentRatio: number;
  readonly maximumRateAdjustmentRatio: number;
  readonly rateGainPerSecond: number;
  readonly seekCooldownMs: number;
  readonly settlingWindowMs: number;
  readonly decisionCooldownMs: number;
  readonly maximumRateCorrectionMs: number;
  readonly playbackRateTolerance: number;
}

/**
 * Defaults target imperceptible behavior: <=100ms is ignored, 250ms starts a subtle
 * rate nudge capped at 5%, and >=1.25s is corrected with one seek.
 */
export const DEFAULT_DRIFT_CONFIG: Readonly<DriftConfig> = Object.freeze({
  deadbandSec: 0.1,
  rateCorrectionEnterSec: 0.25,
  rateCorrectionExitSec: 0.1,
  seekThresholdSec: 1.25,
  minimumRateAdjustmentRatio: 0.01,
  maximumRateAdjustmentRatio: 0.05,
  rateGainPerSecond: 0.08,
  seekCooldownMs: 5_000,
  settlingWindowMs: 1_200,
  decisionCooldownMs: 250,
  maximumRateCorrectionMs: 8_000,
  playbackRateTolerance: 0.002,
});

export interface DriftObservation {
  readonly nowMs: number;
  readonly expectedPositionSec: number;
  readonly actualPositionSec: number;
  /** User-selected/authoritative rate, never the temporary correction rate. */
  readonly selectedPlaybackRate: number;
  readonly actualPlaybackRate: number;
  readonly paused: boolean;
  readonly canSeek?: boolean;
  readonly synchronizationAllowed?: boolean;
  readonly isBuffering?: boolean;
  readonly isAdvertisement?: boolean;
}

export type DriftNoopReason =
  | "within-deadband"
  | "below-rate-threshold"
  | "rate-correction-active"
  | "settling"
  | "seek-cooldown"
  | "decision-cooldown"
  | "paused"
  | "unseekable"
  | "suspended";

export type DriftDecision =
  | {
      readonly type: "none";
      readonly driftSec: number;
      readonly reason: DriftNoopReason;
    }
  | {
      readonly type: "adjust-rate";
      readonly driftSec: number;
      readonly playbackRate: number;
      readonly reason: "moderate-drift" | "seek-cooldown";
    }
  | {
      readonly type: "seek";
      readonly driftSec: number;
      readonly positionSec: number;
      readonly playbackRate: number;
      readonly reason: "large-drift";
    }
  | {
      readonly type: "restore-rate";
      readonly driftSec: number;
      readonly playbackRate: number;
      readonly reason:
        "drift-settled" | "direction-changed" | "correction-timeout" | "paused" | "suspended";
    };

interface RateCorrectionState {
  readonly direction: -1 | 1;
  readonly startedAtMs: number;
  targetRate: number;
}

function finiteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and nonnegative`);
  }
}

function validateConfig(config: DriftConfig): void {
  const numericValues = Object.values(config);
  if (numericValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Drift configuration values must be finite and nonnegative");
  }
  if (
    config.rateCorrectionExitSec > config.deadbandSec ||
    config.deadbandSec >= config.rateCorrectionEnterSec ||
    config.rateCorrectionEnterSec >= config.seekThresholdSec
  ) {
    throw new RangeError("Thresholds must satisfy exit <= deadband < rate-enter < seek-threshold");
  }
  if (
    config.minimumRateAdjustmentRatio > config.maximumRateAdjustmentRatio ||
    config.maximumRateAdjustmentRatio > 0.25
  ) {
    throw new RangeError("Rate adjustment ratios are inconsistent or unsafe");
  }
}

function directionOf(value: number): -1 | 0 | 1 {
  return value === 0 ? 0 : value > 0 ? 1 : -1;
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export class DriftController {
  readonly #config: DriftConfig;
  #rateCorrection: RateCorrectionState | null = null;
  #lastSeekAtMs = Number.NEGATIVE_INFINITY;
  #settlingUntilMs = Number.NEGATIVE_INFINITY;
  #lastDecisionAtMs = Number.NEGATIVE_INFINITY;

  public constructor(config: Partial<DriftConfig> = {}) {
    this.#config = { ...DEFAULT_DRIFT_CONFIG, ...config };
    validateConfig(this.#config);
  }

  public decide(observation: DriftObservation): DriftDecision {
    this.validateObservation(observation);
    const driftSec = observation.expectedPositionSec - observation.actualPositionSec;
    const absoluteDriftSec = Math.abs(driftSec);
    const allowed =
      (observation.synchronizationAllowed ?? true) &&
      !(observation.isBuffering ?? false) &&
      !(observation.isAdvertisement ?? false);

    if (!allowed) {
      return this.stopRateCorrection(observation, driftSec, "suspended", "suspended");
    }

    if (this.#rateCorrection !== null) {
      const direction = directionOf(driftSec);
      const correctionAgeMs = observation.nowMs - this.#rateCorrection.startedAtMs;
      if (observation.paused) {
        return this.stopRateCorrection(observation, driftSec, "paused", "paused");
      }
      if (direction !== 0 && direction !== this.#rateCorrection.direction) {
        return this.stopRateCorrection(observation, driftSec, "direction-changed", "settling");
      }
      if (absoluteDriftSec <= this.#config.rateCorrectionExitSec) {
        return this.stopRateCorrection(observation, driftSec, "drift-settled", "within-deadband");
      }
      if (correctionAgeMs >= this.#config.maximumRateCorrectionMs) {
        return this.stopRateCorrection(observation, driftSec, "correction-timeout", "settling");
      }
      if (
        absoluteDriftSec >= this.#config.seekThresholdSec &&
        (observation.canSeek ?? true) &&
        observation.nowMs - this.#lastSeekAtMs >= this.#config.seekCooldownMs
      ) {
        return this.makeSeek(observation, driftSec);
      }

      const targetRate = this.correctionRate(
        observation.selectedPlaybackRate,
        absoluteDriftSec,
        this.#rateCorrection.direction,
      );
      this.#rateCorrection.targetRate = targetRate;
      if (observation.nowMs - this.#lastDecisionAtMs < this.#config.decisionCooldownMs) {
        return { type: "none", driftSec, reason: "decision-cooldown" };
      }
      if (
        Math.abs(observation.actualPlaybackRate - targetRate) <= this.#config.playbackRateTolerance
      ) {
        return { type: "none", driftSec, reason: "rate-correction-active" };
      }
      this.#lastDecisionAtMs = observation.nowMs;
      return {
        type: "adjust-rate",
        driftSec,
        playbackRate: targetRate,
        reason:
          absoluteDriftSec >= this.#config.seekThresholdSec ? "seek-cooldown" : "moderate-drift",
      };
    }

    if (observation.nowMs < this.#settlingUntilMs) {
      return { type: "none", driftSec, reason: "settling" };
    }

    if (absoluteDriftSec >= this.#config.seekThresholdSec) {
      if (observation.canSeek ?? true) {
        if (observation.nowMs - this.#lastSeekAtMs >= this.#config.seekCooldownMs) {
          return this.makeSeek(observation, driftSec);
        }
        if (!observation.paused) {
          return this.startRateCorrection(observation, driftSec, "seek-cooldown");
        }
        return { type: "none", driftSec, reason: "seek-cooldown" };
      }
      if (!observation.paused) {
        return this.startRateCorrection(observation, driftSec, "seek-cooldown");
      }
      return { type: "none", driftSec, reason: "unseekable" };
    }

    if (observation.paused) {
      return {
        type: "none",
        driftSec,
        reason: absoluteDriftSec <= this.#config.deadbandSec ? "within-deadband" : "paused",
      };
    }
    if (absoluteDriftSec < this.#config.rateCorrectionEnterSec) {
      return {
        type: "none",
        driftSec,
        reason:
          absoluteDriftSec <= this.#config.deadbandSec ? "within-deadband" : "below-rate-threshold",
      };
    }
    return this.startRateCorrection(observation, driftSec, "moderate-drift");
  }

  public reset(): void {
    this.#rateCorrection = null;
    this.#lastSeekAtMs = Number.NEGATIVE_INFINITY;
    this.#settlingUntilMs = Number.NEGATIVE_INFINITY;
    this.#lastDecisionAtMs = Number.NEGATIVE_INFINITY;
  }

  public get isRateCorrecting(): boolean {
    return this.#rateCorrection !== null;
  }

  public get config(): Readonly<DriftConfig> {
    return this.#config;
  }

  private startRateCorrection(
    observation: DriftObservation,
    driftSec: number,
    reason: "moderate-drift" | "seek-cooldown",
  ): DriftDecision {
    const direction = directionOf(driftSec);
    if (direction === 0) {
      return { type: "none", driftSec, reason: "within-deadband" };
    }
    const targetRate = this.correctionRate(
      observation.selectedPlaybackRate,
      Math.abs(driftSec),
      direction,
    );
    this.#rateCorrection = {
      direction,
      startedAtMs: observation.nowMs,
      targetRate,
    };
    this.#lastDecisionAtMs = observation.nowMs;
    return {
      type: "adjust-rate",
      driftSec,
      playbackRate: targetRate,
      reason,
    };
  }

  private stopRateCorrection(
    observation: DriftObservation,
    driftSec: number,
    restoreReason: Extract<DriftDecision, { type: "restore-rate" }>["reason"],
    noActionReason: DriftNoopReason,
  ): DriftDecision {
    const wasCorrecting = this.#rateCorrection !== null;
    this.#rateCorrection = null;
    if (wasCorrecting) {
      this.#settlingUntilMs = observation.nowMs + this.#config.settlingWindowMs;
    }
    if (
      wasCorrecting &&
      Math.abs(observation.actualPlaybackRate - observation.selectedPlaybackRate) >
        this.#config.playbackRateTolerance
    ) {
      this.#lastDecisionAtMs = observation.nowMs;
      return {
        type: "restore-rate",
        driftSec,
        playbackRate: observation.selectedPlaybackRate,
        reason: restoreReason,
      };
    }
    return { type: "none", driftSec, reason: noActionReason };
  }

  private makeSeek(observation: DriftObservation, driftSec: number): DriftDecision {
    this.#rateCorrection = null;
    this.#lastSeekAtMs = observation.nowMs;
    this.#lastDecisionAtMs = observation.nowMs;
    this.#settlingUntilMs = observation.nowMs + this.#config.settlingWindowMs;
    return {
      type: "seek",
      driftSec,
      positionSec: observation.expectedPositionSec,
      playbackRate: observation.selectedPlaybackRate,
      reason: "large-drift",
    };
  }

  private correctionRate(
    selectedPlaybackRate: number,
    absoluteDriftSec: number,
    direction: -1 | 1,
  ): number {
    const ratio = Math.min(
      this.#config.maximumRateAdjustmentRatio,
      Math.max(
        this.#config.minimumRateAdjustmentRatio,
        absoluteDriftSec * this.#config.rateGainPerSecond,
      ),
    );
    return roundRate(Math.min(4, Math.max(0.25, selectedPlaybackRate * (1 + direction * ratio))));
  }

  private validateObservation(observation: DriftObservation): void {
    finiteNonnegative(observation.nowMs, "nowMs");
    finiteNonnegative(observation.expectedPositionSec, "expectedPositionSec");
    finiteNonnegative(observation.actualPositionSec, "actualPositionSec");
    finiteNonnegative(observation.selectedPlaybackRate, "selectedPlaybackRate");
    finiteNonnegative(observation.actualPlaybackRate, "actualPlaybackRate");
    if (
      observation.selectedPlaybackRate < 0.25 ||
      observation.selectedPlaybackRate > 4 ||
      observation.actualPlaybackRate < 0.25 ||
      observation.actualPlaybackRate > 4
    ) {
      throw new RangeError("Playback rates must be in [0.25, 4]");
    }
  }
}
