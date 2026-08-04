import type { CommandId, ParticipantId } from "@vyzync/protocol";

export interface CommandCandidate<Command> {
  readonly commandId: CommandId;
  readonly participantId: ParticipantId;
  readonly clientSequence: number;
  readonly receivedAtServerTimeMs: number;
  readonly command: Command;
}

/**
 * Near-simultaneous shared-control actions are ordered by server receipt time, then stable
 * participant ID, client sequence, and command ID. The explicit tie-breakers make tests,
 * replay, and batched processing deterministic.
 */
export function compareCommandCandidates<Command>(
  left: CommandCandidate<Command>,
  right: CommandCandidate<Command>,
): number {
  return (
    left.receivedAtServerTimeMs - right.receivedAtServerTimeMs ||
    left.participantId.localeCompare(right.participantId) ||
    left.clientSequence - right.clientSequence ||
    left.commandId.localeCompare(right.commandId)
  );
}

export function orderCommandCandidates<Command>(
  candidates: readonly CommandCandidate<Command>[],
): CommandCandidate<Command>[] {
  return [...candidates].sort(compareCommandCandidates);
}

export interface OrderedCommand<Command> extends CommandCandidate<Command> {
  readonly serverSequence: number;
}

export type CommandAcceptance<Command> =
  | {
      readonly status: "accepted";
      readonly ordered: OrderedCommand<Command>;
    }
  | {
      readonly status: "duplicate";
      readonly serverSequence: number;
    }
  | {
      readonly status: "stale";
      readonly lastClientSequence: number;
    };

export interface CommandOrdererOptions {
  readonly initialServerSequence?: number;
  readonly maxRememberedCommands?: number;
}

/**
 * Server-side monotonic sequencer with bounded duplicate memory and per-participant client
 * sequence checks. Authorization must happen before calling accept().
 */
export class CommandOrderer<Command> {
  readonly #maxRememberedCommands: number;
  readonly #accepted = new Map<CommandId, number>();
  readonly #lastClientSequence = new Map<ParticipantId, number>();
  #serverSequence: number;

  public constructor(options: CommandOrdererOptions = {}) {
    this.#serverSequence = options.initialServerSequence ?? 0;
    this.#maxRememberedCommands = options.maxRememberedCommands ?? 2_048;
    if (!Number.isSafeInteger(this.#serverSequence) || this.#serverSequence < 0) {
      throw new RangeError("initialServerSequence must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(this.#maxRememberedCommands) || this.#maxRememberedCommands < 1) {
      throw new RangeError("maxRememberedCommands must be a positive safe integer");
    }
  }

  public accept(candidate: CommandCandidate<Command>): CommandAcceptance<Command> {
    if (
      !Number.isSafeInteger(candidate.clientSequence) ||
      candidate.clientSequence < 0 ||
      !Number.isFinite(candidate.receivedAtServerTimeMs)
    ) {
      throw new RangeError("Command candidate has invalid sequence or timing");
    }

    const acceptedSequence = this.#accepted.get(candidate.commandId);
    if (acceptedSequence !== undefined) {
      return { status: "duplicate", serverSequence: acceptedSequence };
    }

    const lastClientSequence = this.#lastClientSequence.get(candidate.participantId);
    if (lastClientSequence !== undefined && candidate.clientSequence <= lastClientSequence) {
      return { status: "stale", lastClientSequence };
    }
    if (this.#serverSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Server sequence is exhausted");
    }

    this.#serverSequence += 1;
    this.#lastClientSequence.set(candidate.participantId, candidate.clientSequence);
    this.#accepted.set(candidate.commandId, this.#serverSequence);
    while (this.#accepted.size > this.#maxRememberedCommands) {
      const oldest = this.#accepted.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#accepted.delete(oldest);
    }

    return {
      status: "accepted",
      ordered: { ...candidate, serverSequence: this.#serverSequence },
    };
  }

  public get serverSequence(): number {
    return this.#serverSequence;
  }

  public lastClientSequence(participantId: ParticipantId): number | null {
    return this.#lastClientSequence.get(participantId) ?? null;
  }
}

export type SequenceDecision =
  | { readonly status: "apply" }
  | { readonly status: "duplicate" }
  | { readonly status: "stale" }
  | { readonly status: "gap"; readonly expectedSequence: number };

export interface CommandSequenceTrackerOptions {
  readonly initialServerSequence?: number;
  readonly maxRememberedCommands?: number;
}

/**
 * Client-side gate: a command is applied exactly once and only in contiguous authoritative
 * order. A gap asks the transport to restore from a snapshot instead of guessing.
 */
export class CommandSequenceTracker {
  readonly #maxRememberedCommands: number;
  readonly #seen = new Map<CommandId, true>();
  #lastServerSequence: number;

  public constructor(options: CommandSequenceTrackerOptions = {}) {
    this.#lastServerSequence = options.initialServerSequence ?? 0;
    this.#maxRememberedCommands = options.maxRememberedCommands ?? 2_048;
    if (!Number.isSafeInteger(this.#lastServerSequence) || this.#lastServerSequence < 0) {
      throw new RangeError("initialServerSequence must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(this.#maxRememberedCommands) || this.#maxRememberedCommands < 1) {
      throw new RangeError("maxRememberedCommands must be a positive safe integer");
    }
  }

  public inspect(commandId: CommandId, serverSequence: number): SequenceDecision {
    if (!Number.isSafeInteger(serverSequence) || serverSequence < 0) {
      throw new RangeError("serverSequence must be a nonnegative safe integer");
    }
    if (this.#seen.has(commandId)) {
      return { status: "duplicate" };
    }
    if (serverSequence <= this.#lastServerSequence) {
      return { status: "stale" };
    }
    if (serverSequence !== this.#lastServerSequence + 1) {
      return {
        status: "gap",
        expectedSequence: this.#lastServerSequence + 1,
      };
    }

    this.#lastServerSequence = serverSequence;
    this.#seen.set(commandId, true);
    while (this.#seen.size > this.#maxRememberedCommands) {
      const oldest = this.#seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#seen.delete(oldest);
    }
    return { status: "apply" };
  }

  public restoreFromSnapshot(serverSequence: number): void {
    if (!Number.isSafeInteger(serverSequence) || serverSequence < this.#lastServerSequence) {
      throw new RangeError("A snapshot cannot move the authoritative sequence backwards");
    }
    this.#lastServerSequence = serverSequence;
  }

  public get lastServerSequence(): number {
    return this.#lastServerSequence;
  }
}

export class IdempotencyGuard<Key> {
  readonly #maximumSize: number;
  readonly #seen = new Map<Key, true>();

  public constructor(maximumSize = 2_048) {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 1) {
      throw new RangeError("maximumSize must be a positive safe integer");
    }
    this.#maximumSize = maximumSize;
  }

  /** Returns true exactly once while a key remains in the bounded history. */
  public claim(key: Key): boolean {
    if (this.#seen.has(key)) {
      return false;
    }
    this.#seen.set(key, true);
    while (this.#seen.size > this.#maximumSize) {
      const oldest = this.#seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#seen.delete(oldest);
    }
    return true;
  }

  public has(key: Key): boolean {
    return this.#seen.has(key);
  }

  public clear(): void {
    this.#seen.clear();
  }
}
