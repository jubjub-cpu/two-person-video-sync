import { afterEach, describe, expect, it } from "vitest";

import { StatusBadge } from "../lib/badge";

describe("in-page status badge", () => {
  afterEach(() => {
    document.querySelectorAll("[data-two-person-video-sync='badge']").forEach((element) => {
      element.remove();
    });
  });

  it("uses the selected theme and renders status details", () => {
    const badge = new StatusBadge("dark", "/icons/ui/x.svg");
    const host = document.querySelector<HTMLElement>("[data-two-person-video-sync='badge']");
    const shadow = host?.shadowRoot;

    badge.update("reconnecting", "Starting the synchronization service.");

    expect(host?.dataset.theme).toBe("dark");
    expect(shadow?.querySelector(".badge")?.getAttribute("data-status")).toBe("reconnecting");
    expect(shadow?.querySelector(".title")?.textContent).toBe("Reconnecting");
    expect(shadow?.querySelector(".detail")?.textContent).toBe(
      "Starting the synchronization service.",
    );

    badge.setThemeMode("system");
    expect(host?.hasAttribute("data-theme")).toBe(false);
  });

  it("can be dismissed without removing the controller", () => {
    new StatusBadge("light", "/icons/ui/x.svg");
    const host = document.querySelector<HTMLElement>("[data-two-person-video-sync='badge']");
    const close = host?.shadowRoot?.querySelector<HTMLButtonElement>("button");

    close?.click();

    expect(host?.hidden).toBe(true);
  });
});
