import type { z } from "zod";

import { ClientMessageSchema, ServerMessageSchema } from "./messages.js";
import type { ClientMessage, ServerMessage } from "./messages.js";

export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;

export type ProtocolDecodeErrorCode = "PAYLOAD_TOO_LARGE" | "INVALID_JSON" | "INVALID_MESSAGE";

export class ProtocolDecodeError extends Error {
  public readonly code: ProtocolDecodeErrorCode;

  public constructor(code: ProtocolDecodeErrorCode, message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
    this.code = code;
  }
}

function decodeUtf8(input: string | Uint8Array, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > maxBytes) {
      throw new ProtocolDecodeError("PAYLOAD_TOO_LARGE", "Protocol payload is too large");
    }
    return input;
  }

  if (input.byteLength > maxBytes) {
    throw new ProtocolDecodeError("PAYLOAD_TOO_LARGE", "Protocol payload is too large");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new ProtocolDecodeError("INVALID_JSON", "Protocol payload is not valid UTF-8");
  }
}

export function decodeMessage<Output>(
  input: string | Uint8Array,
  schema: z.ZodType<Output>,
  maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
): Output {
  const text = decodeUtf8(input, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolDecodeError("INVALID_JSON", "Protocol payload is not valid JSON");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ProtocolDecodeError("INVALID_MESSAGE", "Protocol payload failed schema validation");
  }
  return result.data;
}

export function decodeClientMessage(
  input: string | Uint8Array,
  maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
): ClientMessage {
  return decodeMessage(input, ClientMessageSchema, maxBytes);
}

export function decodeServerMessage(
  input: string | Uint8Array,
  maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
): ServerMessage {
  return decodeMessage(input, ServerMessageSchema, maxBytes);
}
