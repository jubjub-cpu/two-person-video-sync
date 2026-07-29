import type { SyncStatus } from "./types";

const labels: Record<SyncStatus, string> = {
  disabled: "Video Sync off",
  "no-video": "No video",
  ready: "Ready",
  waiting: "Waiting for peer",
  connected: "Connected",
  "in-sync": "In sync",
  correcting: "Correcting drift",
  "peer-buffering": "Peer buffering",
  mismatch: "Different video",
  "autoplay-blocked": "Click Ready",
  reconnecting: "Reconnecting",
  offline: "Offline",
  ended: "Ended",
};

export class StatusBadge {
  private readonly host: HTMLDivElement;
  private readonly label: HTMLSpanElement;

  constructor() {
    this.host = document.createElement("div");
    this.host.dataset.twoPersonVideoSync = "badge";
    this.host.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;";
    const shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: light dark; }
      .badge { align-items:center;background:#10162aee;border:1px solid #ffffff26;border-radius:999px;
        box-shadow:0 6px 24px #0005;color:#fff;display:flex;font:600 12px/1.2 system-ui,sans-serif;
        gap:8px;max-width:220px;padding:8px 9px 8px 11px; }
      .dot { background:#8b96ae;border-radius:50%;height:8px;width:8px; }
      .badge[data-status="in-sync"] .dot,.badge[data-status="connected"] .dot { background:#43d6b5; }
      .badge[data-status="waiting"] .dot,.badge[data-status="correcting"] .dot { background:#f7c95c; }
      .badge[data-status="mismatch"] .dot,.badge[data-status="offline"] .dot { background:#ff6b7a; }
      button { appearance:none;background:transparent;border:0;border-radius:50%;color:#cbd4e8;cursor:pointer;
        font:700 15px/1 system-ui;height:22px;margin-left:2px;padding:0;width:22px; }
      button:hover,button:focus-visible { background:#ffffff1a;outline:2px solid #70e1d1;outline-offset:1px; }
    `;
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.dataset.status = "ready";
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-live", "polite");
    const dot = document.createElement("span");
    dot.className = "dot";
    this.label = document.createElement("span");
    this.label.textContent = labels.ready;
    const close = document.createElement("button");
    close.type = "button";
    close.title = "Hide video sync badge";
    close.setAttribute("aria-label", "Hide video sync badge");
    close.textContent = "×";
    close.addEventListener("click", () => this.hide());
    badge.append(dot, this.label, close);
    shadow.append(style, badge);
    document.documentElement.append(this.host);
  }

  update(status: SyncStatus, detail?: string): void {
    const badge = this.label.parentElement;
    if (badge) badge.dataset.status = status;
    this.label.textContent = detail ? `${labels[status]} · ${detail}` : labels[status];
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
