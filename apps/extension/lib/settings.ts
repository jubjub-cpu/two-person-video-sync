import { browser } from "wxt/browser";

import type { ExtensionSettings, ThemeMode } from "./types";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  defaultControlMode: "host-only",
  themeMode: "system",
  showBadge: true,
  enabledOrigins: [],
};

const DEVELOPMENT_SYNC_SERVER_URL = "ws://127.0.0.1:8787/ws";
const BUNDLED_SYNC_SERVER_URL =
  import.meta.env.WXT_SYNC_SERVER_URL?.trim() || DEVELOPMENT_SYNC_SERVER_URL;

export const SETTINGS_KEY = "settings";

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const partial = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return {
    defaultControlMode: partial?.defaultControlMode === "shared" ? "shared" : "host-only",
    themeMode: normalizeThemeMode(partial?.themeMode),
    showBadge: typeof partial?.showBadge === "boolean" ? partial.showBadge : true,
    enabledOrigins: Array.isArray(partial?.enabledOrigins) ? partial.enabledOrigins : [],
  };
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

export function isSafeServerUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return false;
    }
    if (parsed.protocol === "wss:") return true;
    return (
      parsed.protocol === "ws:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function normalizeServerUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!isSafeServerUrl(parsed.toString())) return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = path.endsWith("/ws") ? path : `${path}/ws`;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function resolveSyncServerUrl(value: string = BUNDLED_SYNC_SERVER_URL): string {
  const normalized = normalizeServerUrl(value);
  if (!normalized) {
    throw new Error("The bundled synchronization service address is invalid.");
  }
  return normalized;
}

export const SYNC_SERVER_URL = resolveSyncServerUrl();

export function originPatternForUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}
