export interface ClockExchange {
  /** Client clock immediately before sending ping. */
  readonly clientSendTimeMs: number;
  /** Server clock when ping was received. */
  readonly serverReceiveTimeMs: number;
  /** Server clock immediately before sending pong. */
  readonly serverSendTimeMs: number;
  /** Client clock when pong was received. */
  readonly clientReceiveTimeMs: number;
}

export interface ClockSample extends ClockExchange {
  /** Server time minus client time. Add this value to a client timestamp. */
  readonly offsetMs: number;
  /** Network round-trip time with known server processing time removed. */
  readonly rttMs: number;
  readonly oneWayDelayMs: number;
  readonly observedAtClientTimeMs: number;
}

export interface ClockEstimate {
  readonly offsetMs: number;
  readonly rttMs: number;
  readonly minRttMs: number;
  readonly jitterMs: number;
  readonly sampleCount: number;
}

function requireTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

/**
 * NTP four-timestamp calculation. Offset is expressed as server minus client time.
 */
export function estimateClockSample(exchange: ClockExchange): ClockSample {
  requireTimestamp(exchange.clientSendTimeMs, "clientSendTimeMs");
  requireTimestamp(exchange.serverReceiveTimeMs, "serverReceiveTimeMs");
  requireTimestamp(exchange.serverSendTimeMs, "serverSendTimeMs");
  requireTimestamp(exchange.clientReceiveTimeMs, "clientReceiveTimeMs");

  if (exchange.clientReceiveTimeMs < exchange.clientSendTimeMs) {
    throw new RangeError("Client receive time precedes client send time");
  }
  if (exchange.serverSendTimeMs < exchange.serverReceiveTimeMs) {
    throw new RangeError("Server send time precedes server receive time");
  }

  const rawRtt =
    exchange.clientReceiveTimeMs -
    exchange.clientSendTimeMs -
    (exchange.serverSendTimeMs - exchange.serverReceiveTimeMs);
  const rttMs = Math.max(0, rawRtt);
  const offsetMs =
    (exchange.serverReceiveTimeMs -
      exchange.clientSendTimeMs +
      (exchange.serverSendTimeMs - exchange.clientReceiveTimeMs)) /
    2;

  return {
    ...exchange,
    offsetMs,
    rttMs,
    oneWayDelayMs: rttMs / 2,
    observedAtClientTimeMs: exchange.clientReceiveTimeMs,
  };
}

export interface ClockEstimatorOptions {
  readonly maxSamples?: number;
  readonly fastestSampleFraction?: number;
}

/**
 * Keeps a bounded sample window and estimates from the lowest-latency half. This prevents
 * transient queueing delay from dominating the clock while retaining more stability than a
 * single "best" sample.
 */
export class ClockEstimator {
  readonly #maxSamples: number;
  readonly #fastestSampleFraction: number;
  readonly #samples: ClockSample[] = [];

  public constructor(options: ClockEstimatorOptions = {}) {
    this.#maxSamples = options.maxSamples ?? 12;
    this.#fastestSampleFraction = options.fastestSampleFraction ?? 0.5;
    if (!Number.isSafeInteger(this.#maxSamples) || this.#maxSamples < 1) {
      throw new RangeError("maxSamples must be a positive safe integer");
    }
    if (
      !Number.isFinite(this.#fastestSampleFraction) ||
      this.#fastestSampleFraction <= 0 ||
      this.#fastestSampleFraction > 1
    ) {
      throw new RangeError("fastestSampleFraction must be in (0, 1]");
    }
  }

  public addExchange(exchange: ClockExchange): ClockSample {
    const sample = estimateClockSample(exchange);
    this.addSample(sample);
    return sample;
  }

  public addSample(sample: ClockSample): void {
    // Recalculate to ensure callers cannot inject an internally inconsistent sample.
    const checked = estimateClockSample(sample);
    this.#samples.push(checked);
    while (this.#samples.length > this.#maxSamples) {
      this.#samples.shift();
    }
  }

  public estimate(): ClockEstimate | null {
    if (this.#samples.length === 0) {
      return null;
    }

    const sorted = [...this.#samples].sort(
      (left, right) =>
        left.rttMs - right.rttMs || left.observedAtClientTimeMs - right.observedAtClientTimeMs,
    );
    const retainedCount = Math.max(1, Math.ceil(sorted.length * this.#fastestSampleFraction));
    const retained = sorted.slice(0, retainedCount);
    let totalWeight = 0;
    let weightedOffset = 0;
    let weightedRtt = 0;
    for (const sample of retained) {
      const weight = 1 / Math.max(1, sample.rttMs);
      totalWeight += weight;
      weightedOffset += sample.offsetMs * weight;
      weightedRtt += sample.rttMs * weight;
    }
    const offsetMs = weightedOffset / totalWeight;
    const rttMs = weightedRtt / totalWeight;
    let weightedVariance = 0;
    for (const sample of retained) {
      const weight = 1 / Math.max(1, sample.rttMs);
      weightedVariance += weight * (sample.offsetMs - offsetMs) ** 2;
    }

    return {
      offsetMs,
      rttMs,
      minRttMs: retained[0]?.rttMs ?? rttMs,
      jitterMs: Math.sqrt(weightedVariance / totalWeight),
      sampleCount: this.#samples.length,
    };
  }

  public serverTimeAt(clientTimeMs: number): number {
    requireTimestamp(clientTimeMs, "clientTimeMs");
    return clientTimeMs + (this.estimate()?.offsetMs ?? 0);
  }

  public clientTimeAt(serverTimeMs: number): number {
    requireTimestamp(serverTimeMs, "serverTimeMs");
    return serverTimeMs - (this.estimate()?.offsetMs ?? 0);
  }

  public get sampleCount(): number {
    return this.#samples.length;
  }

  public reset(): void {
    this.#samples.length = 0;
  }
}
