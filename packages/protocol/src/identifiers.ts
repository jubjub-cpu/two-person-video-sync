import { z } from "zod";

const RANDOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 16;
const ENTITY_ID_LENGTH = 26;
const TOKEN_LENGTH = 52;

export type RandomSource = (buffer: Uint8Array) => Uint8Array;

const prefixedIdentifier = <Prefix extends string>(prefix: Prefix) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[${RANDOM_ALPHABET}]{${ENTITY_ID_LENGTH}}$`),
      `Expected a safe ${prefix} identifier`,
    )
    .brand<`${Prefix}Id`>();

export const RoomCodeSchema = z
  .string()
  .regex(
    new RegExp(`^[${RANDOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`),
    "Expected a 16-character room code",
  )
  .brand<"RoomCode">();

export const RoomIdSchema = prefixedIdentifier("room");
export const ParticipantIdSchema = prefixedIdentifier("participant");
export const SessionIdSchema = prefixedIdentifier("session");
export const CommandIdSchema = prefixedIdentifier("command");
export const RequestIdSchema = prefixedIdentifier("request");
export const PingIdSchema = prefixedIdentifier("ping");
export const ServerMessageIdSchema = prefixedIdentifier("message");

export const ReconnectTokenSchema = z
  .string()
  .regex(
    new RegExp(`^reconnect_[${RANDOM_ALPHABET}]{${TOKEN_LENGTH}}$`),
    "Expected a safe reconnect token",
  )
  .brand<"ReconnectToken">();

export type RoomCode = z.infer<typeof RoomCodeSchema>;
export type RoomId = z.infer<typeof RoomIdSchema>;
export type ParticipantId = z.infer<typeof ParticipantIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type PingId = z.infer<typeof PingIdSchema>;
export type ServerMessageId = z.infer<typeof ServerMessageIdSchema>;
export type ReconnectToken = z.infer<typeof ReconnectTokenSchema>;

function platformRandom(buffer: Uint8Array): Uint8Array {
  if (globalThis.crypto === undefined) {
    throw new Error("A Web Crypto implementation is required to generate identifiers");
  }
  return globalThis.crypto.getRandomValues(buffer);
}

function randomCharacters(length: number, randomSource: RandomSource): string {
  const bytes = randomSource(new Uint8Array(length));
  if (bytes.length !== length) {
    throw new Error("The random source returned an unexpected number of bytes");
  }

  let result = "";
  for (const byte of bytes) {
    // The alphabet contains exactly 32 characters, so masking is uniform and does not
    // introduce the modulo bias that arbitrary alphabet lengths would.
    result += RANDOM_ALPHABET[byte & 31];
  }
  return result;
}

function createEntityId<Schema extends z.ZodType<string>>(
  prefix: string,
  schema: Schema,
  randomSource: RandomSource,
): z.infer<Schema> {
  return schema.parse(`${prefix}_${randomCharacters(ENTITY_ID_LENGTH, randomSource)}`);
}

export function normalizeRoomCode(input: string): RoomCode {
  return RoomCodeSchema.parse(input.toUpperCase().replace(/[\s-]/g, ""));
}

/**
 * Generates an 80-bit human-shareable room code using platform cryptographic randomness.
 * The optional source exists only for deterministic testing.
 */
export function createRoomCode(randomSource: RandomSource = platformRandom): RoomCode {
  return RoomCodeSchema.parse(randomCharacters(ROOM_CODE_LENGTH, randomSource));
}

export function createRoomId(randomSource: RandomSource = platformRandom): RoomId {
  return createEntityId("room", RoomIdSchema, randomSource);
}

export function createParticipantId(randomSource: RandomSource = platformRandom): ParticipantId {
  return createEntityId("participant", ParticipantIdSchema, randomSource);
}

export function createSessionId(randomSource: RandomSource = platformRandom): SessionId {
  return createEntityId("session", SessionIdSchema, randomSource);
}

export function createCommandId(randomSource: RandomSource = platformRandom): CommandId {
  return createEntityId("command", CommandIdSchema, randomSource);
}

export function createRequestId(randomSource: RandomSource = platformRandom): RequestId {
  return createEntityId("request", RequestIdSchema, randomSource);
}

export function createPingId(randomSource: RandomSource = platformRandom): PingId {
  return createEntityId("ping", PingIdSchema, randomSource);
}

export function createServerMessageId(
  randomSource: RandomSource = platformRandom,
): ServerMessageId {
  return createEntityId("message", ServerMessageIdSchema, randomSource);
}

/**
 * Generates a 260-bit opaque reconnection credential. The token must be redacted from logs.
 */
export function createReconnectToken(randomSource: RandomSource = platformRandom): ReconnectToken {
  return ReconnectTokenSchema.parse(`reconnect_${randomCharacters(TOKEN_LENGTH, randomSource)}`);
}

export const IDENTIFIER_SECURITY = Object.freeze({
  roomCodeEntropyBits: ROOM_CODE_LENGTH * 5,
  entityIdEntropyBits: ENTITY_ID_LENGTH * 5,
  reconnectTokenEntropyBits: TOKEN_LENGTH * 5,
  roomCodeLength: ROOM_CODE_LENGTH,
});
