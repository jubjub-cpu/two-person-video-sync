import { beforeEach, describe, expect, it } from "vitest";

import { applyThemeMode } from "../lib/theme";

describe("appearance", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  });

  it.each(["light", "dark"] as const)("applies the explicit %s theme", (mode) => {
    applyThemeMode(mode);

    expect(document.documentElement.dataset.theme).toBe(mode);
    expect(document.documentElement.style.colorScheme).toBe(mode);
  });

  it("returns to operating-system appearance", () => {
    applyThemeMode("dark");
    applyThemeMode("system");

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light dark");
  });
});
