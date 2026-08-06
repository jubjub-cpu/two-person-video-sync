import { browser } from "wxt/browser";

import { clearDiagnostics, exportDiagnostics } from "../../lib/diagnostics";
import { getSettings, saveSettings } from "../../lib/settings";
import { applyThemeMode } from "../../lib/theme";
import type { ThemeMode } from "../../lib/types";

import "./style.css";

const DONATION_URLS = [
  [
    "donate-bitcoin",
    "bitcoin:3Ej3XVxtvkZqgrzeFt7AXfe5xtj67QnW87?label=Vyzync&message=Buy%20the%20dev%20a%20coffee",
  ],
  ["donate-ethereum", "ethereum:0x9B1110fAf0469474a681dba98826a0aeEc7A48B2@1"],
] as const;

const form = required<HTMLFormElement>("settings-form");
const defaultMode = required<HTMLSelectElement>("default-mode");
const showBadge = required<HTMLInputElement>("show-badge");
const themeSystem = required<HTMLInputElement>("theme-system");
const themeLight = required<HTMLInputElement>("theme-light");
const themeDark = required<HTMLInputElement>("theme-dark");
const saveStatus = required<HTMLElement>("save-status");
const permissionSummary = required<HTMLElement>("permission-summary");
const supportControl = required<HTMLElement>("support-control");
const supportDeveloper = required<HTMLButtonElement>("support-developer");
const supportOptions = required<HTMLElement>("support-options");

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing options element: ${id}`);
  return element as T;
}

function selectedThemeMode(): ThemeMode {
  if (themeLight.checked) return "light";
  if (themeDark.checked) return "dark";
  return "system";
}

function setThemeSelection(mode: ThemeMode): void {
  themeSystem.checked = mode === "system";
  themeLight.checked = mode === "light";
  themeDark.checked = mode === "dark";
  applyThemeMode(mode);
}

async function refreshPermissions(): Promise<void> {
  const permissions = await browser.permissions.getAll();
  const origins = permissions.origins ?? [];
  const all = origins.includes("https://*/*") && origins.includes("http://*/*");
  permissionSummary.textContent = all
    ? "Access is enabled for all ordinary websites."
    : origins.length > 0
      ? `Access is enabled for ${origins.length} site pattern${origins.length === 1 ? "" : "s"}.`
      : "No persistent website access is currently granted.";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    await saveSettings({
      defaultControlMode: defaultMode.value === "shared" ? "shared" : "host-only",
      themeMode: selectedThemeMode(),
      showBadge: showBadge.checked,
    });
    saveStatus.textContent = "Saved";
    window.setTimeout(() => {
      saveStatus.textContent = "";
    }, 2_000);
  })();
});

function setSupportMenu(open: boolean): void {
  supportOptions.hidden = !open;
  supportDeveloper.setAttribute("aria-expanded", String(open));
}

supportDeveloper.disabled = false;
supportDeveloper.addEventListener("click", () => {
  setSupportMenu(supportOptions.hidden);
});

for (const [buttonId, url] of DONATION_URLS) {
  required<HTMLButtonElement>(buttonId).addEventListener("click", () => {
    setSupportMenu(false);
    void browser.tabs.create({ url });
  });
}

document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !supportControl.contains(event.target)) {
    setSupportMenu(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || supportOptions.hidden) return;
  setSupportMenu(false);
  supportDeveloper.focus();
});

for (const input of [themeSystem, themeLight, themeDark]) {
  input.addEventListener("change", () => {
    if (input.checked) applyThemeMode(selectedThemeMode());
  });
}

required<HTMLButtonElement>("grant-all").addEventListener("click", () => {
  void (async () => {
    await browser.permissions.request({ origins: ["http://*/*", "https://*/*"] });
    await refreshPermissions();
  })();
});

required<HTMLButtonElement>("remove-all").addEventListener("click", () => {
  void (async () => {
    const permissions = await browser.permissions.getAll();
    const origins = (permissions.origins ?? []).filter(
      (origin) => origin.startsWith("http://") || origin.startsWith("https://"),
    );
    if (origins.length > 0) await browser.permissions.remove({ origins });
    await saveSettings({ enabledOrigins: [] });
    await refreshPermissions();
  })();
});

required<HTMLButtonElement>("export-diagnostics").addEventListener("click", () => {
  void (async () => {
    const diagnostics = await exportDiagnostics();
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `video-sync-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  })();
});

required<HTMLButtonElement>("clear-diagnostics").addEventListener("click", () => {
  void (async () => {
    await clearDiagnostics();
    saveStatus.textContent = "Diagnostics cleared";
    window.setTimeout(() => {
      saveStatus.textContent = "";
    }, 2_000);
  })();
});

async function initialize(): Promise<void> {
  const settings = await getSettings();
  defaultMode.value = settings.defaultControlMode;
  showBadge.checked = settings.showBadge;
  setThemeSelection(settings.themeMode);
  await refreshPermissions();
}

void initialize();
