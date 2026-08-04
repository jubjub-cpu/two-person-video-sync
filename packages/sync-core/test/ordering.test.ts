import { describe, expect, it } from "vitest";

import { createCommandId, createParticipantId, type RandomSource } from "@vyzync/protocol";

import {
  CommandOrderer,
  CommandSequenceTracker,
  IdempotencyGuard,
  orderCommandCandidates,
} from "../src/index.js";

const random =
  (value: number): RandomSource =>
  (buffer) => {
    buffer.fill(value);
    return buffer;
  };

const firstParticipant = createParticipantId(random(0));
const secondParticipant = createParticipantId(random(1));
const firstCommand = createCommandId(random(2));
const secondCommand = createCommandId(random(3));
const thirdCommand = createCommandId(random(4));

describe("authoritative command ordering", () => {
  it("uses stable tie-breakers for near-simultaneous shared-control commands", () => {
    const later = {
      commandId: thirdCommand,
      participantId: firstParticipant,
      clientSequence: 2,
      receivedAtServerTimeMs: 101,
      command: "later",
    };
    const sameTimeSecondParticipant = {
      commandId: secondCommand,
      participantId: secondParticipant,
      clientSequence: 0,
      receivedAtServerTimeMs: 100,
      command: "second participant",
    };
    const sameTimeFirstParticipant = {
      commandId: firstCommand,
      participantId: firstParticipant,
      clientSequence: 1,
      receivedAtServerTimeMs: 100,
      command: "first participant",
    };
    expect(
      orderCommandCandidates([later, sameTimeSecondParticipant, sameTimeFirstParticipant]).map(
        (candidate) => candidate.command,
      ),
    ).toEqual(["first participant", "second participant", "later"]);
  });

  it("assigns one monotonic server sequence per accepted command", () => {
    const orderer = new CommandOrderer<string>({ initialServerSequence: 10 });
    const first = orderer.accept({
      commandId: firstCommand,
      participantId: firstParticipant,
      clientSequence: 1,
      receivedAtServerTimeMs: 100,
      command: "play",
    });
    const second = orderer.accept({
      commandId: secondCommand,
      participantId: secondParticipant,
      clientSequence: 0,
      receivedAtServerTimeMs: 101,
      command: "pause",
    });
    expect(first).toMatchObject({ status: "accepted", ordered: { serverSequence: 11 } });
    expect(second).toMatchObject({ status: "accepted", ordered: { serverSequence: 12 } });
    expect(orderer.serverSequence).toBe(12);
  });

  it("rejects a duplicate command ID and stale participant sequence idempotently", () => {
    const orderer = new CommandOrderer<string>();
    const candidate = {
      commandId: firstCommand,
      participantId: firstParticipant,
      clientSequence: 5,
      receivedAtServerTimeMs: 100,
      command: "seek",
    };
    expect(orderer.accept(candidate)).toMatchObject({
      status: "accepted",
      ordered: { serverSequence: 1 },
    });
    expect(orderer.accept(candidate)).toEqual({ status: "duplicate", serverSequence: 1 });
    expect(
      orderer.accept({
        ...candidate,
        commandId: secondCommand,
        clientSequence: 4,
      }),
    ).toEqual({ status: "stale", lastClientSequence: 5 });
    expect(orderer.serverSequence).toBe(1);
  });
});

describe("client sequence and idempotency guards", () => {
  it("applies contiguous commands once and reports a gap for snapshot recovery", () => {
    const tracker = new CommandSequenceTracker({ initialServerSequence: 10 });
    expect(tracker.inspect(firstCommand, 11)).toEqual({ status: "apply" });
    expect(tracker.inspect(firstCommand, 11)).toEqual({ status: "duplicate" });
    expect(tracker.inspect(secondCommand, 13)).toEqual({
      status: "gap",
      expectedSequence: 12,
    });
    expect(tracker.inspect(secondCommand, 12)).toEqual({ status: "apply" });
    expect(tracker.inspect(thirdCommand, 11)).toEqual({ status: "stale" });
  });

  it("restores sequence from a newer snapshot but never moves backwards", () => {
    const tracker = new CommandSequenceTracker({ initialServerSequence: 2 });
    tracker.restoreFromSnapshot(20);
    expect(tracker.lastServerSequence).toBe(20);
    expect(() => tracker.restoreFromSnapshot(19)).toThrow(RangeError);
  });

  it("offers a bounded generic exactly-once claim helper", () => {
    const guard = new IdempotencyGuard<string>(2);
    expect(guard.claim("a")).toBe(true);
    expect(guard.claim("a")).toBe(false);
    expect(guard.claim("b")).toBe(true);
    expect(guard.claim("c")).toBe(true);
    expect(guard.has("a")).toBe(false);
    expect(guard.claim("a")).toBe(true);
  });
});
