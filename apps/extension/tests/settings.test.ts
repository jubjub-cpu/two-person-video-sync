import { describe, expect, it } from "vitest";

import {
  isSafeServerUrl,
  normalizeServerUrl,
  normalizeThemeMode,
  originPatternForUrl,
  PUBLIC_SYNC_SERVER_URL,
  resolveSyncServerUrl,
} from "../lib/settings";

describe("settings safety", () => {
  it("creates cross-browser host match patterns without explicit ports", () => {
    expect(originPatternForUrl("http://127.0.0.1:4173/watch?v=private")).toBe("http://127.0.0.1/*");
    expect(originPatternForUrl("https://video.example.test:8443/path")).toBe(
      "https://video.example.test/*",
    );
  });

  it("rejects protected and non-web pages", () => {
    expect(originPatternForUrl("chrome://extensions")).toBeNull();
    expect(originPatternForUrl("about:debugging")).toBeNull();
  });

  it("canonicalizes relay endpoints", () => {
    expect(normalizeServerUrl("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws");
    expect(normalizeServerUrl("wss://sync.example.test/realtime/")).toBe(
      "wss://sync.example.test/realtime/ws",
    );
  });

  it("rejects remote plaintext and URL-carried credentials or secrets", () => {
    expect(isSafeServerUrl("ws://sync.example.test/ws")).toBe(false);
    expect(normalizeServerUrl("wss://user:pass@sync.example.test/ws")).toBeNull();
    expect(normalizeServerUrl("wss://sync.example.test/ws?token=secret")).toBeNull();
    expect(normalizeServerUrl("wss://sync.example.test/ws#secret")).toBeNull();
  });

  it("resolves a bundled relay without accepting unsafe transport", () => {
    expect(PUBLIC_SYNC_SERVER_URL).toBe("wss://two-person-video-sync-jubjub-cpu.onrender.com/ws");
    expect(resolveSyncServerUrl(PUBLIC_SYNC_SERVER_URL)).toBe(PUBLIC_SYNC_SERVER_URL);
    expect(resolveSyncServerUrl("wss://sync.example.test")).toBe("wss://sync.example.test/ws");
    expect(() => resolveSyncServerUrl("ws://sync.example.test/ws")).toThrow(
      "bundled synchronization service address is invalid",
    );
  });

  it("normalizes persisted appearance values", () => {
    expect(normalizeThemeMode("light")).toBe("light");
    expect(normalizeThemeMode("dark")).toBe("dark");
    expect(normalizeThemeMode("system")).toBe("system");
    expect(normalizeThemeMode("sepia")).toBe("system");
    expect(normalizeThemeMode(undefined)).toBe("system");
  });
});
