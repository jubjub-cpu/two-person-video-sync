import type { RoomView, SyncStatus, ThemeMode } from "./types";

const labels: Record<SyncStatus, string> = {
  disabled: "Video Sync off",
  "no-video": "No supported video found",
  ready: "Ready to sync",
  waiting: "Waiting for the other person",
  connected: "Connected to friend",
  "in-sync": "In sync",
  correcting: "Correcting drift",
  "peer-buffering": "Your friend is buffering",
  mismatch: "Different videos detected",
  "autoplay-blocked": "One click needed",
  reconnecting: "Reconnecting",
  offline: "Sync service unavailable",
  ended: "Video ended",
};

const compactLabels: Record<SyncStatus, string> = {
  disabled: "Sync off",
  "no-video": "No video",
  ready: "Ready",
  waiting: "Waiting",
  connected: "Connected",
  "in-sync": "In sync",
  correcting: "Syncing",
  "peer-buffering": "Friend buffering",
  mismatch: "Video mismatch",
  "autoplay-blocked": "Click to continue",
  reconnecting: "Reconnecting",
  offline: "Offline",
  ended: "Ended",
};

export interface StatusBadgeIconUrls {
  chevron: string;
  close: string;
  copy: string;
  leave: string;
  reconnect: string;
  userConnected: string;
  userDisconnected: string;
  wifi: string;
}

export interface StatusBadgeActions {
  onCopyRoomCode?: (roomCode: string) => Promise<void> | void;
  onLeaveRoom?: (endRoom: boolean) => Promise<void> | void;
  onReconnect?: () => Promise<void> | void;
}

interface SyncQuality {
  label: string;
  tone: "good" | "fair" | "poor" | "neutral";
}

function formatRoomCode(roomCode: string): string {
  return roomCode.replace(/(.{4})/g, "$1 ").trim();
}

function qualityForRoom(room?: RoomView): SyncQuality {
  if (!room || room.participantCount !== 2) {
    return { label: "Unavailable", tone: "neutral" };
  }
  if (room.reconnecting || room.status === "reconnecting") {
    return { label: "Reconnecting", tone: "fair" };
  }
  if (room.latencyMs === undefined) {
    return { label: "Checking…", tone: "neutral" };
  }

  const latency = Math.round(room.latencyMs);
  const drift = Math.abs(room.driftMs ?? 0);
  if (latency <= 150 && drift <= 500) {
    return { label: `Good · ${latency} ms`, tone: "good" };
  }
  if (latency <= 300 && drift <= 1_500) {
    return { label: `Fair · ${latency} ms`, tone: "fair" };
  }
  return { label: `Poor · ${latency} ms`, tone: "poor" };
}

function icon(url: string, className = "icon"): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.setAttribute("aria-hidden", "true");
  element.style.webkitMaskImage = `url("${url}")`;
  element.style.maskImage = `url("${url}")`;
  return element;
}

function actionButton(
  iconUrl: string,
  label: string,
  description: string,
  action: "copy" | "reconnect" | "leave",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `menu-action${action === "leave" ? " menu-action-danger" : ""}`;
  button.dataset.action = action;

  const actionIcon = icon(iconUrl, "icon action-icon");
  const copy = document.createElement("span");
  copy.className = "action-copy";
  const title = document.createElement("strong");
  title.textContent = label;
  const detail = document.createElement("span");
  detail.className = "action-detail";
  detail.textContent = description;
  copy.append(title, detail);
  button.append(actionIcon, copy);
  return button;
}

export class StatusBadge {
  private readonly host: HTMLDivElement;
  private readonly badge: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly title: HTMLElement;
  private readonly expandedTitle: HTMLElement;
  private readonly expandedDetail: HTMLParagraphElement;
  private readonly friendIcon: HTMLSpanElement;
  private readonly friendValue: HTMLElement;
  private readonly qualityValue: HTMLElement;
  private readonly roomCodeDetail: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly reconnectButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly feedback: HTMLParagraphElement;
  private readonly liveRegion: HTMLSpanElement;
  private readonly chevron: HTMLSpanElement;
  private room?: RoomView;
  private status: SyncStatus = "ready";
  private expanded = false;
  private busyAction?: "copy" | "reconnect" | "leave";
  private feedbackTimer?: number;

