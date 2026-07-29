import { browser } from "wxt/browser";

import { sendRuntimeRequest } from "../../lib/bridge";
import { getSettings, originPatternForUrl, saveSettings } from "../../lib/settings";
import { RuntimeEventSchema } from "../../lib/runtime-schema";
import { applyThemeMode } from "../../lib/theme";
import type {
  ControlMode,
  PopupState,
  RoomView,
  RuntimeEvent,
  SafeVideoIdentity,
} from "../../lib/types";

import "./style.css";

const initialSettings = getSettings().then((settings) => {
  applyThemeMode(settings.themeMode);
  return settings;
});

const elements = {
  statusCard: required<HTMLElement>("status-card"),
  statusTitle: required<HTMLElement>("status-title"),
  statusMessage: required<HTMLElement>("status-message"),
  permissionPanel: required<HTMLElement>("permission-panel"),
  enableSite: required<HTMLButtonElement>("enable-site"),
  videoPanel: required<HTMLElement>("video-panel"),
  videoTitle: required<HTMLElement>("video-title"),
  videoDetail: required<HTMLElement>("video-detail"),
  pickerToggle: required<HTMLButtonElement>("picker-toggle"),
  pickerPanel: required<HTMLElement>("picker-panel"),
  picker: required<HTMLElement>("video-picker"),
  lobbyPanel: required<HTMLElement>("lobby-panel"),
  createRoom: required<HTMLButtonElement>("create-room"),
  joinForm: required<HTMLFormElement>("join-form"),
  roomCodeInput: required<HTMLInputElement>("room-code"),
  roomPanel: required<HTMLElement>("room-panel"),
  roomRole: required<HTMLElement>("room-role"),
  participantCount: required<HTMLElement>("participant-count"),
  roomCodeWrap: required<HTMLElement>("room-code-wrap"),
  roomCodeDisplay: required<HTMLElement>("room-code-display"),
  copyCode: required<HTMLButtonElement>("copy-code"),
  readyButton: required<HTMLButtonElement>("ready-button"),
  openPeerVideo: required<HTMLButtonElement>("open-peer-video"),
  roomModeRow: required<HTMLElement>("room-mode-row"),
  roomMode: required<HTMLInputElement>("room-mode"),
  leaveRoom: required<HTMLButtonElement>("leave-room"),
  endRoom: required<HTMLButtonElement>("end-room"),
  error: required<HTMLElement>("error-message"),
  openOptions: required<HTMLButtonElement>("open-options"),
  privacyLink: required<HTMLAnchorElement>("privacy-link"),
  serverLabel: required<HTMLElement>("server-label"),
};

let activeTabId: number | undefined;
let activeTabUrl: string | undefined;
let state: PopupState | undefined;
let loading = false;

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
}

function selectedMode(): ControlMode {
  const value = document.querySelector<HTMLInputElement>(
    "input[name='control-mode']:checked",
  )?.value;
  return value === "shared" ? "shared" : "host-only";
}

function showError(error?: unknown): void {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

async function withLoading(action: () => Promise<void>): Promise<void> {
  if (loading) return;
  loading = true;
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = true;
  });
  showError();
  try {
    await action();
  } catch (error) {
    showError(error);
  } finally {
    loading = false;
    document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = false;
    });
  }
}

function canonicalUrl(identity?: SafeVideoIdentity): string | null {
  if (!identity) return null;
  const id = encodeURIComponent(identity.contentKey);
  switch (identity.provider) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${id}`;
    case "vimeo":
      return `https://vimeo.com/${id}`;
    case "dailymotion":
      return `https://www.dailymotion.com/video/${id}`;
    case "twitch-vod":
      return `https://www.twitch.tv/videos/${id}`;
    case "netflix":
      return `https://www.netflix.com/watch/${id}`;
    case "crunchyroll":
      return `https://www.crunchyroll.com/watch/${id}`;
    default:
      return null;
  }
}

