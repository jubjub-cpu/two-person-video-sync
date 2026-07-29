import { browser } from "wxt/browser";

const DIAGNOSTICS_KEY = "diagnostics";
const MAX_ENTRIES = 200;

export interface DiagnosticEntry {
  at: number;
  scope: "background" | "content";
  event: string;
  details?: Record<string, string | number | boolean | null>;
}

const SECRET_KEY = /secret|token|code|url|title/i;

function sanitizeDetails(
  details?: Record<string, unknown>,
): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, value]) => [
        key,
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
          ? value
          : null,
      ]),
  );
}

export async function recordDiagnostic(
  scope: DiagnosticEntry["scope"],
  event: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const result = await browser.storage.local.get(DIAGNOSTICS_KEY);
  const entries = Array.isArray(result[DIAGNOSTICS_KEY])
    ? (result[DIAGNOSTICS_KEY] as DiagnosticEntry[])
    : [];
  entries.push({ at: Date.now(), scope, event, details: sanitizeDetails(details) });
  await browser.storage.local.set({ [DIAGNOSTICS_KEY]: entries.slice(-MAX_ENTRIES) });
}

export async function exportDiagnostics(): Promise<{
  generatedAt: string;
  extensionVersion: string;
  userAgent: string;
  entries: DiagnosticEntry[];
}> {
  const result = await browser.storage.local.get(DIAGNOSTICS_KEY);
  return {
    generatedAt: new Date().toISOString(),
    extensionVersion: browser.runtime.getManifest().version,
    userAgent: navigator.userAgent.replace(/\([^)]*\)/g, "(redacted)"),
    entries: Array.isArray(result[DIAGNOSTICS_KEY])
      ? (result[DIAGNOSTICS_KEY] as DiagnosticEntry[])
      : [],
  };
}

export async function clearDiagnostics(): Promise<void> {
  await browser.storage.local.remove(DIAGNOSTICS_KEY);
}
