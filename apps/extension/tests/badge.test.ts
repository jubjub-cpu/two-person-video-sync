import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusBadge, type StatusBadgeIconUrls } from "../lib/badge";
import type { RoomView } from "../lib/types";

const icons: StatusBadgeIconUrls = {
  chevron: "/icons/ui/chevron-down.svg",
  close: "/icons/ui/x.svg",
  copy: "/icons/ui/copy.svg",
  leave: "/icons/ui/logout.svg",
  reconnect: "/icons/ui/refresh.svg",
  transfer: "/icons/ui/users.svg",
  userConnected: "/icons/ui/user-check.svg",
  userDisconnected: "/icons/ui/user-x.svg",
  wifi: "/icons/ui/wifi.svg",
};

const connectedRoom: RoomView = {
  roomCode: "23456789ABCDEFGH",
  role: "host",
  participantCount: 2,
  controlMode: "host-only",
  status: "in-sync",
  message: "Playback is synchronized.",
  latencyMs: 84,
  driftMs: 35,
};

async function settleAction(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("in-page status badge", () => {
  afterEach(() => {
    document.querySelectorAll("[data-vyzync='badge']").forEach((element) => {
      element.remove();
    });
  });

  it("stays compact by default and expands with live room details", () => {
    const badge = new StatusBadge("dark", icons);
    const host = document.querySelector<HTMLElement>("[data-vyzync='badge']");
    const shadow = host?.shadowRoot;
    const toggle = shadow?.querySelector<HTMLButtonElement>(".badge-toggle");
    const menu = shadow?.querySelector<HTMLElement>(".menu");

    badge.update("in-sync", "Playback is synchronized.", connectedRoom);

    expect(host?.dataset.theme).toBe("dark");
    expect(toggle?.getAttribute("data-status")).toBe("in-sync");
    expect(shadow?.querySelector(".title")?.textContent).toBe("In sync");
    expect(menu?.hidden).toBe(true);

    toggle?.click();

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(menu?.hidden).toBe(false);
    expect(menu?.textContent).not.toContain("Vyzync");
    expect(menu?.textContent).not.toContain("Room controls");
    expect(shadow?.querySelector(".expanded-detail")?.textContent).toBe(
      "Playback is synchronized.",
    );
    expect(shadow?.querySelector(".friend-value")?.textContent).toBe("Connected");
    expect(shadow?.querySelector(".quality-value")?.textContent).toBe("Good · 84 ms");
    expect(shadow?.querySelector("[data-action='copy'] .action-detail")?.textContent).toBe(
      "2345 6789 ABCD EFGH",
    );

    badge.setThemeMode("system");
    expect(host?.hasAttribute("data-theme")).toBe(false);
  });

  it("runs copy, host transfer, reconnect, and leave through the supplied room actions", async () => {
    const onCopyRoomCode = vi.fn().mockResolvedValue(undefined);
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    const onTransferHost = vi.fn().mockResolvedValue(undefined);
    const onLeaveRoom = vi.fn().mockResolvedValue(undefined);
    const badge = new StatusBadge("light", icons, {
      onCopyRoomCode,
      onReconnect,
      onTransferHost,
      onLeaveRoom,
    });
    badge.update("connected", "Connected to friend.", connectedRoom);

    const shadow = document.querySelector<HTMLElement>("[data-vyzync='badge']")?.shadowRoot;
    shadow?.querySelector<HTMLButtonElement>(".badge-toggle")?.click();

    shadow?.querySelector<HTMLButtonElement>("[data-action='copy']")?.click();
    await settleAction();
    expect(onCopyRoomCode).toHaveBeenCalledWith("23456789ABCDEFGH");
    expect(shadow?.querySelector(".feedback")?.textContent).toBe("Room code copied.");

    shadow?.querySelector<HTMLButtonElement>("[data-action='transfer']")?.click();
    await settleAction();
    expect(onTransferHost).toHaveBeenCalledOnce();
    expect(shadow?.querySelector(".feedback")?.textContent).toBe("Host passed.");

    shadow?.querySelector<HTMLButtonElement>("[data-action='reconnect']")?.click();
    await settleAction();
    expect(onReconnect).toHaveBeenCalledOnce();

    shadow?.querySelector<HTMLButtonElement>("[data-action='leave']")?.click();
    await settleAction();
    expect(onLeaveRoom).toHaveBeenCalledWith(true);
  });

  it("shows host transfer only to a connected host", () => {
    const badge = new StatusBadge("light", icons, { onTransferHost: vi.fn() });
    const transfer = document
      .querySelector<HTMLElement>("[data-vyzync='badge']")
      ?.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='transfer']");

    badge.update("waiting", "Waiting.", { ...connectedRoom, participantCount: 1 });
    expect(transfer?.hidden).toBe(true);

    badge.update("connected", "Connected.", connectedRoom);
    expect(transfer?.hidden).toBe(false);
    expect(transfer?.disabled).toBe(false);

    badge.update("connected", "Connected.", { ...connectedRoom, role: "guest" });
    expect(transfer?.hidden).toBe(true);
  });

  it("can be dismissed without removing the controller", () => {
    new StatusBadge("light", icons);
    const host = document.querySelector<HTMLElement>("[data-vyzync='badge']");
    const shadow = host?.shadowRoot;

    shadow?.querySelector<HTMLButtonElement>(".badge-toggle")?.click();
    shadow?.querySelector<HTMLButtonElement>(".hide-button")?.click();

    expect(host?.hidden).toBe(true);
  });
});
