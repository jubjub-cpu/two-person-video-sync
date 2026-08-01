import type { SyncStatus, ThemeMode } from "./types";

const labels: Record<SyncStatus, string> = {
  disabled: "Video Sync off",
  "no-video": "No supported video found",
  ready: "Ready to sync",
  waiting: "Waiting for the other person",
  connected: "Connected to peer",
  "in-sync": "In sync",
  correcting: "Correcting drift",
  "peer-buffering": "The other person is buffering",
  mismatch: "Different videos detected",
  "autoplay-blocked": "One click needed",
  reconnecting: "Reconnecting",
  offline: "Sync service unavailable",
  ended: "Video ended",
};

export class StatusBadge {
  private readonly host: HTMLDivElement;
  private readonly badge: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLParagraphElement;

  constructor(themeMode: ThemeMode, closeIconUrl: string) {
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
        --success-surface: #ffffff;
        --warning: #9a6700;
        --warning-surface: #fff8e6;
        --negative: #b91c2c;
        --negative-surface: #fff3f4;
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
        --success-surface: #102319;
        --warning: #f6c75f;
        --warning-surface: #2a2414;
        --negative: #ff8e9b;
        --negative-surface: #2f171b;
      }

      * { box-sizing: border-box; }

      .badge {
        --status-color: var(--success);
        --status-surface: var(--success-surface);
        align-items: start;
        background: var(--status-surface);
        border: 1px solid var(--border);
        border-radius: 2px;
        box-shadow: 0 3px 14px rgb(0 0 0 / 18%);
        color: var(--content-primary);
        display: grid;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        gap: 10px;
        grid-template-columns: 10px minmax(0, 1fr) 28px;
        max-width: min(320px, calc(100vw - 32px));
        min-width: 224px;
        padding: 11px 8px 11px 12px;
      }

      .badge[data-status="waiting"],
      .badge[data-status="correcting"],
      .badge[data-status="peer-buffering"],
      .badge[data-status="autoplay-blocked"],
      .badge[data-status="reconnecting"] {
        --status-color: var(--warning);
        --status-surface: var(--warning-surface);
      }

      .badge[data-status="mismatch"],
      .badge[data-status="offline"],
      .badge[data-status="no-video"],
      .badge[data-status="disabled"] {
        --status-color: var(--negative);
        --status-surface: var(--negative-surface);
      }

      .badge[data-status="ended"] {
        --status-color: var(--content-secondary);
        --status-surface: var(--surface);
      }

      .dot {
        background: var(--status-color);
        border-radius: 50%;
        height: 10px;
        margin-top: 3px;
        width: 10px;
      }

      .copy { min-width: 0; }

      .title {
        color: var(--status-color);
        display: block;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: -0.01em;
        line-height: 1.25;
      }

      .detail {
        color: var(--content-secondary);
        font-size: 11px;
        line-height: 1.4;
        margin: 3px 0 0;
        overflow-wrap: anywhere;
      }

      .detail[hidden] { display: none; }

      button {
        align-items: center;
        appearance: none;
        background: transparent;
        border: 0;
        border-radius: 2px;
        color: var(--content-secondary);
        cursor: pointer;
        display: flex;
        height: 28px;
        justify-content: center;
        margin: -5px -1px 0 0;
        padding: 0;
        width: 28px;
      }

      button:hover { background: var(--surface-hover); color: var(--content-primary); }
      button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

      .close-icon {
        background: currentColor;
        display: block;
        height: 16px;
        mask-position: center;
        mask-repeat: no-repeat;
        mask-size: contain;
        width: 16px;
        -webkit-mask-position: center;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-size: contain;
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
          --success-surface: #102319;
          --warning: #f6c75f;
          --warning-surface: #2a2414;
          --negative: #ff8e9b;
          --negative-surface: #2f171b;
        }
      }

      @media (prefers-reduced-motion: no-preference) {
        .badge[data-status="correcting"] .dot,
        .badge[data-status="peer-buffering"] .dot,
        .badge[data-status="reconnecting"] .dot {
          animation: status-pulse 1.4s ease-in-out infinite;
        }
      }

      @keyframes status-pulse {
        50% { opacity: 0.35; }
      }

      @media (max-width: 360px) {
        .badge { min-width: 0; }
        :host { right: 12px !important; bottom: 12px !important; }
      }
    `;

    this.badge = document.createElement("div");
    this.badge.className = "badge";
    this.badge.dataset.status = "ready";
    this.badge.setAttribute("role", "status");
    this.badge.setAttribute("aria-live", "polite");
    this.badge.setAttribute("aria-atomic", "true");

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "copy";
    this.title = document.createElement("strong");
    this.title.className = "title";
    this.title.textContent = labels.ready;
    this.detail = document.createElement("p");
    this.detail.className = "detail";
    this.detail.hidden = true;
    copy.append(this.title, this.detail);

    const close = document.createElement("button");
    close.type = "button";
    close.title = "Hide Video Sync status";
    close.setAttribute("aria-label", "Hide Video Sync status");
    const closeIcon = document.createElement("span");
    closeIcon.className = "close-icon";
    closeIcon.setAttribute("aria-hidden", "true");
    closeIcon.style.webkitMaskImage = `url("${closeIconUrl}")`;
    closeIcon.style.maskImage = `url("${closeIconUrl}")`;
    close.append(closeIcon);
    close.addEventListener("click", () => this.hide());

    this.badge.append(dot, copy, close);
    shadow.append(style, this.badge);
    document.documentElement.append(this.host);
  }

  setThemeMode(mode: ThemeMode): void {
    if (mode === "system") {
      delete this.host.dataset.theme;
      return;
    }
    this.host.dataset.theme = mode;
  }

  update(status: SyncStatus, detail?: string): void {
    this.badge.dataset.status = status;
    this.title.textContent = labels[status];
    this.detail.textContent = detail ?? "";
    this.detail.hidden = !detail;
  }

  hide(): void {
    this.host.hidden = true;
  }

  show(): void {
    this.host.hidden = false;
  }

  destroy(): void {
    this.host.remove();
  }
}
