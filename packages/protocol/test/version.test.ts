import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  inspectProtocolVersion,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
} from "../src/index.js";

describe("protocol versioning", () => {
  it("negotiates only an explicitly supported version", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(negotiateProtocolVersion([0, 1, 2])).toBe(2);
    expect(negotiateProtocolVersion([0, 1])).toBeNull();
    expect(isSupportedProtocolVersion(2)).toBe(true);
    expect(isSupportedProtocolVersion(1)).toBe(false);
    expect(isSupportedProtocolVersion("2")).toBe(false);
  });

  it("safely inspects incompatible and malformed envelopes", () => {
    expect(inspectProtocolVersion({ protocolVersion: 9 })).toEqual({
      receivedVersion: 9,
      supported: false,
    });
    expect(inspectProtocolVersion({})).toEqual({
      receivedVersion: null,
      supported: false,
    });
    expect(inspectProtocolVersion(null)).toEqual({
      receivedVersion: null,
      supported: false,
    });
  });
});
