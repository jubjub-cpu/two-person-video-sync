import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  createRequestId,
  decodeClientMessage,
} from "../src/index.js";

const requestId = createRequestId((buffer) => {
  buffer.fill(0);
  return buffer;
});

function captureProtocolError(run: () => unknown): ProtocolDecodeError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProtocolDecodeError);
  return thrown as ProtocolDecodeError;
}

describe("wire decoding", () => {
  const valid = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    clientTimeMs: 1,
    type: "room.create",
    controlMode: "host-only",
  };

  it("decodes schema-valid JSON strings and UTF-8 bytes", () => {
    expect(decodeClientMessage(JSON.stringify(valid))).toEqual(valid);
    expect(decodeClientMessage(new TextEncoder().encode(JSON.stringify(valid)))).toEqual(valid);
  });

  it("distinguishes malformed JSON, schema failure, and oversized input", () => {
    expect(captureProtocolError(() => decodeClientMessage("{")).code).toBe("INVALID_JSON");
    expect(
      captureProtocolError(() => decodeClientMessage(JSON.stringify({ hello: "world" }))).code,
    ).toBe("INVALID_MESSAGE");
    expect(captureProtocolError(() => decodeClientMessage(JSON.stringify(valid), 10)).code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("rejects invalid UTF-8 and invalid byte limits", () => {
    expect(
      captureProtocolError(() => decodeClientMessage(Uint8Array.from([0xc3, 0x28]))).code,
    ).toBe("INVALID_JSON");
    expect(() => decodeClientMessage(JSON.stringify(valid), 0)).toThrow(RangeError);
  });
});
