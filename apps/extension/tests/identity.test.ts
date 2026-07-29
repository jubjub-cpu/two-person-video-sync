import { describe, expect, it } from "vitest";

import {
  compareVideoIdentities,
  deriveVideoIdentity,
  fingerprint,
  normalizedPath,
  safeDisplayTitle,
} from "../lib/adapters/identity";

function ranges(length = 1): TimeRanges {
  return {
    length,
    start: () => 0,
    end: () => 100,
  };
}

describe("video identity", () => {
  it("extracts a YouTube identity without leaking query parameters", () => {
    const identity = deriveVideoIdentity({
      url: new URL("https://www.youtube.com/watch?v=abcDEF12345&private=secret"),
      title: "A useful video - YouTube",
      durationSeconds: 600,
      seekable: ranges(),
    });
    expect(identity.provider).toBe("youtube");
    expect(identity.contentKey).toBe("abcDEF12345");
    expect(JSON.stringify(identity)).not.toContain("secret");
  });

  it("normalizes generic paths and strips private path segments", () => {
    expect(normalizedPath(new URL("https://example.test/account/alice/movie/?token=x"))).toBe(
      "/private/movie",
    );
  });

  it("sanitizes titles and creates deterministic fingerprints", () => {
    expect(safeDisplayTitle("Hi\u0000 person@example.test")).toBe("Hi [private]");
    expect(fingerprint("same")).toBe(fingerprint("same"));
    expect(fingerprint("same")).not.toBe(fingerprint("different"));
  });

  it("rejects mismatched content and materially different cuts", () => {
    const base = {
      provider: "youtube",
      contentKey: "a",
      origin: "https://youtube.com",
      pathFingerprint: "x",
      titleFingerprint: "y",
      displayTitle: "Title",
      durationMs: 100_000,
      isLive: false,
      seekable: true,
    };
    expect(compareVideoIdentities(base, { ...base, contentKey: "b" }).compatible).toBe(false);
    expect(compareVideoIdentities(base, { ...base, durationMs: 110_000 }).compatible).toBe(false);
    expect(compareVideoIdentities(base, { ...base, durationMs: 100_500 }).compatible).toBe(true);
  });
});
