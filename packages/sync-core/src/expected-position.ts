export interface AuthoritativeTimeline {
  readonly positionSec: number;
  readonly paused: boolean;
  readonly playbackRate: number;
  readonly sampledAtServerTimeMs: number;
}

export interface ExpectedPositionOptions {
  readonly durationSec?: number;
  readonly seekableStartSec?: number;
  readonly seekableEndSec?: number;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

/**
 * Projects an authoritative playback sample onto the synchronized server clock.
 * Future-dated samples never rewind the timeline; bounds are applied after projection.
 */
export function expectedPosition(
  timeline: AuthoritativeTimeline,
  serverNowMs: number,
  options: ExpectedPositionOptions = {},
): number {
  requireFinite(timeline.positionSec, "positionSec");
  requireFinite(timeline.playbackRate, "playbackRate");
  requireFinite(timeline.sampledAtServerTimeMs, "sampledAtServerTimeMs");
  requireFinite(serverNowMs, "serverNowMs");
  if (timeline.positionSec < 0 || timeline.playbackRate <= 0) {
    throw new RangeError("Timeline position and playback rate are outside valid bounds");
  }

  const elapsedSec = Math.max(0, serverNowMs - timeline.sampledAtServerTimeMs) / 1_000;
  const projected = timeline.paused
    ? timeline.positionSec
    : timeline.positionSec + elapsedSec * timeline.playbackRate;

  let minimum = options.seekableStartSec ?? 0;
  let maximum = options.seekableEndSec ?? options.durationSec ?? Number.POSITIVE_INFINITY;
  requireFinite(minimum, "seekableStartSec");
  if (maximum !== Number.POSITIVE_INFINITY) {
    requireFinite(maximum, "timeline upper bound");
  }
  minimum = Math.max(0, minimum);
  maximum = Math.max(minimum, maximum);
  return Math.min(maximum, Math.max(minimum, projected));
}

export function expectedPositionAtClientTime(
  timeline: AuthoritativeTimeline,
  clientNowMs: number,
  serverMinusClientOffsetMs: number,
  options: ExpectedPositionOptions = {},
): number {
  requireFinite(clientNowMs, "clientNowMs");
  requireFinite(serverMinusClientOffsetMs, "serverMinusClientOffsetMs");
  return expectedPosition(timeline, clientNowMs + serverMinusClientOffsetMs, options);
}