  private readonly handleOutsidePointer = (event: PointerEvent): void => {
    if (this.expanded && !event.composedPath().includes(this.host)) this.setExpanded(false);
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.expanded) return;
    this.setExpanded(false);
    this.badge.focus();
  };

  constructor(
    themeMode: ThemeMode,
    private readonly icons: StatusBadgeIconUrls,
    private readonly actions: StatusBadgeActions = {},
  ) {
    this.host = document.createElement("div");
    this.host.dataset.twoPersonVideoSync = "badge";
    this.host.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;";
    this.setThemeMode(themeMode);

    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        color-scheme: light dark;
        --surface: #ffffff;
        --surface-hover: #f3f3f3;
        --content-primary: #000000;
        --content-secondary: #545454;
        --border: #d6d6d6;
        --focus: #000000;
        --success: #16883a;
        --warning: #9a6700;
        --negative: #b91c2c;
        --shadow: 0 4px 18px rgb(0 0 0 / 18%);
      }

      :host([data-theme="dark"]) {
        color-scheme: dark;
        --surface: #111111;
        --surface-hover: #222222;
        --content-primary: #ffffff;
        --content-secondary: #b7b7b7;
        --border: #454545;
        --focus: #ffffff;
        --success: #44d765;
        --warning: #f6c75f;
        --negative: #ff8e9b;
        --shadow: 0 4px 22px rgb(0 0 0 / 42%);
      }

      :host([hidden]) { display: none !important; }

      * { box-sizing: border-box; }

      .shell {
        --status-color: var(--success);
        align-items: flex-end;
        color: var(--content-primary);
        display: flex;
        flex-direction: column;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        gap: 8px;
      }

      .shell[data-status="waiting"],
      .shell[data-status="correcting"],
      .shell[data-status="peer-buffering"],
      .shell[data-status="autoplay-blocked"],
      .shell[data-status="reconnecting"] { --status-color: var(--warning); }

      .shell[data-status="mismatch"],
      .shell[data-status="offline"],
      .shell[data-status="no-video"],
      .shell[data-status="disabled"] { --status-color: var(--negative); }

      .shell[data-status="ended"] { --status-color: var(--content-secondary); }

      button {
        appearance: none;
        color: inherit;
        cursor: pointer;
        font: inherit;
      }

      button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

      .badge {
        align-items: center;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 2px;
        box-shadow: var(--shadow);
        display: grid;
        gap: 9px;
        grid-template-columns: 9px minmax(0, 1fr) 16px;
        height: 38px;
        margin: 0;
        max-width: min(220px, calc(100vw - 32px));
        padding: 0 10px;
      }

      .badge:hover { background: var(--surface-hover); }

      .dot {
        background: var(--status-color);
        border-radius: 50%;
        display: block;
        height: 9px;
        width: 9px;
      }

      .title {
        color: var(--content-primary);
        display: block;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: -0.01em;
        line-height: 1;
        overflow: hidden;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .icon {
        background: currentColor;
        display: block;
        height: 18px;
        mask-position: center;
        mask-repeat: no-repeat;
        mask-size: contain;
        width: 18px;
        -webkit-mask-position: center;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-size: contain;
      }

      .chevron {
        color: var(--content-secondary);
        height: 16px;
        transition: transform 140ms ease;
        width: 16px;
      }

      .badge[aria-expanded="true"] .chevron { transform: rotate(180deg); }

      .menu {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 2px;
        box-shadow: var(--shadow);
        overflow: hidden;
        width: min(304px, calc(100vw - 32px));
      }

      .menu[hidden] { display: none; }

      .menu-header {
        align-items: center;
        border-bottom: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        min-height: 52px;
        padding: 9px 10px 9px 14px;
      }

      .brand { min-width: 0; }

      .eyebrow {
        color: var(--content-secondary);
        display: block;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.08em;
        line-height: 1.2;
        text-transform: uppercase;
      }

      .brand strong {
        display: block;
        font-size: 14px;
        line-height: 1.35;
        margin-top: 2px;
      }

      .icon-button {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 2px;
        color: var(--content-secondary);
        display: flex;
        height: 32px;
        justify-content: center;
        margin: 0;
        padding: 0;
        width: 32px;
      }

      .icon-button:hover { background: var(--surface-hover); color: var(--content-primary); }
      .icon-button .icon { height: 16px; width: 16px; }

      .current-status {
        align-items: start;
        display: grid;
        gap: 10px;
        grid-template-columns: 10px minmax(0, 1fr);
        padding: 12px 14px;
      }

      .current-status .dot { margin-top: 3px; }

      .expanded-title {
        color: var(--status-color);
        display: block;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.3;
      }

      .expanded-detail {
        color: var(--content-secondary);
        font-size: 11px;
        line-height: 1.45;
        margin: 3px 0 0;
        overflow-wrap: anywhere;
      }

      .expanded-detail[hidden] { display: none; }

      .metrics { border-top: 1px solid var(--border); }

      .metric {
        align-items: center;
        display: grid;
        gap: 10px;
        grid-template-columns: 20px minmax(0, 1fr) auto;
        min-height: 48px;
        padding: 8px 14px;
      }

      .metric + .metric { border-top: 1px solid var(--border); }
      .metric .icon { color: var(--content-primary); height: 18px; width: 18px; }

      .metric-label {
        color: var(--content-secondary);
        font-size: 11px;
        line-height: 1.3;
      }

      .metric-value {
        color: var(--content-primary);
        font-size: 11px;
        font-weight: 700;
        line-height: 1.3;
        text-align: right;
      }

      .metric-value[data-tone="good"] { color: var(--success); }
      .metric-value[data-tone="fair"] { color: var(--warning); }
      .metric-value[data-tone="poor"] { color: var(--negative); }

      .actions { border-top: 1px solid var(--border); padding: 5px 0; }

      .menu-action {
        align-items: center;
        background: transparent;
        border: 0;
        display: grid;
        gap: 11px;
        grid-template-columns: 20px minmax(0, 1fr);
        margin: 0;
        min-height: 50px;
        padding: 7px 14px;
        text-align: left;
        width: 100%;
      }

      .menu-action:hover:not(:disabled) { background: var(--surface-hover); }
      .menu-action:disabled { cursor: not-allowed; opacity: 0.42; }
      .menu-action .icon { height: 18px; width: 18px; }
      .action-copy { display: block; min-width: 0; }

      .action-copy strong {
        display: block;
        font-size: 12px;
        line-height: 1.35;
      }

      .action-detail {
        color: var(--content-secondary);
        display: block;
        font-size: 10px;
        line-height: 1.35;
        margin-top: 1px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .menu-action-danger { color: var(--negative); }
      .menu-action-danger .action-detail { color: var(--content-secondary); }

      .feedback {
        border-top: 1px solid var(--border);
        color: var(--success);
        font-size: 10px;
        line-height: 1.4;
        margin: 0;
        padding: 8px 14px;
      }

      .feedback[data-error="true"] { color: var(--negative); }
      .feedback[hidden] { display: none; }

      .sr-only {
        clip: rect(0, 0, 0, 0);
        clip-path: inset(50%);
        height: 1px;
        overflow: hidden;
        position: absolute;
        white-space: nowrap;
        width: 1px;
      }

      @media (prefers-color-scheme: dark) {
        :host(:not([data-theme])) {
          --surface: #111111;
          --surface-hover: #222222;
          --content-primary: #ffffff;
          --content-secondary: #b7b7b7;
          --border: #454545;
          --focus: #ffffff;
          --success: #44d765;
          --warning: #f6c75f;
          --negative: #ff8e9b;
          --shadow: 0 4px 22px rgb(0 0 0 / 42%);
        }
      }

      @media (prefers-reduced-motion: no-preference) {
        .shell[data-status="correcting"] .badge .dot,
        .shell[data-status="peer-buffering"] .badge .dot,
        .shell[data-status="reconnecting"] .badge .dot {
          animation: status-pulse 1.4s ease-in-out infinite;
        }
      }

      @keyframes status-pulse { 50% { opacity: 0.35; } }

      @media (max-width: 360px) {
        :host { right: 12px !important; bottom: 12px !important; }
        .menu { width: min(304px, calc(100vw - 24px)); }
        .badge { max-width: min(220px, calc(100vw - 24px)); }
      }
    `;

    const shell = document.createElement("div");
    shell.className = "shell";
    shell.dataset.status = this.status;

    this.menu = document.createElement("section");
    this.menu.className = "menu";
    this.menu.id = "two-person-video-sync-menu";
    this.menu.hidden = true;
    this.menu.setAttribute("role", "dialog");
    this.menu.setAttribute("aria-label", "Video Sync room controls");

    const menuHeader = document.createElement("div");
    menuHeader.className = "menu-header";
    const brand = document.createElement("div");
    brand.className = "brand";
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Video Sync";
    const heading = document.createElement("strong");
    heading.textContent = "Room controls";
    brand.append(eyebrow, heading);

    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.className = "icon-button hide-button";
    hideButton.title = "Hide Video Sync badge";
    hideButton.setAttribute("aria-label", "Hide Video Sync badge");
    hideButton.append(icon(this.icons.close));
    hideButton.addEventListener("click", () => this.hide());
    menuHeader.append(brand, hideButton);

    const currentStatus = document.createElement("div");
    currentStatus.className = "current-status";
    const expandedDot = document.createElement("span");
    expandedDot.className = "dot";
    expandedDot.setAttribute("aria-hidden", "true");
    const expandedCopy = document.createElement("div");
    this.expandedTitle = document.createElement("strong");
    this.expandedTitle.className = "expanded-title";
    this.expandedTitle.textContent = labels.ready;
    this.expandedDetail = document.createElement("p");
    this.expandedDetail.className = "expanded-detail";
    this.expandedDetail.hidden = true;
    expandedCopy.append(this.expandedTitle, this.expandedDetail);
    currentStatus.append(expandedDot, expandedCopy);

    const metrics = document.createElement("div");
    metrics.className = "metrics";
    const friendMetric = document.createElement("div");
    friendMetric.className = "metric friend-metric";
    this.friendIcon = icon(this.icons.userDisconnected);
    const friendLabel = document.createElement("span");
    friendLabel.className = "metric-label";
    friendLabel.textContent = "Friend";
    this.friendValue = document.createElement("strong");
    this.friendValue.className = "metric-value friend-value";
    this.friendValue.textContent = "Disconnected";
    friendMetric.append(this.friendIcon, friendLabel, this.friendValue);

    const qualityMetric = document.createElement("div");
    qualityMetric.className = "metric quality-metric";
    qualityMetric.append(icon(this.icons.wifi));
    const qualityLabel = document.createElement("span");
    qualityLabel.className = "metric-label";
    qualityLabel.textContent = "Sync quality";
    this.qualityValue = document.createElement("strong");
    this.qualityValue.className = "metric-value quality-value";
    this.qualityValue.textContent = "Unavailable";
    qualityMetric.append(qualityLabel, this.qualityValue);
    metrics.append(friendMetric, qualityMetric);

    const actionList = document.createElement("div");
    actionList.className = "actions";
    this.copyButton = actionButton(this.icons.copy, "Copy room code", "No active room", "copy");
    this.reconnectButton = actionButton(
      this.icons.reconnect,
      "Reconnect",
      "Restart this room connection",
      "reconnect",
    );
    this.leaveButton = actionButton(
      this.icons.leave,
      "Leave room",
      "Disconnect this browser",
      "leave",
    );
    this.roomCodeDetail = this.copyButton.querySelector<HTMLElement>(".action-detail")!;
    this.copyButton.addEventListener("click", () => void this.copyRoomCode());
    this.reconnectButton.addEventListener("click", () => void this.reconnect());
    this.leaveButton.addEventListener("click", () => void this.leaveRoom());
    actionList.append(this.copyButton, this.reconnectButton, this.leaveButton);

    this.feedback = document.createElement("p");
    this.feedback.className = "feedback";
    this.feedback.hidden = true;
    this.feedback.setAttribute("role", "status");

    this.menu.append(menuHeader, currentStatus, metrics, actionList, this.feedback);

    this.badge = document.createElement("button");
    this.badge.type = "button";
    this.badge.className = "badge badge-toggle";
    this.badge.dataset.status = this.status;
    this.badge.setAttribute("aria-expanded", "false");
    this.badge.setAttribute("aria-controls", this.menu.id);
    this.badge.setAttribute("aria-label", "Open Video Sync room controls. Ready to sync.");
    const badgeDot = document.createElement("span");
    badgeDot.className = "dot";
    badgeDot.setAttribute("aria-hidden", "true");
    this.title = document.createElement("strong");
    this.title.className = "title";
    this.title.textContent = compactLabels.ready;
    this.chevron = icon(this.icons.chevron, "icon chevron");
    this.badge.append(badgeDot, this.title, this.chevron);
    this.badge.addEventListener("click", () => this.setExpanded(!this.expanded));

    this.liveRegion = document.createElement("span");
    this.liveRegion.className = "sr-only";
    this.liveRegion.setAttribute("aria-live", "polite");
    this.liveRegion.setAttribute("aria-atomic", "true");

    shell.append(this.menu, this.badge, this.liveRegion);
    shadow.append(style, shell);
    document.documentElement.append(this.host);
    window.addEventListener("pointerdown", this.handleOutsidePointer, true);
    window.addEventListener("keydown", this.handleKeydown);
    this.refreshRoomDetails();
  }

  setThemeMode(mode: ThemeMode): void {
    if (mode === "system") {
      delete this.host.dataset.theme;
      return;
    }
    this.host.dataset.theme = mode;
  }

  update(status: SyncStatus, detail?: string, room?: RoomView): void {
    this.status = status;
    if (room !== undefined) this.room = room;
    const shell = this.menu.parentElement;
    if (shell) shell.dataset.status = status;
    this.badge.dataset.status = status;
    this.title.textContent = compactLabels[status];
    this.expandedTitle.textContent = labels[status];
    this.expandedDetail.textContent = detail ?? "";
    this.expandedDetail.hidden = !detail;
    this.badge.setAttribute(
      "aria-label",
      `${this.expanded ? "Close" : "Open"} Video Sync room controls. ${labels[status]}.`,
    );
    this.liveRegion.textContent = `${labels[status]}${detail ? `. ${detail}` : ""}`;
    this.refreshRoomDetails();
  }

  hide(): void {
    this.setExpanded(false);
    this.host.hidden = true;
  }

  show(): void {
    this.host.hidden = false;
  }

  destroy(): void {
    if (this.feedbackTimer) window.clearTimeout(this.feedbackTimer);
    window.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    window.removeEventListener("keydown", this.handleKeydown);
    this.host.remove();
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.host.dataset.expanded = String(expanded);
    this.menu.hidden = !expanded;
    this.badge.setAttribute("aria-expanded", String(expanded));
    this.badge.setAttribute(
      "aria-label",
      `${expanded ? "Close" : "Open"} Video Sync room controls. ${labels[this.status]}.`,
    );
  }

  private refreshRoomDetails(): void {
    const connected = this.room?.participantCount === 2;
    this.friendValue.textContent = connected ? "Connected" : "Disconnected";
    this.friendValue.dataset.tone = connected ? "good" : "neutral";
    const friendIconUrl = connected ? this.icons.userConnected : this.icons.userDisconnected;
    this.friendIcon.style.webkitMaskImage = `url("${friendIconUrl}")`;
    this.friendIcon.style.maskImage = `url("${friendIconUrl}")`;

    const quality = qualityForRoom(this.room);
    this.qualityValue.textContent = quality.label;
    this.qualityValue.dataset.tone = quality.tone;

    const roomCode = this.room?.roomCode;
    this.roomCodeDetail.textContent = roomCode ? formatRoomCode(roomCode) : "No active room";
    const activeRoom = Boolean(roomCode && this.room && this.room.participantCount > 0);
    this.copyButton.disabled =
      !roomCode || !this.actions.onCopyRoomCode || Boolean(this.busyAction);
    this.reconnectButton.disabled =
      !activeRoom || !this.actions.onReconnect || Boolean(this.busyAction);
    this.leaveButton.disabled =
      !activeRoom || !this.actions.onLeaveRoom || Boolean(this.busyAction);
  }

  private async copyRoomCode(): Promise<void> {
    const roomCode = this.room?.roomCode;
    if (!roomCode || !this.actions.onCopyRoomCode) return;
    await this.runAction("copy", () => this.actions.onCopyRoomCode!(roomCode), "Room code copied.");
  }

  private async reconnect(): Promise<void> {
    if (!this.actions.onReconnect) return;
    await this.runAction("reconnect", this.actions.onReconnect, "Reconnected.");
  }

  private async leaveRoom(): Promise<void> {
    if (!this.actions.onLeaveRoom) return;
    const endRoom = this.room?.role === "host";
    await this.runAction(
      "leave",
      () => this.actions.onLeaveRoom!(endRoom),
      endRoom ? "Room ended." : "You left the room.",
    );
  }

  private async runAction(
    action: "copy" | "reconnect" | "leave",
    callback: () => Promise<void> | void,
    successMessage: string,
  ): Promise<void> {
    if (this.busyAction) return;
    this.busyAction = action;
    this.refreshRoomDetails();
    this.showFeedback(
      action === "copy" ? "Copying…" : action === "reconnect" ? "Reconnecting…" : "Leaving…",
    );
    try {
      await callback();
      this.showFeedback(successMessage);
    } catch (error) {
      this.showFeedback(
        error instanceof Error ? error.message : "That action could not be completed.",
        true,
      );
    } finally {
      this.busyAction = undefined;
      this.refreshRoomDetails();
    }
  }

  private showFeedback(message: string, error = false): void {
    if (this.feedbackTimer) window.clearTimeout(this.feedbackTimer);
    this.feedback.textContent = message;
    this.feedback.dataset.error = String(error);
    this.feedback.hidden = false;
    this.feedbackTimer = window.setTimeout(() => {
      this.feedback.hidden = true;
      this.feedbackTimer = undefined;
    }, 2_400);
  }
}