function renderRoom(room: RoomView): void {
  const inRoom = room.participantCount > 0;
  elements.lobbyPanel.hidden = inRoom || !state?.enabled || !state.video?.capabilities.canPlay;
  elements.roomPanel.hidden = !inRoom;
  elements.statusCard.dataset.state = room.status;
  elements.statusTitle.textContent = statusTitle(room.status);
  elements.statusMessage.textContent = room.message;
  if (!inRoom) return;
  elements.roomRole.textContent = room.role === "host" ? "You’re the host" : "You’re the guest";
  elements.participantCount.textContent = `${room.participantCount} of 2`;
  elements.roomCodeWrap.hidden = room.role !== "host" || !room.roomCode;
  elements.roomCodeDisplay.textContent = room.roomCode ?? "—";
  elements.readyButton.hidden = room.status !== "autoplay-blocked";
  elements.roomMode.checked = room.controlMode === "shared";
  elements.roomModeRow.hidden = room.role !== "host";
  elements.endRoom.hidden = room.role !== "host";
  const peerUrl = canonicalUrl(room.peerVideo);
  elements.openPeerVideo.hidden = room.status !== "mismatch" || peerUrl === null;
  elements.openPeerVideo.dataset.url = peerUrl ?? "";
}

function statusTitle(status: RoomView["status"]): string {
  const titles: Record<RoomView["status"], string> = {
    disabled: "Extension not enabled",
    "no-video": "No supported video found",
    ready: "Ready to sync",
    waiting: "Waiting for the other person",
    connected: "Connected to peer",
    "in-sync": "In sync",
    correcting: "Correcting drift",
    "peer-buffering": "Peer is buffering",
    mismatch: "Different videos detected",
    "autoplay-blocked": "One click needed",
    reconnecting: "Reconnecting",
    offline: "Sync service unavailable",
    ended: "Video ended",
  };
  return titles[status];
}

function render(next: PopupState): void {
  state = next;
  elements.permissionPanel.hidden = next.enabled || !next.supportedPage;
  elements.videoPanel.hidden = !next.enabled || !next.video?.capabilities.canPlay;
  if (next.video?.capabilities.canPlay) {
    elements.videoTitle.textContent = next.video.identity.displayTitle;
    elements.videoDetail.textContent = next.video.identity.isLive
      ? "Live stream · synchronization is limited"
      : `${next.video.identity.provider.replaceAll("-", " ")} · ${next.video.identity.seekable ? "seekable" : "not seekable"}`;
  }
  elements.pickerToggle.hidden = next.candidates.length <= 1;
  elements.picker.innerHTML = "";
  next.candidates.forEach((candidate) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.id = candidate.id;
    button.setAttribute("aria-pressed", String(candidate.selected));
    button.textContent = candidate.label;
    button.addEventListener("click", () => {
      void withLoading(async () => {
        await sendRuntimeRequest({
          type: "popup/select-video",
          tabId: activeTabId!,
          candidateId: candidate.id,
        });
        await refresh();
      });
    });
    elements.picker.append(button);
  });
  elements.serverLabel.textContent = next.serverUrl.startsWith("ws://127.0.0.1")
    ? "Local sync service"
    : "Custom sync service";
  renderRoom(next.room);
}

async function refresh(): Promise<void> {
  if (activeTabId === undefined) return;
  try {
    const next = await sendRuntimeRequest<PopupState>({
      type: "popup/get-state",
      tabId: activeTabId,
    });
    render(next);
  } catch (error) {
    const supportedPage = originPatternForUrl(activeTabUrl ?? "") !== null;
    const settings = await getSettings();
    render({
      enabled: false,
      supportedPage,
      candidates: [],
      room: {
        participantCount: 0,
        controlMode: settings.defaultControlMode,
        status: supportedPage ? "disabled" : "no-video",
        message: supportedPage
          ? "Enable access to detect the video on this site."
          : "Browser pages, PDFs, and extension stores cannot be controlled.",
      },
      serverUrl: settings.serverUrl,
    });
    if (!supportedPage) showError(error);
  }
}

