import { describe, expect, it } from "vitest";

import {
  VideoCapabilitiesSchema,
  VideoIdentitySchema,
  compareVideoIdentities,
  normalizeVideoIdentity,
} from "../src/index.js";

describe("video identity normalization", () => {
  it("extracts a known provider ID and drops private URL material", () => {
    const identity = normalizeVideoIdentity({
      url: "https://user:password@www.youtube.com/watch?v=dQw4w9WgXcQ&token=secret#private",
      title: "  Example   Video ",
      durationSec: 212.24,
    });

    expect(identity).toMatchObject({
      kind: "known",
      provider: "youtube",
      origin: "https://www.youtube.com",
      contentId: "dQw4w9WgXcQ",
      durationSec: 212,
      isLive: false,
    });
    expect(JSON.stringify(identity)).not.toContain("secret");
    expect(JSON.stringify(identity)).not.toContain("password");
    expect(JSON.stringify(identity)).not.toContain("Example Video");
    expect(identity.normalizedPath).toBeUndefined();
  });

  it("normalizes a generic path, strips query/fragment, and fingerprints titles", () => {
    const first = normalizeVideoIdentity({
      url: "https://media.example.test/show//episode-1/?auth=secret#chapter",
      title: "My Episode",
      durationSec: 1_000.26,
    });
    const second = normalizeVideoIdentity({
      url: "https://media.example.test/show/episode-1?different=true",
      title: "  my   episode ",
      durationSec: 1_000.2,
    });

    expect(first.kind).toBe("generic");
    expect(first.normalizedPath).toBe("/show/episode-1");
    expect(first.titleFingerprint).toBe(second.titleFingerprint);
    expect(first.durationSec).toBe(1_000.5);
    expect(JSON.stringify(first)).not.toContain("auth");
  });

  it("uses explicit safe adapter identity but rejects unsafe values", () => {
    const identity = normalizeVideoIdentity({
      url: "https://watch.example/path?private=1",
      provider: "adapter-name",
      contentId: "season-1_episode.2",
      durationSec: 42,
    });
    expect(identity).toMatchObject({
      kind: "known",
      provider: "adapter-name",
      contentId: "season-1_episode.2",
    });

    const unsafe = normalizeVideoIdentity({
      url: "https://watch.example/path",
      provider: "Bad Provider",
      contentId: "../private?id=x",
    });
    expect(unsafe.kind).toBe("generic");
  });

  it("marks live identities without pretending a fixed duration is meaningful", () => {
    const identity = normalizeVideoIdentity({
      url: "https://example.test/live",
      durationSec: Number.POSITIVE_INFINITY,
      isLive: true,
    });
    expect(identity.durationSec).toBeNull();
    expect(identity.isLive).toBe(true);
    expect(VideoIdentitySchema.safeParse({ ...identity, durationSec: 100 }).success).toBe(false);
  });

  it("compares stable identity and materially different cuts safely", () => {
    const base = normalizeVideoIdentity({
      url: "https://vimeo.com/123456",
      durationSec: 1_000,
      title: "One",
    });
    const close = normalizeVideoIdentity({
      url: "https://vimeo.com/123456?autoplay=1",
      durationSec: 1_002,
      title: "Localized title",
    });
    const differentCut = { ...close, durationSec: 1_020 };
    const differentVideo = { ...close, contentId: "999999" };

    expect(compareVideoIdentities(base, close)).toEqual({
      compatible: true,
      reason: "compatible",
    });
    expect(compareVideoIdentities(base, differentCut)).toMatchObject({
      compatible: false,
      reason: "duration-mismatch",
      durationDifferenceSec: 20,
    });
    expect(compareVideoIdentities(base, differentVideo)).toMatchObject({
      compatible: false,
      reason: "content-mismatch",
    });
    expect(compareVideoIdentities({ ...base, isLive: true, durationSec: null }, close)).toEqual({
      compatible: false,
      reason: "live-unsupported",
    });
  });

  it("rejects internally inconsistent seek capabilities", () => {
    expect(
      VideoCapabilitiesSchema.safeParse({
        canPlayPause: true,
        canSeek: true,
        canSetPlaybackRate: true,
        seekableStartSec: 20,
        seekableEndSec: 10,
      }).success,
    ).toBe(false);
    expect(
      VideoCapabilitiesSchema.safeParse({
        canPlayPause: true,
        canSeek: false,
        canSetPlaybackRate: true,
        seekableStartSec: 0,
        seekableEndSec: 10,
      }).success,
    ).toBe(false);
  });
});
