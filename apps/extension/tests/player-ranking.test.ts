import { describe, expect, it } from "vitest";

import { rankPlayer, type PlayerDescriptor } from "../lib/adapters/player-detector";

const base: PlayerDescriptor = {
  width: 1280,
  height: 720,
  visibleRatio: 1,
  centerDistance: 0,
  playing: false,
  audible: false,
  loop: false,
  muted: false,
  likelyAdvertisement: false,
};

describe("player ranking", () => {
  it("prefers an active audible primary player", () => {
    expect(rankPlayer({ ...base, playing: true, audible: true })).toBeGreaterThan(rankPlayer(base));
  });

  it("penalizes tiny loop previews and advertisements", () => {
    const preview = rankPlayer({
      ...base,
      width: 160,
      height: 90,
      loop: true,
      muted: true,
    });
    expect(preview).toBeLessThan(rankPlayer(base));
    expect(rankPlayer({ ...base, likelyAdvertisement: true })).toBeLessThan(rankPlayer(base));
  });
});