async function activateSite(): Promise<void> {
  const originPattern = originPatternForUrl(activeTabUrl ?? "");
  if (!originPattern || activeTabId === undefined) throw new Error("This page cannot be enabled.");
  const granted = await browser.permissions.request({ origins: [originPattern] });
  if (!granted) throw new Error("Site access was not granted.");
  const settings = await getSettings();
  await saveSettings({
    enabledOrigins: Array.from(new Set([...settings.enabledOrigins, originPattern])),
  });
  await sendRuntimeRequest({ type: "popup/activate", tabId: activeTabId, originPattern });
  await refresh();
}

elements.enableSite.addEventListener("click", () => void withLoading(activateSite));
elements.createRoom.addEventListener(
  "click",
  () =>
    void withLoading(async () => {
      await sendRuntimeRequest({
        type: "popup/create-room",
        tabId: activeTabId!,
        controlMode: selectedMode(),
      });
      await refresh();
    }),
);
elements.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void withLoading(async () => {
    await sendRuntimeRequest({
      type: "popup/join-room",
      tabId: activeTabId!,
      roomCode: elements.roomCodeInput.value.trim().toUpperCase(),
    });
    await refresh();
  });
});
elements.copyCode.addEventListener(
  "click",
  () =>
    void withLoading(async () => {
      const code = state?.room.roomCode;
      if (!code) return;
      await navigator.clipboard.writeText(code);
      elements.copyCode.textContent = "Copied";
      window.setTimeout(() => {
        elements.copyCode.textContent = "Copy";
      }, 1_500);
    }),
);
elements.leaveRoom.addEventListener(
  "click",
  () =>
    void withLoading(async () => {
      await sendRuntimeRequest({ type: "popup/leave-room", tabId: activeTabId!, endRoom: false });
      await refresh();
    }),
);
elements.endRoom.addEventListener(
  "click",
  () =>
    void withLoading(async () => {
      await sendRuntimeRequest({ type: "popup/leave-room", tabId: activeTabId!, endRoom: true });
      await refresh();
    }),
);
elements.roomMode.addEventListener(
  "change",
  () =>
    void withLoading(async () => {
      await sendRuntimeRequest({
        type: "popup/set-control-mode",
        tabId: activeTabId!,
        mode: elements.roomMode.checked ? "shared" : "host-only",
      });
      await refresh();
    }),
);
elements.readyButton.addEventListener(
  "click",
  () =>
    void withLoading(async () => {
      await sendRuntimeRequest({ type: "popup/user-ready", tabId: activeTabId! });
      await refresh();
    }),
);
elements.openPeerVideo.addEventListener("click", () => {
  const url = elements.openPeerVideo.dataset.url;
  if (url) void browser.tabs.create({ url });
});
elements.pickerToggle.addEventListener("click", () => {
  elements.pickerPanel.hidden = !elements.pickerPanel.hidden;
  elements.pickerToggle.textContent = elements.pickerPanel.hidden ? "Choose video" : "Hide choices";
});
elements.openOptions.addEventListener("click", () => void browser.runtime.openOptionsPage());
elements.privacyLink.addEventListener("click", (event) => {
  event.preventDefault();
  void browser.runtime.openOptionsPage();
});

browser.runtime.onMessage.addListener((message) => {
  const parsed = RuntimeEventSchema.safeParse(message);
  if (!parsed.success) return;
  const event: RuntimeEvent = parsed.data;
  if (event.type === "background/room-state" && state) {
    render({ ...state, room: event.room });
  }
});

async function initialize(): Promise<void> {
  await initialSettings;
  const explicitTabId = Number(new URLSearchParams(location.search).get("tabId"));
  const tab =
    Number.isSafeInteger(explicitTabId) && explicitTabId > 0
      ? await browser.tabs.get(explicitTabId)
      : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  activeTabId = tab?.id;
  activeTabUrl = tab?.url;
  if (activeTabId === undefined) throw new Error("No active browser tab was found.");
  await refresh();
  window.setInterval(() => void refresh(), 2_000);
}

void initialize().catch(showError);
