import type { PlaybackCommand } from "@watch-sync/protocol";

export type MediaEventKind = "play" | "pause" | "seeking" | "seeked" | "ratechange";

export interface MediaEventSignature {
  readonly kind: MediaEventKind;
  readonly value?: number;
  readonly tolerance?: number;
}

export interface EchoMatch {
  readonly commandId: string;
  readonly originParticipantId?: string;
}

interface ActiveSuppression {
  readonly commandId: string;
  readonly originParticipantId?: string;
  readonly expiresAtMs: number;
  readonly expectedEvents: MediaEventSignature[];
}

export interface BeginRemoteOptions {
  readonly ttlMs?: number;
  readonly originParticipantId?: string;
}

export interface EchoSuppressorOptions {
  readonly defaultTtlMs?: number;
  readonly recentCommandTtlMs?: number;
  readonly maxRecentCommands?: number;
}

function isMatch(expected: MediaEventSignature, actual: MediaEventSignature): boolean {
  if (expected.kind !== actual.kind) {
    return false;
  }
  if (expected.value === undefined) {
    return true;
  }
  if (actual.value === undefined || !Number.isFinite(actual.value)) {
    return false;
  }
  return Math.abs(expected.value - actual.value) <= (expected.tolerance ?? 0.05);
}

/**
 * Tracks every remote command independently. Media events are matched by kind/value and
 * consumed, so an unrelated local event is never hidden by a fragile global boolean.
 */
export class EchoSuppressor {
  readonly #defaultTtlMs: number;
  readonly #recentCommandTtlMs: number;
  readonly #maxRecentCommands: number;
  readonly #active = new Map<string, ActiveSuppression>();
  readonly #recentlyApplied = new Map<string, number>();

  public constructor(options: EchoSuppressorOptions = {}) {
    this.#defaultTtlMs = options.defaultTtlMs ?? 1_500;
    this.#recentCommandTtlMs = options.recentCommandTtlMs ?? 60_000;
    this.#maxRecentCommands = options.maxRecentCommands ?? 2_048;
    if (
      !Number.isFinite(this.#defaultTtlMs) ||
      this.#defaultTtlMs <= 0 ||
      !Number.isFinite(this.#recentCommandTtlMs) ||
      this.#recentCommandTtlMs <= 0 ||
      !Number.isSafeInteger(this.#maxRecentCommands) ||
      this.#maxRecentCommands < 1
    ) {
      throw new RangeError("Echo suppression limits must be positive");
    }
  }

  /**
   * Returns false for a duplicate command, allowing the caller to skip applying it again.
   */
  public beginRemote(
    commandId: string,
    expectedEvents: readonly MediaEventSignature[],
    nowMs: number,
    options: BeginRemoteOptions = {},
  ): boolean {
    this.cleanup(nowMs);
    if (commandId.length === 0 || !Number.isFinite(nowMs)) {
      throw new RangeError("commandId and nowMs must be valid");
    }
    if (this.#active.has(commandId) || this.#recentlyApplied.has(commandId)) {
      return false;
    }

    const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be positive");
    }
    for (const event of expectedEvents) {
      if (
        (event.value !== undefined && !Number.isFinite(event.value)) ||
        (event.tolerance !== undefined &&
          (!Number.isFinite(event.tolerance) || event.tolerance < 0))
      ) {
        throw new RangeError("Expected media event contains an invalid value");
      }
    }

    if (expectedEvents.length === 0) {
      this.remember(commandId, nowMs);
      return true;
    }
    this.#active.set(commandId, {
      commandId,
      originParticipantId: options.originParticipantId,
      expiresAtMs: nowMs + ttlMs,
      expectedEvents: [...expectedEvents],
    });
    return true;
  }

  public consume(event: MediaEventSignature, nowMs: number): EchoMatch | null {
    this.cleanup(nowMs);
    const active = [...this.#active.values()].reverse();
    for (const entry of active) {
      const eventIndex = entry.expectedEvents.findIndex((expected) => isMatch(expected, event));
      if (eventIndex === -1) {
        continue;
      }
      entry.expectedEvents.splice(eventIndex, 1);
      if (entry.expectedEvents.length === 0) {
        this.#active.delete(entry.commandId);
        this.remember(entry.commandId, nowMs);
      }
      return {
        commandId: entry.commandId,
        ...(entry.originParticipantId === undefined
          ? {}
          : { originParticipantId: entry.originParticipantId }),
      };
    }
    return null;
  }

  public shouldSuppress(event: MediaEventSignature, nowMs: number): boolean {
    return this.consume(event, nowMs) !== null;
  }

  public finishRemote(commandId: string, nowMs: number): void {
    this.cleanup(nowMs);
    this.#active.delete(commandId);
    this.remember(commandId, nowMs);
  }

  public hasSeen(commandId: string, nowMs: number): boolean {
    this.cleanup(nowMs);
    return this.#active.has(commandId) || this.#recentlyApplied.has(commandId);
  }

  public cleanup(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError("nowMs must be finite");
    }
    for (const [commandId, entry] of this.#active) {
      if (entry.expiresAtMs <= nowMs) {
        this.#active.delete(commandId);
        this.remember(commandId, nowMs);
      }
    }
    for (const [commandId, expiresAtMs] of this.#recentlyApplied) {
      if (expiresAtMs <= nowMs) {
        this.#recentlyApplied.delete(commandId);
      }
    }
  }

  public clear(): void {
    this.#active.clear();
    this.#recentlyApplied.clear();
  }

  private remember(commandId: string, nowMs: number): void {
    this.#recentlyApplied.set(commandId, nowMs + this.#recentCommandTtlMs);
    while (this.#recentlyApplied.size > this.#maxRecentCommands) {
      const oldest = this.#recentlyApplied.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#recentlyApplied.delete(oldest);
    }
  }
}

export function suppressionEventsForCommand(command: PlaybackCommand): MediaEventSignature[] {
  switch (command.type) {
    case "play":
      return [{ kind: "play" }];
    case "pause":
      return [{ kind: "pause" }];
    case "seek":
      return [
        { kind: "seeking", value: command.positionSec, tolerance: 0.25 },
        { kind: "seeked", value: command.positionSec, tolerance: 0.25 },
      ];
    case "rate":
      return [{ kind: "ratechange", value: command.playbackRate, tolerance: 0.01 }];
  }
}
