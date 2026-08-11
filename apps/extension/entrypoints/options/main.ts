import { browser } from "wxt/browser";
import { toDataURL } from "qrcode";

import { clearDiagnostics, exportDiagnostics } from "../../lib/diagnostics";
import { getSettings, saveSettings } from "../../lib/settings";
import {
  isSupportAssetId,
  SUPPORT_ASSETS,
  SUPPORT_ASSET_IDS,
  type SupportAssetId,
} from "../../lib/support";
import { applyThemeMode } from "../../lib/theme";
import type { ThemeMode } from "../../lib/types";

import "./style.css";

const form = required<HTMLFormElement>("settings-form");
const defaultMode = required<HTMLSelectElement>("default-mode");
const showBadge = required<HTMLInputElement>("show-badge");
const themeSystem = required<HTMLInputElement>("theme-system");
const themeLight = required<HTMLInputElement>("theme-light");
const themeDark = required<HTMLInputElement>("theme-dark");
const saveStatus = required<HTMLElement>("save-status");
const permissionSummary = required<HTMLElement>("permission-summary");
const supportDeveloper = required<HTMLButtonElement>("support-developer");
const supportDialog = required<HTMLDialogElement>("support-dialog");
const closeSupportDialog = required<HTMLButtonElement>("close-support-dialog");
const supportQrFrame = required<HTMLElement>("support-qr-frame");
const supportQr = required<HTMLImageElement>("support-qr");
const supportAssetName = required<HTMLElement>("support-asset-name");
const supportAssetSymbol = required<HTMLElement>("support-asset-symbol");
const supportScanLabel = required<HTMLElement>("support-scan-label");
const supportAddress = required<HTMLElement>("support-address");
const supportNetworkNotice = required<HTMLElement>("support-network-notice");
const copySupportAddress = required<HTMLButtonElement>("copy-support-address");
const supportStatus = required<HTMLElement>("support-status");
const supportWalletOptions = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-support-asset]"),
);

let selectedSupportAssetId: SupportAssetId = "bitcoin";
let supportRenderId = 0;
let supportStatusTimer: number | undefined;

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

function clearSupportStatus(): void {
  window.clearTimeout(supportStatusTimer);
  supportStatusTimer = undefined;
  supportStatus.textContent = "";
  copySupportAddress.textContent = "Copy address";
}

function showSupportStatus(message: string): void {
  clearSupportStatus();
  supportStatus.textContent = message;
  supportStatusTimer = window.setTimeout(clearSupportStatus, 2_000);
}

async function renderSupportAsset(assetId: SupportAssetId): Promise<void> {
  const renderId = ++supportRenderId;
  const asset = SUPPORT_ASSETS[assetId];
  selectedSupportAssetId = assetId;
  clearSupportStatus();

  for (const option of supportWalletOptions) {
    option.setAttribute("aria-pressed", String(option.dataset.supportAsset === assetId));
  }

  supportAssetName.textContent = asset.name;
  supportAssetSymbol.textContent = asset.symbol;
  supportScanLabel.textContent = asset.scanLabel;
  supportAddress.textContent = asset.address;
  supportNetworkNotice.textContent = asset.networkNotice;
  supportQrFrame.setAttribute("aria-label", `${asset.name} payment QR code`);
  supportQr.alt = `${asset.name} payment QR code`;

  try {
    const source = await toDataURL(asset.paymentUri, {
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
      margin: 4,
      width: 216,
    });
    if (renderId === supportRenderId) supportQr.src = source;
  } catch {
    if (renderId !== supportRenderId) return;
    supportQr.removeAttribute("src");
    showSupportStatus("QR code unavailable. Copy the address instead.");
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) throw new Error("Clipboard copy failed");
  }
}

supportDeveloper.disabled = false;
supportDeveloper.addEventListener("click", () => {
  if (supportDialog.open) return;
  supportDeveloper.setAttribute("aria-expanded", "true");
  supportDialog.showModal();
  void renderSupportAsset(selectedSupportAssetId);
  closeSupportDialog.focus();
});

closeSupportDialog.addEventListener("click", () => supportDialog.close());

supportDialog.addEventListener("click", (event) => {
  if (event.target === supportDialog) supportDialog.close();
});

supportDialog.addEventListener("close", () => {
  supportDeveloper.setAttribute("aria-expanded", "false");
  clearSupportStatus();
  supportDeveloper.focus();
});

for (const option of supportWalletOptions) {
  option.addEventListener("click", () => {
    const assetId = option.dataset.supportAsset;
    if (assetId && isSupportAssetId(assetId)) void renderSupportAsset(assetId);
  });
}

copySupportAddress.addEventListener("click", () => {
  void (async () => {
    try {
      await copyText(SUPPORT_ASSETS[selectedSupportAssetId].address);
      showSupportStatus("Address copied.");
      copySupportAddress.textContent = "Copied";
    } catch {
      showSupportStatus("Copy failed. Select the address and copy it.");
    }
  })();
});

document.addEventListener("keydown", (event) => {
  if (!supportDialog.open || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const activeElement = document.activeElement;
  const currentIndex = supportWalletOptions.findIndex((option) => option === activeElement);
  if (currentIndex < 0) return;
  event.preventDefault();
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex =
    (currentIndex + direction + SUPPORT_ASSET_IDS.length) % SUPPORT_ASSET_IDS.length;
  const nextAssetId = SUPPORT_ASSET_IDS[nextIndex];
  const nextOption = supportWalletOptions[nextIndex];
  if (nextAssetId && nextOption) {
    nextOption.focus();
    void renderSupportAsset(nextAssetId);
  }
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
